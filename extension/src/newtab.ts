import { wx, type WxBookmarkNode } from './wx.js';
import { nativeRootId, resolveRoots } from './local.js';
import { KEYS } from './storage.js';
import { DEFAULT_SETTINGS, type Settings } from './types.js';

// ============================================================
// Strona nowej karty — dostawa 3.0 (proba przegladarek).
//
// Celowo bez silnika synchronizacji i bez wiadomosci do tla: worker MV3
// moze spac, a karta ma sie pokazac natychmiast i offline. Czyta tylko
// ustawienia z pamieci rozszerzenia i zakladki przez API przegladarki.
// Na razie kafelki z paska zakladek; sekcje z wybranych folderow
// i logo z serwera przychodza w dostawie 3.1.
// ============================================================

const $ = (id: string) => document.getElementById(id)!;

// Kolory awatarow kafelkow bez ikon — stale dla danej domeny, zeby kafelek
// zawsze wygladal tak samo (ikony stron dochodza w kolejnej dostawie)
const AVATAR_COLORS = ['#2f9e5b', '#1f7ae0', '#e0731f', '#8a4fd6', '#d6455a', '#1b9aa8', '#b08a1a', '#5b6b84'];

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function colorFor(text: string): string {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function letterFor(title: string, url?: string): string {
  const source = (title || (url ? hostOf(url) : '') || '?').trim();
  return (source.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
}

// ---- kafelki ----

const trail: { id: string; title: string }[] = [];

function tile(node: WxBookmarkNode): HTMLElement {
  const isFolder = node.url === undefined;
  const el = document.createElement(isFolder ? 'button' : 'a');
  el.className = 'tile' + (isFolder ? ' folder' : '');
  el.title = isFolder ? node.title : `${node.title}\n${node.url}`;

  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  if (isFolder) {
    avatar.textContent = '📁';
  } else {
    avatar.textContent = letterFor(node.title, node.url);
    avatar.style.background = colorFor(hostOf(node.url!));
  }
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = node.title || (node.url ? hostOf(node.url) : '(bez nazwy)');
  el.append(avatar, label);

  if (isFolder) {
    el.addEventListener('click', () => { trail.push({ id: node.id, title: node.title }); void render(); });
  } else {
    (el as HTMLAnchorElement).href = node.url!;
  }
  return el;
}

async function render(): Promise<void> {
  await resolveRoots();
  const rootId = nativeRootId('root:toolbar')!;
  const current = trail.at(-1);
  let children: WxBookmarkNode[] = [];
  try { children = await wx.bookmarks.getChildren(current?.id ?? rootId); }
  catch { trail.length = 0; children = await wx.bookmarks.getChildren(rootId); }

  // Separatory (Firefox) i wpisy bez adresu http(s) nie maja sensu jako kafelki
  const items = children.filter(c => c.type !== 'separator' &&
    (c.url === undefined || /^https?:/i.test(c.url)));

  const crumbs = $('crumbs');
  crumbs.replaceChildren();
  if (current) {
    const back = document.createElement('button');
    back.className = 'linkish';
    back.textContent = '← Wróć';
    back.addEventListener('click', () => { trail.pop(); void render(); });
    const where = document.createElement('span');
    where.className = 'muted';
    where.textContent = ['Pasek zakładek', ...trail.map(t => t.title)].join(' › ');
    crumbs.append(back, where);
  }

  const grid = $('tiles');
  grid.replaceChildren(...items.map(tile));
  ($('empty') as HTMLElement).hidden = items.length > 0;
}

// ---- wyszukiwarka: lokalne podpowiedzi z zakladek, siec dopiero po Enter ----

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function looksLikeUrl(text: string): boolean {
  return /^[a-z]+:\/\//i.test(text) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text);
}

async function suggest(query: string): Promise<void> {
  const box = $('suggestions');
  box.replaceChildren();
  if (query.trim().length < 2) { box.hidden = true; return; }
  const found = (await wx.bookmarks.search(query)).filter(n => n.url && /^https?:/i.test(n.url)).slice(0, 8);
  for (const node of found) {
    const a = document.createElement('a');
    a.href = node.url!;
    a.className = 'suggestion';
    const t = document.createElement('span');
    t.textContent = node.title || hostOf(node.url!);
    const u = document.createElement('span');
    u.className = 'muted';
    u.textContent = hostOf(node.url!);
    a.append(t, u);
    box.append(a);
  }
  box.hidden = found.length === 0;
}

function wireSearch(): void {
  const input = $('search') as HTMLInputElement;
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void suggest(input.value), 120);
  });
  $('search-form').addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const first = document.querySelector<HTMLAnchorElement>('#suggestions a');
    if (first && !($('suggestions') as HTMLElement).hidden && first.textContent?.toLowerCase().includes(q.toLowerCase())) {
      location.href = first.href; return;
    }
    location.href = looksLikeUrl(q)
      ? (/^[a-z]+:\/\//i.test(q) ? q : `https://${q}`)
      : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  });
}

// ---- start ----

void (async () => {
  const stored = (await wx.storage.local.get(KEYS.settings))[KEYS.settings] as Partial<Settings> | undefined;
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  // Kafelki wylaczone: lekka, pusta karta. Przegladarki nie pozwalaja wtyczce
  // wrocic do wlasnej nowej karty (Firefox wprost to blokuje), wiec nie probujemy.
  if (!settings.startPage) {
    document.body.classList.add('blank');
    $('show-anyway').addEventListener('click', () => {
      document.body.classList.remove('blank');
      wireSearch();
      void render();
    });
    return;
  }

  wireSearch();
  await render();
  // Zmiana zakladek w innej karcie albo z synchronizacji — odswiezamy widok
  for (const ev of [wx.bookmarks.onCreated, wx.bookmarks.onRemoved, wx.bookmarks.onChanged, wx.bookmarks.onMoved]) {
    ev.addListener(() => void render());
  }
})();

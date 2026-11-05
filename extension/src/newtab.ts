import { wx, type WxBookmarkNode } from './wx.js';
import { nativeRootId, resolveRoots } from './local.js';
import { KEYS } from './storage.js';
import { DEFAULT_SETTINGS, type Settings } from './types.js';
import {
  asAddress, engineById, googleSuggestUrl, mergeSuggestions, normalizePinned, parseGoogleSuggest, searchUrl,
  DEFAULT_ENGINE, type BookmarkHit, type SearchEngine, type Suggestion,
} from './core/search.js';

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

// ---- wyszukiwarka ----
//
// Enter zawsze szuka wpisanego tekstu (albo otwiera go jako adres) — nigdy nie
// otwiera sam z siebie pierwszej podpowiedzi. Podpowiedz wybiera sie strzalkami.
// Zakladki i Google to osobne opcje; Google tylko po zgodzie, bez cookies.

let settings: Settings = DEFAULT_SETTINGS;
let suggestions: Suggestion[] = [];
let selectedKey: string | null = null;
let requestNo = 0;
let webAbort: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const input = () => $('search') as HTMLInputElement;
const box = () => $('suggestions') as HTMLElement;

function engine(id: string): SearchEngine {
  return engineById(id) ?? engineById(DEFAULT_ENGINE)!;
}

function go(url: string): void { location.href = url; }

function runSearch(engineId: string, allowAddress: boolean): void {
  const q = input().value.trim();
  if (!q) { input().focus(); return; }
  const address = allowAddress && settings.enterOpensAddress ? asAddress(q) : null;
  go(address ?? searchUrl(engine(engineId), q));
}

function renderSuggestions(): void {
  const list = box();
  list.replaceChildren();
  for (const s of suggestions) {
    const row = document.createElement('div');
    row.className = 'suggestion' + (s.key === selectedKey ? ' active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(s.key === selectedKey));
    const main = document.createElement('span');
    const side = document.createElement('span');
    side.className = 'muted';
    if (s.kind === 'bookmark') {
      main.textContent = '★ ' + (s.title || hostOf(s.url));
      side.textContent = hostOf(s.url);
    } else {
      main.textContent = s.text;
      side.textContent = 'Google';
    }
    row.append(main, side);
    // mousedown zamiast click: pole nie traci fokusu przed wyborem
    row.addEventListener('mousedown', e => { e.preventDefault(); choose(s); });
    list.append(row);
  }
  list.hidden = suggestions.length === 0;
  input().setAttribute('aria-expanded', String(!list.hidden));
}

function choose(s: Suggestion): void {
  if (s.kind === 'bookmark') { go(s.url); return; }
  input().value = s.text;
  go(searchUrl(engine(settings.defaultEngine), s.text));
}

function closeSuggestions(): void {
  suggestions = []; selectedKey = null; renderSuggestions();
}

async function bookmarkHits(q: string): Promise<BookmarkHit[]> {
  if (!settings.searchBookmarks) return [];
  try {
    return (await wx.bookmarks.search(q)).filter(n => n.url && /^https?:/i.test(n.url))
      .slice(0, 6).map(n => ({ title: n.title, url: n.url! }));
  } catch { return []; }
}

async function webHits(q: string): Promise<string[]> {
  if (!settings.googleSuggest || engine(settings.defaultEngine).suggest !== 'google') return [];
  if (!navigator.onLine) return [];
  webAbort?.abort();
  const ctrl = new AbortController();
  webAbort = ctrl;
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(googleSuggestUrl(q), { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
    return r.ok ? parseGoogleSuggest(await r.json()) : [];
  } catch { return []; }   // offline, brak zgody, przerwane — po prostu bez podpowiedzi
  finally { clearTimeout(timer); }
}

async function refreshSuggestions(): Promise<void> {
  const q = input().value.trim();
  const no = ++requestNo;
  if (q.length < 2) { closeSuggestions(); return; }
  // Zakladki od razu, Google dociaga sie pozniej — zaznaczenie trzymamy po kluczu, nie po pozycji
  const marks = await bookmarkHits(q);
  if (no !== requestNo) return;
  suggestions = mergeSuggestions(q, marks, []);
  if (!suggestions.some(s => s.key === selectedKey)) selectedKey = null;
  renderSuggestions();
  const web = await webHits(q);
  if (no !== requestNo || input().value.trim() !== q) return;
  suggestions = mergeSuggestions(q, marks, web);
  if (!suggestions.some(s => s.key === selectedKey)) selectedKey = null;
  renderSuggestions();
}

function moveSelection(step: number): void {
  if (suggestions.length === 0) return;
  const i = suggestions.findIndex(s => s.key === selectedKey);
  const next = i === -1 ? (step > 0 ? 0 : suggestions.length - 1) : i + step;
  selectedKey = next < 0 || next >= suggestions.length ? null : suggestions[next].key;
  renderSuggestions();
}

function renderEngines(): void {
  const bar = $('engines');
  bar.replaceChildren();
  for (const id of normalizePinned(settings.pinnedEngines)) {
    const e = engine(id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'engine' + (e.id === settings.defaultEngine ? ' primary' : '');
    const dot = document.createElement('span');
    dot.className = 'engine-dot';
    dot.style.background = e.color;
    b.append(dot, document.createTextNode(e.name));
    // Przycisk zawsze szuka tekstu pola, niezaleznie od zaznaczonej podpowiedzi
    b.addEventListener('click', () => runSearch(e.id, false));
    bar.append(b);
  }
  bar.hidden = bar.childElementCount === 0;
}

function wireSearch(): void {
  const field = input();
  const name = engine(settings.defaultEngine).name;
  field.placeholder = settings.searchBookmarks ? `Szukaj w ${name} lub w zakładkach` : `Szukaj w ${name}`;
  field.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void refreshSuggestions(), 250);
  });
  field.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Escape') { closeSuggestions(); }
  });
  field.addEventListener('blur', () => setTimeout(closeSuggestions, 150));
  $('search-form').addEventListener('submit', e => {
    e.preventDefault();
    const chosen = suggestions.find(s => s.key === selectedKey);
    if (chosen) { choose(chosen); return; }
    runSearch(settings.defaultEngine, true);
  });
  renderEngines();
}

// ---- start ----

void (async () => {
  const stored = (await wx.storage.local.get(KEYS.settings))[KEYS.settings] as Partial<Settings> | undefined;
  settings = { ...DEFAULT_SETTINGS, ...stored };

  // ?view=start — adres wklejony jako strona startowa przegladarki (albo przekierowanie
  // Opery): kafelki zawsze, niezaleznie od przelacznika nowej karty
  const forced = new URLSearchParams(location.search).get('view') === 'start';

  // Kafelki wylaczone: lekka, pusta karta. Przegladarki nie pozwalaja wtyczce
  // wrocic do wlasnej nowej karty (Firefox wprost to blokuje), wiec nie probujemy.
  if (!settings.startPage && !forced) {
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

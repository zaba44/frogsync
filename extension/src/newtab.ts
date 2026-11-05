import { wx, isGecko, type WxBookmarkNode } from './wx.js';
import { nativeRootId, resolveRoots } from './local.js';
import { KEYS, getLocal } from './storage.js';
import { DEFAULT_SETTINGS, type Settings, type Message } from './types.js';
import {
  readStartPage, safeImage, STARTPAGE_CACHE, STARTPAGE_MAP, type StartPageCache,
} from './startpage-cache.js';
import { localTopSites } from './startpage-edit.js';
import {
  customBlocks, moveBefore, mayFocusSearch, TEMPLATES,
  type StartBlock, type FolderBlock, type CustomDraft, type CustomSaveReply,
  type StartPageSnapshot, type StartBookmarkEdit,
} from './core/startpage.js';
import {
  asAddress, engineById, googleSuggestUrl, mergeSuggestions, normalizePinned,
  parseGoogleSuggest, searchUrl, BUILTIN_ENGINES, DEFAULT_ENGINE,
  type BookmarkHit, type SearchEngine, type Suggestion,
} from './core/search.js';

const $ = (id: string) => document.getElementById(id)!;
const started = performance.now();
let interacted = false, focusAttempted = false, active = false, manualShow = false;
document.addEventListener('keydown', () => { interacted = true; }, { capture: true, once: true });
document.addEventListener('pointerdown', () => { interacted = true; }, { capture: true, once: true });

let settings: Settings = DEFAULT_SETTINGS;
let page: { cache: StartPageCache | null; map: Record<string, string> } = { cache: null, map: {} };
let readNo = 0, renderNo = 0, editing = false, busy = false, faviconAllowed = false;
let changedTimer: ReturnType<typeof setTimeout> | undefined;
const paths = new Map<string, { id: string; title: string }[]>();

async function send<T>(message: Message): Promise<T> {
  const result = await wx.runtime.sendMessage(message);
  if (result && typeof result === 'object' && 'error' in result)
    throw new Error(String(result.error));
  return result as T;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function status(text: string): void { $('page-message').textContent = text; }
function catalog(): readonly SearchEngine[] {
  return page.cache?.snapshot.configuration.engines.length
    ? page.cache.snapshot.configuration.engines : BUILTIN_ENGINES;
}
function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
function letterFor(title: string, url = ''): string {
  return ((title || hostOf(url)).match(/[\p{L}\p{N}]/u)?.[0] || '?').toUpperCase();
}
function colorFor(text: string): string {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return ['#2f9e5b', '#1f7ae0', '#e0731f', '#8a4fd6', '#d6455a', '#1b9aa8'][n % 6];
}
function button(text: string, action: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button'; node.textContent = text;
  node.addEventListener('click', action);
  return node;
}
function note(text: string): HTMLElement {
  const node = document.createElement('p');
  node.className = 'muted'; node.textContent = text;
  return node;
}
function initialFocus(): void {
  if (focusAttempted) return;
  focusAttempted = true;
  const current = document.activeElement;
  if (current && current !== document.body &&
      current !== document.documentElement && current !== input()) return;
  if (mayFocusSearch(
    settings.focusSearch, interacted, performance.now() - started,
    document.visibilityState === 'visible', current?.tagName ?? 'BODY',
  )) input().focus({ preventScroll: true });
}
function appearance(): void {
  const selected = settings.templateOverride === 'profile'
    ? page.cache?.snapshot.configuration.template ?? 'classic'
    : settings.templateOverride;
  const template = TEMPLATES.includes(selected) ? selected : 'classic';
  document.documentElement.dataset.template = template;
  for (const name of TEMPLATES)
    document.body.classList.toggle('template-' + name, name === template);
  try {
    localStorage.setItem('frogsync-start-view', JSON.stringify({
      template, startPage: settings.startPage,
    }));
  } catch { /* Tryb prywatny. */ }
  const background = $('glass-background') as HTMLImageElement;
  const source = safeImage(page.cache?.background?.dataUrl);
  background.hidden = template !== 'glass' || !source;
  if (source) background.src = source;
  else background.removeAttribute('src');
  const logo = $('logo') as HTMLImageElement;
  const logoSource = safeImage(page.cache?.logo?.dataUrl) || 'icons/icon128.png';
  if (logo.getAttribute('src') !== logoSource) logo.src = logoSource;
}
function logoColors(): void {
  const logo = $('logo') as HTMLImageElement;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return;
    context.drawImage(logo, 0, 0, 16, 16);
    const rgba = context.getImageData(0, 0, 16, 16).data;
    const colors = new Map<string, { n: number; r: number; g: number; b: number }>();
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] < 128 || Math.min(rgba[i], rgba[i + 1], rgba[i + 2]) > 240) continue;
      const key = [rgba[i] >> 5, rgba[i + 1] >> 5, rgba[i + 2] >> 5].join();
      const c = colors.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      c.n++; c.r += rgba[i]; c.g += rgba[i + 1]; c.b += rgba[i + 2];
      colors.set(key, c);
    }
    const chosen = [...colors.values()].sort((a, b) => b.n - a.n).slice(0, 2);
    chosen.forEach((c, i) =>
      document.documentElement.style.setProperty('--live-' + (i ? 'b' : 'a'),
        'rgb(' + [c.r, c.g, c.b].map(x => Math.round(x / c.n)).join(',') + ')'));
  } catch { /* Barwy FrogSync sa zdefiniowane w CSS. */ }
}

interface TileSource {
  id: string;
  title: string;
  url?: string;
  color?: string | null;
  kind: 'bookmark' | 'custom' | 'top';
  blockId: string;
  parentId?: string;
  node?: WxBookmarkNode;
  order: string[];
  open?: () => void;
}
let dragged: TileSource | null = null;

function tile(source: TileSource): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'tile-shell';
  const folder = source.url === undefined;
  const link = document.createElement(folder ? 'button' : 'a');
  link.className = 'tile' + (folder ? ' folder' : '');
  if (link instanceof HTMLButtonElement) link.type = 'button';
  else (link as HTMLAnchorElement).href = source.url!;
  link.title = source.title + (source.url ? '\n' + source.url : '');
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = folder ? '▣' : letterFor(source.title, source.url);
  if (!folder) avatar.style.background = source.color || colorFor(hostOf(source.url!));
  if (!folder && faviconAllowed) {
    const image = document.createElement('img');
    image.alt = ''; image.draggable = false; image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => avatar.classList.add('has-favicon'));
    image.addEventListener('error', () => {
      avatar.classList.remove('has-favicon'); image.remove();
    });
    image.src = wx.runtime.getURL('_favicon/') +
      '?pageUrl=' + encodeURIComponent(source.url!) + '&size=64';
    avatar.append(image);
  }
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = source.title ||
    (source.url ? hostOf(source.url) : '(bez nazwy)');
  link.append(avatar, label);
  link.addEventListener('click', event => {
    if (folder) { source.open?.(); return; }
    if (editing && source.kind !== 'top') {
      event.preventDefault(); openTileEditor(source);
    }
  });
  wrapper.append(link);
  if (editing && source.kind !== 'top') {
    const actions = document.createElement('div');
    actions.className = 'tile-actions';
    actions.append(
      button('Edytuj', () => openTileEditor(source)),
      button('Usuń', () => { void deleteTile(source); }),
    );
    const index = source.order.indexOf(source.id);
    const up = button('←', () => {
      if (index > 0) void moveTile(source, source.order[index - 1]);
    });
    const down = button('→', () => {
      if (index < source.order.length - 1)
        void moveTile(source, source.order[index + 2] ?? null);
    });
    up.disabled = index <= 0;
    down.disabled = index >= source.order.length - 1;
    up.setAttribute('aria-label', 'Przesuń wcześniej');
    down.setAttribute('aria-label', 'Przesuń dalej');
    actions.append(up, down);
    wrapper.append(actions);
    wrapper.draggable = true;
    wrapper.addEventListener('dragstart', event => {
      if (busy) { event.preventDefault(); return; }
      dragged = source;
      event.dataTransfer?.setData('application/x-frogsync-tile', source.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    wrapper.addEventListener('dragend', () => { dragged = null; });
    wrapper.addEventListener('dragover', event => {
      if (dragged?.kind === source.kind && dragged.blockId === source.blockId &&
          dragged.parentId === source.parentId) event.preventDefault();
    });
    wrapper.addEventListener('drop', event => {
      const from = dragged;
      dragged = null;
      if (!from || from.kind !== source.kind || from.blockId !== source.blockId ||
          from.parentId !== source.parentId) return;
      event.preventDefault();
      const rect = wrapper.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      const target = after
        ? source.order[source.order.indexOf(source.id) + 1] ?? null
        : source.id;
      if (target !== from.id) void moveTile(from, target);
    });
  }
  return wrapper;
}
function playable(nodes: WxBookmarkNode[]): WxBookmarkNode[] {
  return nodes.filter(n => n.type !== 'separator' &&
    (n.url === undefined || /^https?:/i.test(n.url)));
}
async function folderBlock(block: FolderBlock, section: HTMLElement): Promise<void> {
  const root = block.folderId === 'root:toolbar'
    ? nativeRootId('root:toolbar') : page.map[block.folderId];
  if (!block.available) {
    section.append(note('Folder jest niedostępny. Wskaż inny w panelu serwera.'));
    return;
  }
  if (!root) {
    section.append(note('Folder jeszcze się synchronizuje.'));
    return;
  }
  try {
    const path = paths.get(block.id) ?? [];
    let parent = root;
    for (let i = 0; i < path.length; i++) {
      let node: WxBookmarkNode | undefined;
      try { [node] = await wx.bookmarks.get(path[i].id); }
      catch { /* Skrocenie sciezki. */ }
      if (!node || node.parentId !== parent || node.url !== undefined) {
        path.splice(i); break;
      }
      parent = node.id; path[i].title = node.title;
    }
    paths.set(block.id, path);
    const raw = await wx.bookmarks.getChildren(parent);
    if (path.length) {
      const crumbs = document.createElement('div');
      crumbs.className = 'crumbs';
      crumbs.append(
        button('← Wróć', () => { path.pop(); void render(); }),
        note(path.map(p => p.title).join(' / ')),
      );
      section.append(crumbs);
    }
    const grid = document.createElement('div');
    grid.className = 'tiles';
    const nodes = playable(raw), order = raw.map(n => n.id);
    grid.append(...nodes.map(node => tile({
      id: node.id, title: node.title, url: node.url,
      kind: 'bookmark', blockId: block.id, parentId: parent, node, order,
      open: () => { path.push({ id: node.id, title: node.title }); void render(); },
    })));
    section.append(grid);
    if (!nodes.length) section.append(note('Ten folder jest pusty.'));
  } catch {
    section.append(note('Folder jeszcze się synchronizuje albo został usunięty lokalnie.'));
  }
}
async function render(): Promise<void> {
  if (!active) return;
  const serial = ++renderNo;
  try {
    let blocks: StartBlock[] = page.cache?.snapshot.configuration.configured
      ? page.cache.snapshot.configuration.blocks : [];
    if (!page.cache?.snapshot.configuration.configured &&
        !wx.extension?.inIncognitoContext) {
      await resolveRoots();
      blocks = [{
        id: 'local-toolbar', type: 'folder', folderId: 'root:toolbar',
        title: 'Pasek zakładek', available: true,
      }];
    }
    if (wx.extension?.inIncognitoContext) blocks = [];
    if (settings.showTopSites && !blocks.some(b => b.type === 'top'))
      blocks = [...blocks, { id: 'local-top', type: 'top' }];
    const tops = await localTopSites(settings.showTopSites);
    const views = await Promise.all(blocks.map(async (block, index) => {
      if (block.type === 'top' && !settings.showTopSites) return null;
      const section = document.createElement('section');
      section.className = 'start-section'; section.id = 'block-' + index;
      const title = document.createElement('h2');
      title.textContent = block.title || (
        block.type === 'folder' ? block.folderTitle || 'Folder zakładek' :
        block.type === 'custom' ? 'Własne kafelki' : 'Najczęściej odwiedzane');
      section.append(title);
      if (block.type === 'folder') await folderBlock(block, section);
      else {
        const grid = document.createElement('div');
        grid.className = 'tiles';
        if (block.type === 'custom') {
          const order = block.tiles.map(t => t.id);
          grid.append(...block.tiles.map(t =>
            tile({ ...t, kind: 'custom', blockId: block.id, order })));
          if (editing)
            section.append(button('Dodaj kafelek', () => openNewTile(block.id)));
        } else {
          grid.append(...tops.map((t, i) => tile({
            ...t, id: String(i), kind: 'top', blockId: block.id, order: [],
          })));
        }
        section.append(grid);
        if (!grid.childElementCount) section.append(note(block.type === 'top'
          ? 'Brak pozycji albo zgody na „Najczęściej odwiedzane”. Sprawdź ustawienia.'
          : 'Ten blok jest pusty.'));
      }
      return section;
    }));
    if (serial !== renderNo) return;
    const visible = views.filter((v): v is HTMLElement => v !== null);
    $('sections').replaceChildren(...visible);
    if (wx.extension?.inIncognitoContext)
      $('sections').replaceChildren(note('W oknie prywatnym dane profilu pozostają ukryte.'));
    const links = $('block-links');
    links.replaceChildren();
    if (visible.length > 1) visible.forEach(section => {
      const a = document.createElement('a');
      a.href = '#' + section.id;
      a.textContent = section.querySelector('h2')!.textContent;
      links.append(a);
    });
  } catch (error) {
    if (serial === renderNo) status(errorText(error));
  }
}

// ---- Wyszukiwarka ----

let suggestions: Suggestion[] = [];
let selectedKey: string | null = null;
let requestNo = 0;
let webAbort: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const input = () => $('search') as HTMLInputElement;
const box = () => $('suggestions') as HTMLElement;

function engine(id: string): SearchEngine {
  const list = catalog();
  return engineById(id, list) ?? engineById(DEFAULT_ENGINE, list) ?? list[0];
}
function pinned(): string[] {
  return normalizePinned(settings.pinnedEngines, catalog());
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
      main.textContent = s.text; side.textContent = 'Google';
    }
    row.append(main, side);
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
    return (await wx.bookmarks.search(q))
      .filter(n => n.url && /^https?:/i.test(n.url))
      .slice(0, 6).map(n => ({ title: n.title, url: n.url! }));
  } catch { return []; }
}
async function webHits(q: string): Promise<string[]> {
  if (!settings.googleSuggest ||
      engine(settings.defaultEngine).suggest !== 'google' || !navigator.onLine) return [];
  webAbort?.abort();
  const ctrl = new AbortController();
  webAbort = ctrl;
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(googleSuggestUrl(q), {
      signal: ctrl.signal, credentials: 'omit', cache: 'no-store',
    });
    return r.ok ? parseGoogleSuggest(await r.json()) : [];
  } catch { return []; }
  finally { clearTimeout(timer); }
}
async function refreshSuggestions(): Promise<void> {
  const q = input().value.trim();
  const no = ++requestNo;
  if (q.length < 2) { closeSuggestions(); return; }
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
  for (const id of pinned()) {
    const e = engine(id);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'engine' + (e.id === settings.defaultEngine ? ' primary' : '');
    const dot = document.createElement('span');
    dot.className = 'engine-dot'; dot.style.background = e.color;
    b.append(dot, document.createTextNode(e.name));
    b.addEventListener('click', () => runSearch(e.id, false));
    bar.append(b);
  }
  bar.hidden = bar.childElementCount === 0;
}
function wireSearch(): void {
  const field = input();
  const name = engine(settings.defaultEngine).name;
  field.placeholder = settings.searchBookmarks
    ? `Szukaj w ${name} lub w zakładkach` : `Szukaj w ${name}`;
  field.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void refreshSuggestions(), 250);
  });
  field.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Escape') closeSuggestions();
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

// ---- Edycja ----

type Editor =
  | { kind: 'bookmark'; source: TileSource }
  | {
      kind: 'custom'; draft: CustomDraft; tileId?: string;
      blockId?: string; current?: StartPageSnapshot;
    };
let editor: Editor | null = null;
const dialog = () => $('tile-dialog') as HTMLDialogElement;
const editTitle = () => $('edit-title') as HTMLInputElement;
const editUrl = () => $('edit-url') as HTMLInputElement;
const editColor = () => $('edit-color') as HTMLInputElement;
const editUseColor = () => $('edit-use-color') as HTMLInputElement;

function describe(blocks: ReturnType<typeof customBlocks>): string {
  return blocks.map(b => (b.title || 'Własne kafelki') + '\n' +
    b.tiles.map((t, i) => (i + 1) + '. ' + t.title + ' — ' + t.url).join('\n')).join('\n\n');
}
function showEditor(): void {
  const custom = editor?.kind === 'custom' ? editor : null;
  const source = editor?.kind === 'bookmark' ? editor.source : null;
  const item = custom?.draft.blocks.flatMap(b => b.tiles).find(t => t.id === custom.tileId);
  $('edit-fields').hidden = !!custom && !custom.tileId;
  $('edit-url-label').hidden = !!source && source.url === undefined;
  $('edit-color-row').hidden = !!source;
  editTitle().value = item?.title ?? source?.title ?? '';
  editUrl().value = item?.url ?? source?.url ?? '';
  const fields = !!source || !!custom?.tileId;
  editTitle().required = fields;
  editUrl().required = fields && (!source || source.url !== undefined);
  editColor().value = item?.color || '#2f9e5b';
  editUseColor().checked = !!item?.color;
  editColor().disabled = !editUseColor().checked;
  $('edit-message').textContent = '';
  $('server-custom').textContent = custom?.current
    ? describe(customBlocks(custom.current)) : '';
  $('desired-custom').textContent = custom ? describe(custom.draft.blocks) : '';
  ($('custom-comparison') as HTMLDetailsElement).hidden = !custom;
  ($('edit-save') as HTMLButtonElement).textContent =
    custom?.current ? 'Zastąp po porównaniu' : 'Zapisz';
  if (!dialog().open) dialog().showModal();
}
function openTileEditor(source: TileSource): void {
  if (busy || !editing) return;
  if (source.kind === 'bookmark') editor = { kind: 'bookmark', source };
  else {
    const cache = page.cache;
    if (!cache) return;
    editor = {
      kind: 'custom', tileId: source.id, blockId: source.blockId,
      draft: {
        id: crypto.randomUUID(), key: cache.key,
        settingsVersion: cache.snapshot.settingsVersion,
        at: Date.now(), blocks: customBlocks(cache.snapshot),
      },
    };
  }
  showEditor();
}
function openNewTile(blockId: string): void {
  if (busy || !page.cache) return;
  const blocks = customBlocks(page.cache.snapshot);
  const block = blocks.find(b => b.id === blockId);
  if (!block) return;
  if (blocks.reduce((n, b) => n + b.tiles.length, 0) >= 200) {
    status('Maksymalnie 200 własnych kafelków.'); return;
  }
  const tileId = crypto.randomUUID();
  block.tiles.push({ id: tileId, title: '', url: '', color: null });
  editor = {
    kind: 'custom', tileId, blockId,
    draft: {
      id: crypto.randomUUID(), key: page.cache.key,
      settingsVersion: page.cache.snapshot.settingsVersion, at: Date.now(), blocks,
    },
  };
  showEditor();
}
function setBusy(value: boolean): void {
  busy = value;
  ($('edit-toggle') as HTMLButtonElement).disabled = value;
  ($('edit-fields') as HTMLFieldSetElement).disabled = value;
  ($('edit-save') as HTMLButtonElement).disabled = value;
  ($('edit-cancel') as HTMLButtonElement).disabled = value;
}
async function submitCustom(
  current: Extract<Editor, { kind: 'custom' }>,
): Promise<boolean> {
  if (current.current) {
    if (!confirm('Zastąpić pokazane własne kafelki serwera Twoją listą? Foldery i szablon pozostaną bez zmian.'))
      return false;
    current.draft.settingsVersion = current.current.settingsVersion;
  }
  const result = await send<CustomSaveReply>({
    type: 'SAVE_STARTPAGE_CUSTOM', draft: current.draft,
  });
  if (!result.saved) {
    current.current = result.current;
    $('edit-message').textContent = result.message;
    $('server-custom').textContent = result.current
      ? describe(customBlocks(result.current)) : '';
    $('desired-custom').textContent = describe(current.draft.blocks);
    ($('edit-save') as HTMLButtonElement).textContent =
      result.current ? 'Zastąp po porównaniu' : 'Ponów zapis';
    return false;
  }
  return true;
}
async function saveLayout(blocks: ReturnType<typeof customBlocks>): Promise<void> {
  if (busy || !page.cache) return;
  const current: Extract<Editor, { kind: 'custom' }> = {
    kind: 'custom',
    draft: {
      id: crypto.randomUUID(), key: page.cache.key,
      settingsVersion: page.cache.snapshot.settingsVersion, at: Date.now(), blocks,
    },
  };
  setBusy(true);
  try {
    editor = current;
    const saved = await send<CustomSaveReply>({
      type: 'SAVE_STARTPAGE_CUSTOM', draft: current.draft,
    });
    if (!saved.saved) {
      current.current = saved.current;
      showEditor();
      $('edit-message').textContent = saved.message;
    } else {
      editor = null; await reload(); status('Zapisano własne kafelki.');
    }
  } catch (error) {
    showEditor(); $('edit-message').textContent = errorText(error);
  } finally { setBusy(false); }
}
async function bookmarkAction(command: StartBookmarkEdit): Promise<void> {
  await send({ type: 'EDIT_START_BOOKMARK', command });
  status('Zmieniono zakładki lokalnie. Synchronizacja prześle zmianę zwykłą kolejką.');
}
async function deleteTile(source: TileSource): Promise<void> {
  if (busy || !confirm(source.url === undefined
    ? 'Usunąć folder wraz z całą zawartością? Powstanie punkt przywracania.'
    : 'Usunąć ten kafelek?')) return;
  try {
    if (source.kind === 'bookmark') {
      setBusy(true);
      await bookmarkAction({ action: 'delete', base: source.node! });
      await render();
    } else if (source.kind === 'custom' && page.cache) {
      const blocks = customBlocks(page.cache.snapshot);
      const block = blocks.find(b => b.id === source.blockId);
      if (!block) throw new Error('Blok zmienił się.');
      block.tiles = block.tiles.filter(t => t.id !== source.id);
      await saveLayout(blocks);
    }
  } catch (error) { status(errorText(error)); }
  finally { setBusy(false); }
}
async function moveTile(source: TileSource, beforeId: string | null): Promise<void> {
  if (busy || beforeId === source.id) return;
  try {
    if (source.kind === 'bookmark') {
      setBusy(true);
      await bookmarkAction({
        action: 'move', base: source.node!, order: source.order, beforeId,
      });
      await render();
    } else if (source.kind === 'custom' && page.cache) {
      const blocks = customBlocks(page.cache.snapshot);
      const block = blocks.find(b => b.id === source.blockId);
      if (!block) throw new Error('Blok zmienił się.');
      block.tiles = moveBefore(block.tiles, source.id, beforeId);
      await saveLayout(blocks);
    }
  } catch (error) { status(errorText(error)); }
  finally { setBusy(false); }
}
$('edit-form').addEventListener('submit', event => {
  event.preventDefault();
  const current = editor;
  if (!current || busy) return;
  void (async () => {
    setBusy(true);
    try {
      if (current.kind === 'bookmark') {
        await bookmarkAction({
          action: 'update', base: current.source.node!,
          title: editTitle().value,
          url: current.source.url === undefined ? undefined : editUrl().value,
        });
      } else {
        if (current.tileId) {
          const tile = current.draft.blocks.flatMap(b => b.tiles)
            .find(t => t.id === current.tileId);
          if (!tile) throw new Error('Kafelek nie jest już dostępny.');
          tile.title = editTitle().value; tile.url = editUrl().value;
          tile.color = editUseColor().checked ? editColor().value : null;
        }
        if (!(await submitCustom(current))) return;
      }
      editor = null; dialog().close(); await reload();
    } catch (error) { $('edit-message').textContent = errorText(error); }
    finally { setBusy(false); }
  })();
});
async function cancelEditor(): Promise<void> {
  if (busy || !confirm('Odrzucić niezapisane zmiany tego formularza?')) return;
  const current = editor;
  if (current?.kind === 'custom') await send({
    type: 'DISCARD_STARTPAGE_DRAFT', key: current.draft.key, id: current.draft.id,
  });
  editor = null; dialog().close(); await reload();
}
$('edit-cancel').addEventListener('click', () => {
  void cancelEditor().catch(e => status(errorText(e)));
});
dialog().addEventListener('cancel', event => {
  event.preventDefault();
  void cancelEditor().catch(e => status(errorText(e)));
});
editUseColor().addEventListener('change', () => {
  editColor().disabled = !editUseColor().checked;
});
$('edit-toggle').addEventListener('click', () => {
  if (busy) return;
  editing = !editing;
  $('edit-toggle').setAttribute('aria-pressed', String(editing));
  $('edit-toggle').textContent = editing ? 'Zakończ edycję' : 'Edytuj';
  void render();
});
$('resume-draft').addEventListener('click', () => {
  void (async () => {
    if (busy || !page.cache) return;
    const draft = await send<CustomDraft | null>({ type: 'GET_STARTPAGE_DRAFT' });
    if (!draft || draft.key !== page.cache.key) return;
    editor = { kind: 'custom', draft }; showEditor();
  })().catch(e => status(errorText(e)));
});

// ---- Start i odswiezanie bez ponawiania fokusu ----

async function reload(): Promise<void> {
  const no = ++readNo;
  const [view, stored] = await Promise.all([
    readStartPage(), getLocal<Partial<Settings>>(KEYS.settings, {}),
  ]);
  if (no !== readNo) return;
  if (view.cache?.key !== page.cache?.key) { paths.clear(); dragged = null; }
  page = view;
  settings = { ...DEFAULT_SETTINGS, ...stored };
  if (wx.extension?.inIncognitoContext)
    settings = { ...settings, showTopSites: false, searchBookmarks: false, googleSuggest: false };
  faviconAllowed = !isGecko() && settings.showFavicons &&
    await wx.permissions.contains({ permissions: ['favicon'] }).catch(() => false);
  if (no !== readNo) return;
  appearance();
  const forced = new URLSearchParams(location.search).get('view') === 'start';
  const blank = !settings.startPage && !forced && !manualShow;
  document.body.classList.toggle('blank', blank);
  document.documentElement.classList.remove('booting', 'start-hidden');
  if (blank) return;
  if (!active) {
    active = true; wireSearch(); initialFocus();
  } else {
    requestNo++; webAbort?.abort(); closeSuggestions(); renderEngines();
    input().placeholder = 'Szukaj w ' + engine(settings.defaultEngine).name;
  }
  const missing = page.cache?.snapshot.configuration.engines
    .filter(e => !settings.pinnedEngines.includes(e.id)) ?? [];
  $('new-engines').hidden = !missing.length;
  await render();
  const draft = await send<CustomDraft | null>({
    type: 'GET_STARTPAGE_DRAFT',
  }).catch(() => null);
  if (no === readNo)
    $('draft-banner').hidden = !draft || draft.key !== page.cache?.key;
}
$('show-anyway').addEventListener('click', () => {
  manualShow = true; void reload();
});
$('logo').addEventListener('load', logoColors);
$('logo').addEventListener('error', () => {
  const logo = $('logo') as HTMLImageElement;
  if (logo.getAttribute('src') !== 'icons/icon128.png') logo.src = 'icons/icon128.png';
});
function scheduleRender(): void {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(() => { void render(); }, 40);
}
for (const event of [
  wx.bookmarks.onCreated, wx.bookmarks.onRemoved, wx.bookmarks.onChanged,
  wx.bookmarks.onMoved, wx.bookmarks.onChildrenReordered,
]) event?.addListener(scheduleRender);

wx.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local' ||
      ![KEYS.server, KEYS.settings, STARTPAGE_CACHE, STARTPAGE_MAP]
        .some(key => key in changes)) return;
  if (KEYS.server in changes) {
    readNo++; renderNo++; paths.clear(); dragged = null;
    page = { cache: null, map: {} };
    $('sections').replaceChildren(); $('block-links').replaceChildren();
    ($('logo') as HTMLImageElement).src = 'icons/icon128.png';
    ($('glass-background') as HTMLImageElement).removeAttribute('src');
  }
  void reload().catch(error => status(errorText(error)));
});
wx.permissions.onRemoved?.addListener(() => {
  void reload().catch(error => status(errorText(error)));
});
function clock(): void {
  $('clock-time').textContent = new Date().toLocaleTimeString('pl-PL', {
    hour: '2-digit', minute: '2-digit',
  });
  $('clock-date').textContent = new Date().toLocaleDateString('pl-PL', {
    weekday: 'long', day: 'numeric', month: 'long',
  });
}
clock();
setInterval(clock, 30000);
window.addEventListener('beforeunload', event => {
  if (editor || busy) { event.preventDefault(); event.returnValue = ''; }
});
void reload().catch(error => {
  document.documentElement.classList.remove('booting');
  status(errorText(error));
});

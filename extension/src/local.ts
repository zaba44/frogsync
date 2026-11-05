import { wx, isGecko, type WxBookmarkNode } from './wx.js';
import type { Kind, LocalNode, Mapping } from './core/diff.js';
import { chromiumIndex } from './core/reorder.js';

// ============================================================
// Lokalne drzewo zakladek: odczyt w postaci niezaleznej od przegladarki
// i wykonywanie zmian.
// ============================================================

export const SERVER_ROOTS = ['root:toolbar', 'root:menu', 'root:unsorted', 'root:mobile'] as const;
export type ServerRoot = typeof SERVER_ROOTS[number];

const GECKO_ROOTS: Record<ServerRoot, string> = {
  'root:toolbar':  'toolbar_____',
  'root:menu':     'menu________',
  'root:unsorted': 'unfiled_____',
  'root:mobile':   'mobile______',
};

// Chrome, Edge i Opera numeruja korzenie 1, 2, 3 — ale Brave nie (np. 1, 368, 369).
// Wartosci domyslne nadpisuje resolveRoots() odczytem z samej przegladarki.
const CHROMIUM_ROOTS: Partial<Record<ServerRoot, string>> = {
  'root:toolbar':  '1',
  'root:unsorted': '2',   // "Inne zakladki"
  'root:mobile':   '3',
};

const CHROMIUM_FOLDER_TYPES: Record<string, ServerRoot> = {
  'bookmarks-bar': 'root:toolbar', other: 'root:unsorted', mobile: 'root:mobile',
};

/**
 * Odczytuje prawdziwe identyfikatory korzeni Chromium. Nowsze wersje podaja
 * folderType; starsze — kolejnosc: pasek, inne, mobilne (bez zarzadzanych).
 * Trzeba wywolac przed nativeRootId(). Bez pamieci podrecznej: to jedno tanie
 * zapytanie, a profil przegladarki moze sie zmienic (np. przywrocenie z kopii).
 */
export async function resolveRoots(): Promise<void> {
  if (isGecko()) return;
  const roots = (await wx.bookmarks.getChildren('0'))
    .filter(r => !r.unmodifiable) as (WxBookmarkNode & { folderType?: string })[];
  const byType = roots.filter(r => r.folderType && CHROMIUM_FOLDER_TYPES[r.folderType]);
  if (byType.length > 0) {
    for (const r of byType) CHROMIUM_ROOTS[CHROMIUM_FOLDER_TYPES[r.folderType!]] = r.id;
  } else {
    const order: ServerRoot[] = ['root:toolbar', 'root:unsorted', 'root:mobile'];
    roots.slice(0, 3).forEach((r, i) => { CHROMIUM_ROOTS[order[i]] = r.id; });
  }
}

/** Nazwy korzeni do odtwarzania pochodzenia zakladek w kwarantannie. */
export const ROOT_LABELS: Record<ServerRoot, string> = {
  'root:toolbar': 'Pasek zakładek',
  'root:menu': 'Menu zakładek',
  'root:unsorted': 'Inne zakładki',
  'root:mobile': 'Zakładki mobilne',
};

/**
 * Chromium nie ma menu zakladek. Zawartosc menu z Firefoksa trafia do zwyklego
 * folderu w "Inne zakladki", zmapowanego na root:menu.
 *
 * Folder rozpoznajemy WYLACZNIE po zapisanym identyfikatorze, nigdy po nazwie —
 * inaczej wtyczka przejelaby wlasny folder uzytkownika, ktory przypadkiem
 * nazywa sie tak samo, i wyslala jego zawartosc do profilu.
 */
export const MENU_STAND_IN_TITLE = 'Menu zakładek';

export function nativeRootId(root: ServerRoot): string | undefined {
  return isGecko() ? GECKO_ROOTS[root] : CHROMIUM_ROOTS[root];
}

/**
 * Uzupelnia mapowanie korzeni. Folder zastepczy menu w Chromium tworzy dopiero,
 * gdy jest potrzebny, i od razu go rejestruje. Zwraca true, gdy mapowanie sie zmienilo
 * — wolajacy MUSI wtedy zapisac stan, zanim zrobi cokolwiek dalej.
 */
export async function ensureRootMapping(mapping: Mapping, needMenu: boolean): Promise<boolean> {
  let changed = false;
  const link = (serverId: string, localId: string) => {
    if (mapping.s2l[serverId] === localId) return;
    const previous = mapping.s2l[serverId];
    if (previous) delete mapping.l2s[previous];
    mapping.s2l[serverId] = localId;
    mapping.l2s[localId] = serverId;
    changed = true;
  };

  await resolveRoots();
  for (const root of SERVER_ROOTS) {
    const native = nativeRootId(root);
    if (native) link(root, native);
  }

  if (!isGecko() && needMenu) {
    const current = mapping.s2l['root:menu'];
    if (!current || !(await exists(current))) {
      const standIn = await wx.bookmarks.create({ parentId: CHROMIUM_ROOTS['root:unsorted']!, title: MENU_STAND_IN_TITLE, index: 0 });
      link('root:menu', standIn.id);
    }
  }
  return changed;
}

// ============================================================
// Odczyt
// ============================================================

export function kindOf(node: WxBookmarkNode): Kind {
  if (node.type === 'separator') return 'separator';
  if (node.type === 'folder') return 'folder';
  if (node.type === 'bookmark') return 'bookmark';
  return node.url !== undefined ? 'bookmark' : 'folder';
}

/**
 * Dzieci korzenia przegladarki w postaci dla diff().
 * Wezly zarzadzane polityka (zakladki firmowe w Chromium) sa tylko do odczytu —
 * pomijamy je calkowicie: nie adoptujemy, nie przenosimy, nie wysylamy.
 */
export async function readRoots(): Promise<LocalNode[]> {
  const [root] = await wx.bookmarks.getTree();
  const convert = (node: WxBookmarkNode, isRoot: boolean): LocalNode => ({
    id: node.id,
    parentId: node.parentId,
    kind: isRoot ? 'root' : kindOf(node),
    title: node.title ?? '',
    url: node.url,
    children: node.children?.filter(c => !c.unmodifiable).map(c => convert(c, false)),
  });
  return (root.children ?? []).filter(c => !c.unmodifiable).map(c => convert(c, true));
}

export function indexTree(roots: LocalNode[]): Map<string, LocalNode> {
  const map = new Map<string, LocalNode>();
  const walk = (n: LocalNode) => { map.set(n.id, n); n.children?.forEach(walk); };
  roots.forEach(walk);
  return map;
}

export async function exists(id: string): Promise<boolean> {
  try { return (await wx.bookmarks.get(id)).length > 0; } catch { return false; }
}

export function countBookmarks(node: LocalNode | undefined): number {
  if (!node) return 0;
  if (node.kind === 'bookmark') return 1;
  return (node.children ?? []).reduce((sum, c) => sum + countBookmarks(c), 0);
}

// ============================================================
// Zapis
// ============================================================

/** Wpis, ktorego ta przegladarka nie przyjmie nigdy — to ograniczenie, nie blad. */
export class Unrepresentable extends Error {}

const ALWAYS_SUPPORTED = /^(https?|ftp):/i;

export async function createLocal(parentId: string, kind: Kind, title: string, url: string | null, index?: number): Promise<string> {
  if (kind === 'separator') {
    if (!isGecko()) throw new Unrepresentable('Chromium nie obsługuje separatorów');
    return (await wx.bookmarks.create({ parentId, type: 'separator', index })).id;
  }
  if (kind === 'folder') return (await wx.bookmarks.create({ parentId, title, index })).id;

  try {
    return (await wx.bookmarks.create({ parentId, title, url: url ?? '', index })).id;
  } catch (err) {
    // Odrzucony adres spoza http/https/ftp (chrome://, place:, about:, javascript: itp.)
    // to ograniczenie tej przegladarki — ponawianie nic nie da. Odrzucony zwykly
    // adres traktujemy jak chwilowy blad i ponowimy.
    if (!ALWAYS_SUPPORTED.test(url ?? '')) throw new Unrepresentable(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export async function updateLocal(id: string, changes: { title?: string; url?: string }): Promise<void> {
  if (changes.title === undefined && changes.url === undefined) return;
  await wx.bookmarks.update(id, changes);
}

export async function moveToFolderEnd(id: string, parentId: string): Promise<void> {
  const children = await wx.bookmarks.getChildren(parentId);
  if (children.some(c => c.id === id)) return;
  await wx.bookmarks.move(id, { parentId });
}

/**
 * Przeniesienie na pozycje w tym samym folderze. index ma semantyke Firefoksa
 * (pozycja PO przeniesieniu); dla Chromium przeliczamy, bo tam przy przesuwaniu
 * w dol trzeba podac indeks o jeden wiekszy.
 */
export async function moveWithin(id: string, parentId: string, index: number, currentOrder: string[]): Promise<void> {
  const target = isGecko() ? index : chromiumIndex(currentOrder, id, index);
  await wx.bookmarks.move(id, { parentId, index: target });
}

/**
 * Usuniecie pojedynczego wpisu. Folder usuwamy tylko pustego — o tym, co ma
 * zostac z jego zawartosci, decyduje silnik (patrz removeFolderSafely w engine).
 * Zwraca true, gdy wpisu na pewno juz nie ma.
 */
export async function removeLocal(id: string): Promise<boolean> {
  try { await wx.bookmarks.remove(id); } catch { /* sprawdzimy nizej */ }
  return !(await exists(id));
}

export async function childIds(parentId: string): Promise<string[]> {
  return (await wx.bookmarks.getChildren(parentId)).map(c => c.id);
}

export async function children(parentId: string): Promise<WxBookmarkNode[]> {
  return wx.bookmarks.getChildren(parentId);
}

export async function moveTo(id: string, parentId: string): Promise<void> {
  await wx.bookmarks.move(id, { parentId });
}

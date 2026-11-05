import type { SearchEngine } from './search.js';

export type StartTemplate = 'classic' | 'compact' | 'glass' | 'live';
export interface CustomTile { id: string; title: string; url: string; color?: string | null }
export interface FolderBlock {
  id: string; type: 'folder'; folderId: string; title?: string | null;
  available: boolean; folderTitle?: string | null;
}
export interface CustomBlock {
  id: string; type: 'custom'; title?: string | null; tiles: CustomTile[];
}
export interface TopBlock { id: string; type: 'top'; title?: string | null }
export type StartBlock = FolderBlock | CustomBlock | TopBlock;

export interface StartPageSnapshot {
  profileId: string;
  generation: string;
  settingsVersion: number;
  logoVersion: number;
  backgroundVersion: number;
  configuration: {
    version: 2;
    configured: boolean;
    template: StartTemplate;
    blocks: StartBlock[];
    engines: SearchEngine[];
  };
}

export const TEMPLATES: readonly StartTemplate[] = ['classic', 'compact', 'glass', 'live'];

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, n: number): v is string => typeof v === 'string' && v.length <= n;
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const id = (v: unknown): v is string => text(v, 64) && /^[A-Za-z0-9_-]{1,64}$/.test(v);
const color = (v: unknown): v is string => text(v, 7) && /^#[0-9a-f]{6}$/i.test(v);

function fail(): never {
  throw new Error('Niepoprawna konfiguracja strony startowej.');
}
function title(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (!text(v, 200) || /[\u0000-\u001f\u007f]/.test(v)) return fail();
  return v.trim() || null;
}
export function httpUrl(value: string): string {
  const input = value.trim();
  if (!input || input.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(input)) return fail();
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !url.hostname || url.username || url.password) return fail();
  return input;
}

/** Rozumie stary cache v1, ale zawsze oddaje kanoniczne v2. */
export function parseStartPage(value: unknown): StartPageSnapshot {
  if (!object(value) || !text(value.profileId, 128) || !value.profileId ||
      !text(value.generation, 128) || !value.generation ||
      !integer(value.settingsVersion) || !integer(value.logoVersion) ||
      !object(value.configuration)) return fail();

  const c = value.configuration;
  const legacy = c.version === 1;
  let raw: unknown;
  if (legacy) {
    if (!Array.isArray(c.sections)) return fail();
    raw = c.sections.map(s => object(s) ? { ...s, type: 'folder' } : s);
  } else raw = c.blocks;

  if ((!legacy && c.version !== 2) || !Array.isArray(raw) || raw.length > 64 ||
      !Array.isArray(c.engines) || c.engines.length > 32) return fail();

  const template = legacy ? 'classic' : c.template;
  if (!TEMPLATES.includes(template as StartTemplate) ||
      (!legacy && typeof c.configured !== 'boolean')) return fail();

  const blockIds = new Set<string>();
  const folderIds = new Set<string>();
  const tileIds = new Set<string>();
  let tiles = 0, tops = 0;

  const blocks: StartBlock[] = raw.map(b => {
    if (!object(b) || !id(b.id) || blockIds.has(b.id)) return fail();
    blockIds.add(b.id);
    const base = { id: b.id, title: title(b.title) };

    if (b.type === 'folder') {
      if (!text(b.folderId, 36) ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(b.folderId) ||
          folderIds.has(b.folderId.toLowerCase()) ||
          typeof b.available !== 'boolean' ||
          !(b.folderTitle == null || text(b.folderTitle, 8192))) return fail();
      folderIds.add(b.folderId.toLowerCase());
      return {
        ...base, type: 'folder', folderId: b.folderId.toLowerCase(),
        available: b.available,
        folderTitle: b.folderTitle as string | null | undefined,
      };
    }
    if (b.type === 'top') {
      if (++tops > 1) return fail();
      return { ...base, type: 'top' };
    }
    if (b.type !== 'custom' || !Array.isArray(b.tiles) ||
        (tiles += b.tiles.length) > 200) return fail();

    return {
      ...base, type: 'custom',
      tiles: b.tiles.map(t => {
        if (!object(t) || !id(t.id) || tileIds.has(t.id) ||
            !text(t.title, 200) || !t.title.trim() ||
            !text(t.url, 2048) || !(t.color == null || color(t.color))) return fail();
        tileIds.add(t.id);
        return {
          id: t.id, title: title(t.title)!, url: httpUrl(t.url),
          color: t.color == null ? null : (t.color as string).toUpperCase(),
        };
      }),
    };
  });

  const engineIds = new Set<string>();
  const engines: SearchEngine[] = c.engines.map(e => {
    if (!object(e) || !id(e.id) || engineIds.has(e.id) ||
        !text(e.name, 100) || !e.name.trim() ||
        !text(e.url, 2048) || (e.url.match(/%s/g) || []).length !== 1 ||
        !color(e.color) || !['none', 'google'].includes(e.suggest as string)) return fail();
    const url = new URL(httpUrl(e.url.replace('%s', 'FrogSync')));
    if (url.protocol !== 'https:' ||
        url.host !== new URL(e.url.replace('%s', 'AnotherQuery')).host) return fail();
    engineIds.add(e.id);
    return {
      id: e.id, name: e.name, url: e.url, color: e.color,
      suggest: e.suggest as 'google' | 'none',
    };
  });

  if (!legacy && !integer(value.backgroundVersion)) return fail();
  const configured = legacy ? blocks.length > 0 : c.configured as boolean;
  if (!configured && blocks.length) return fail();

  return {
    profileId: value.profileId, generation: value.generation,
    settingsVersion: value.settingsVersion, logoVersion: value.logoVersion,
    backgroundVersion: legacy ? 0 : value.backgroundVersion as number,
    configuration: {
      version: 2, configured, template: template as StartTemplate, blocks, engines,
    },
  };
}
export function customBlocks(snapshot: StartPageSnapshot): CustomBlock[] {
  return structuredClone(snapshot.configuration.blocks.filter(
    (b): b is CustomBlock => b.type === 'custom'));
}
export function normalizeCustom(blocks: CustomBlock[]): CustomBlock[] {
  return customBlocks(parseStartPage({
    profileId: 'validation', generation: 'validation',
    settingsVersion: 0, logoVersion: 0, backgroundVersion: 0,
    configuration: {
      version: 2, configured: true, template: 'classic', blocks, engines: [],
    },
  }));
}
export function moveBefore<T extends { id: string }>(
  items: readonly T[], id: string, before: string | null,
): T[] {
  const item = items.find(x => x.id === id);
  if (!item || id === before || (before !== null && !items.some(x => x.id === before)))
    throw new Error('Kolejność zmieniła się. Odśwież widok.');
  const result = items.filter(x => x.id !== id);
  result.splice(before === null ? result.length : result.findIndex(x => x.id === before), 0, item);
  return result;
}
export function topSites(
  rows: readonly { title?: string; url: string }[],
): { title: string; url: string }[] {
  const seen = new Set<string>();
  return rows.flatMap(row => {
    try {
      const url = httpUrl(row.url), key = new URL(url).href;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ title: row.title || new URL(url).hostname, url }];
    } catch { return []; }
  }).slice(0, 20);
}
export function mayFocusSearch(
  enabled: boolean, interacted: boolean, elapsed: number,
  visible: boolean, activeTag: string,
): boolean {
  return enabled && !interacted && elapsed < 300 &&
    visible && ['BODY', 'HTML', 'INPUT'].includes(activeTag);
}

export interface BookmarkBase {
  id: string; title: string; url?: string; parentId?: string;
}
export type StartBookmarkEdit =
  | { action: 'update'; base: BookmarkBase; title: string; url?: string }
  | { action: 'delete'; base: BookmarkBase }
  | { action: 'move'; base: BookmarkBase; order: string[]; beforeId: string | null };

export interface CustomDraft {
  id: string;
  key: string;
  settingsVersion: number;
  blocks: CustomBlock[];
  at: number;
}
export interface CustomSaveReply {
  saved: boolean;
  message: string;
  current?: StartPageSnapshot;
}

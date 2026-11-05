import * as api from './api.js';
import { wx } from './wx.js';
import { getLocal, setLocal, KEYS } from './storage.js';
import { exclusive, ifFree, MAIN_LOCK } from './locks.js';
import { parseStartPage, type StartPageSnapshot } from './core/startpage.js';
import type { ServerSession } from './types.js';

export const STARTPAGE_CACHE = 'startpageCache';
export const STARTPAGE_MAP = 'startpageMap';
const REFRESH_MS = 5 * 60_000;

interface CachedImage { etag: string; dataUrl: string; version?: number }
export interface StartPageCache {
  key: string;
  etag: string;
  fetchedAt: number;
  attemptedAt?: number;
  snapshot: StartPageSnapshot;
  logo?: CachedImage;
  background?: CachedImage;
}
export interface StartPageProjection { key: string; folders: Record<string, string> }

export function cacheKey(
  session: Pick<ServerSession, 'url' | 'profile' | 'generation' | 'deviceId'>,
): string {
  return JSON.stringify([
    new URL(session.url).href.replace(/\/+$/, ''),
    session.profile.id, session.generation, session.deviceId,
  ]);
}
function normalize(cache: StartPageCache | null, session: ServerSession): StartPageCache | null {
  if (!cache) return null;
  const legacy = session.url + '|' + session.profile.id + '|' + session.generation;
  if (cache.key !== cacheKey(session) && cache.key !== legacy) return null;
  const snapshot = parseStartPage(cache.snapshot);
  if (snapshot.profileId !== session.profile.id || snapshot.generation !== session.generation)
    return null;
  return { ...cache, key: cacheKey(session), snapshot };
}
async function projection(
  session: ServerSession, cache: StartPageCache | null,
): Promise<StartPageProjection> {
  const state = await getLocal<{
    mapping?: { s2l?: Record<string, string> };
    pendingDeletes?: string[];
    skipped?: Record<string, unknown>;
  } | null>('engineState', null);
  const folders: Record<string, string> = {};
  for (const block of cache?.snapshot.configuration.blocks ?? []) {
    if (block.type !== 'folder' || !block.available ||
        state?.pendingDeletes?.includes(block.folderId) ||
        state?.skipped?.[block.folderId]) continue;
    const local = state?.mapping?.s2l?.[block.folderId];
    if (local) folders[block.folderId] = local;
  }
  return { key: cacheKey(session), folders };
}
function dataUrl(image: api.StartPageImage): string {
  const bytes = new Uint8Array(image.bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return 'data:' + image.type + ';base64,' + btoa(binary);
}
export function safeImage(value: string | undefined): string | undefined {
  return value && value.length < 2800000 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value : undefined;
}

/** Jedna migawka storage, bez sieci i bez engineState w stronie nowej karty. */
export async function readStartPage(): Promise<{
  cache: StartPageCache | null; map: Record<string, string>;
}> {
  if (wx.extension?.inIncognitoContext) return { cache: null, map: {} };
  const got = await wx.storage.local.get([KEYS.server, STARTPAGE_CACHE, STARTPAGE_MAP]);
  const session = got[KEYS.server] as ServerSession | null;
  if (!session) return { cache: null, map: {} };
  let cache: StartPageCache | null = null;
  try {
    cache = normalize(got[STARTPAGE_CACHE] as StartPageCache | null, session);
  } catch { /* Zly cache pomijamy. */ }
  const map = got[STARTPAGE_MAP] as StartPageProjection | null;
  return { cache, map: map?.key === cacheKey(session) ? map.folders : {} };
}
export async function clearStartPage(): Promise<void> {
  await exclusive(MAIN_LOCK, () => setLocal({
    [STARTPAGE_CACHE]: null, [STARTPAGE_MAP]: null, startpageAttempt: null,
  }));
}

/** Wywolywane pod MAIN_LOCK. Nie cofa wersji w tej samej generacji. */
export async function acceptStartPage(
  session: ServerSession, snapshot: StartPageSnapshot,
): Promise<void> {
  if (snapshot.profileId !== session.profile.id || snapshot.generation !== session.generation)
    throw new Error('Konfiguracja nalezy do innej sesji.');
  let old: StartPageCache | null = null;
  try {
    old = normalize(await getLocal<StartPageCache | null>(STARTPAGE_CACHE, null), session);
  } catch { /* Naprawa cache. */ }
  if (old && old.snapshot.settingsVersion > snapshot.settingsVersion) return;
  const cache: StartPageCache = {
    ...old, key: cacheKey(session), etag: '', fetchedAt: 0, attemptedAt: 0, snapshot,
  };
  await setLocal({
    [STARTPAGE_CACHE]: cache,
    [STARTPAGE_MAP]: await projection(session, cache),
  });
}

/** Siec poza MAIN_LOCK; krotkie zapisy chronione przed zmiana sesji. */
export async function refreshStartPage(force = false): Promise<void> {
  try {
    await ifFree('frogsync-startpage-fetch', async () => {
      const begin = await exclusive(MAIN_LOCK, async () => {
        const session = await getLocal<ServerSession | null>(KEYS.server, null);
        if (!session) {
          await setLocal({ [STARTPAGE_CACHE]: null, [STARTPAGE_MAP]: null });
          return null;
        }
        let cache: StartPageCache | null = null;
        try {
          cache = normalize(await getLocal<StartPageCache | null>(STARTPAGE_CACHE, null), session);
        } catch { /* Odczyt od nowa. */ }
        const now = Date.now();
        await setLocal({
          [STARTPAGE_CACHE]: cache, [STARTPAGE_MAP]: await projection(session, cache),
        });
        const last = await getLocal<{ key: string; at: number } | null>('startpageAttempt', null);
        const attempt = last?.key === cacheKey(session) ? last.at : cache?.attemptedAt ?? 0;
        if (!force && now >= attempt && now - attempt < REFRESH_MS) return null;
        await setLocal({ startpageAttempt: { key: cacheKey(session), at: now } });
        if (cache) await setLocal({ [STARTPAGE_CACHE]: { ...cache, attemptedAt: now } });
        return { session, cache, startedAt: now };
      });
      if (!begin) return;
      const { session, startedAt } = begin;
      let cache = begin.cache;
      const fresh = await api.startPage(session, cache?.etag);
      if (fresh) {
        if (fresh.snapshot.profileId !== session.profile.id ||
            fresh.snapshot.generation !== session.generation) return;
        cache = {
          ...cache, key: cacheKey(session), etag: fresh.etag,
          fetchedAt: Date.now(), attemptedAt: startedAt, snapshot: fresh.snapshot,
        };
      } else if (cache) {
        cache = { ...cache, fetchedAt: Date.now(), attemptedAt: startedAt };
      }
      if (!cache) return;
      for (const name of ['logo', 'background'] as const) {
        try {
          const version = cache.snapshot[
            name + 'Version' as 'logoVersion' | 'backgroundVersion'];
          const image = await api.startPageImage(session, name,
            cache[name]?.version === version ? cache[name]?.etag : undefined);
          if (image === 'none') cache[name] = undefined;
          else if (image && image.version === version)
            cache[name] = {
              etag: image.etag, dataUrl: dataUrl(image), version: image.version,
            };
        } catch { /* Konfiguracje zachowujemy mimo awarii obrazu. */ }
      }
      const completed = cache;
      await exclusive(MAIN_LOCK, async () => {
        const current = await getLocal<ServerSession | null>(KEYS.server, null);
        if (!current || current.token !== session.token ||
            cacheKey(current) !== completed.key) return;
        const latest = await getLocal<StartPageCache | null>(STARTPAGE_CACHE, null);
        if (latest?.key === completed.key &&
            latest.snapshot.settingsVersion > completed.snapshot.settingsVersion) return;
        await setLocal({
          [STARTPAGE_CACHE]: completed,
          [STARTPAGE_MAP]: await projection(current, completed),
        });
      });
    });
  } catch { /* Ostatnie poprawne dane pozostaja, syncStatus bez zmian. */ }
}

import * as api from './api.js';
import { getLocal, setLocal, KEYS } from './storage.js';
import type { ServerSession } from './types.js';

// ============================================================
// Konfiguracja strony startowej profilu w pamieci wtyczki.
//
// Strona nowej karty czyta WYLACZNIE ten cache (i mape folderow) — nie czeka
// na siec ani na worker, dziala offline. Tlo odswieza go po przebiegu
// synchronizacji, najwyzej co 5 minut, warunkowo (ETag).
//
// Klucz = serwer + profil + generacja: zmiana profilu, ponowne parowanie albo
// odtworzenie kopii serwera nigdy nie pokaza starych sekcji innego profilu.
// ============================================================

export const STARTPAGE_CACHE = 'startpageCache';
/** id folderu na serwerze -> id folderu w tej przegladarce, tylko dla sekcji. */
export const STARTPAGE_MAP = 'startpageMap';

const REFRESH_MS = 5 * 60_000;

export interface StartPageCache {
  key: string;
  etag: string;
  fetchedAt: number;
  snapshot: api.StartPageSnapshot;
  logo?: { etag: string; dataUrl: string };
}

export function cacheKey(session: Pick<ServerSession, 'url' | 'profile' | 'generation'>): string {
  return `${session.url}|${session.profile.id}|${session.generation}`;
}

function toDataUrl(type: string, bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

export async function clearStartPage(): Promise<void> {
  await setLocal({ [STARTPAGE_CACHE]: null, [STARTPAGE_MAP]: {} });
}

/** Mapa folderow sekcji z mapowania silnika — tylko odczyt, bez blokady. */
async function updateMap(cache: StartPageCache | null): Promise<void> {
  const state = await getLocal<{ mapping?: { s2l?: Record<string, string> } } | null>('engineState', null);
  const s2l = state?.mapping?.s2l ?? {};
  const map: Record<string, string> = {};
  for (const s of cache?.snapshot.configuration.sections ?? []) if (s2l[s.folderId]) map[s.folderId] = s2l[s.folderId];
  await setLocal({ [STARTPAGE_MAP]: map });
}

/**
 * Odswieza cache. Bledy sieci zostawiaja ostatnie poprawne dane; nigdy nie rzuca —
 * strona startowa nie moze zatrzymac synchronizacji.
 */
export async function refreshStartPage(force = false): Promise<void> {
  try {
    const session = await getLocal<ServerSession | null>(KEYS.server, null);
    if (!session) { await clearStartPage(); return; }

    const key = cacheKey(session);
    let cache = await getLocal<StartPageCache | null>(STARTPAGE_CACHE, null);
    if (cache && cache.key !== key) cache = null;   // inny profil albo generacja — stare dane do kosza

    if (!force && cache && Date.now() - cache.fetchedAt < REFRESH_MS) { await updateMap(cache); return; }

    const fresh = await api.startPage(session, cache?.etag);
    if (fresh) {
      cache = { key, etag: fresh.etag, fetchedAt: Date.now(), snapshot: fresh.snapshot, logo: cache?.logo };
    } else if (cache) {
      cache = { ...cache, fetchedAt: Date.now() };
    }
    if (!cache) return;

    if (cache.snapshot.logoVersion > 0) {
      const logo = await api.startPageLogo(session, cache.logo?.etag);
      if (logo === 'none') cache.logo = undefined;
      else if (logo) cache.logo = { etag: logo.etag, dataUrl: toDataUrl(logo.type, logo.bytes) };
    } else {
      cache.logo = undefined;
    }

    await setLocal({ [STARTPAGE_CACHE]: cache });
    await updateMap(cache);
  } catch {
    // Offline albo stary serwer bez /startpage — zostaje ostatni poprawny cache
  }
}

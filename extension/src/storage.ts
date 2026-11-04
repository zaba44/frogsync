import { wx } from './wx.js';

// ============================================================
// Trwaly stan i blokady.
//
// Zasada: NIC istotnego nie mieszka w zmiennych modulu.
//
// v1 trzymala isImporting, faviconStatus i faviconRefreshCancelled jako
// zwykle zmienne globalne. Chrome ubija service workera po ~30 s bezczynnosci,
// wiec te wartosci znikaly w srodku operacji: postep odswiezania favicon
// resetowal sie do zera, a popup odpytywal swiezego workera, ktory nic nie wiedzial.
// ============================================================

export async function getLocal<T>(key: string, fallback: T): Promise<T> {
  const data = await wx.storage.local.get(key);
  return (data[key] as T | undefined) ?? fallback;
}

export async function setLocal(items: Record<string, unknown>): Promise<void> {
  await wx.storage.local.set(items);
}

export async function removeLocal(keys: string | string[]): Promise<void> {
  await wx.storage.local.remove(keys);
}

/**
 * storage.session zyje tylko do zamkniecia przegladarki, ale PRZEZYWA
 * ubicie service workera — dokladnie to, czego potrzebujemy dla dzierzaw.
 * Starsze wydania go nie maja, wiec spadamy na local.
 */
const sessionArea = wx.storage.session ?? wx.storage.local;

export async function getSession<T>(key: string, fallback: T): Promise<T> {
  const data = await sessionArea.get(key);
  return (data[key] as T | undefined) ?? fallback;
}

export async function setSession(items: Record<string, unknown>): Promise<void> {
  await sessionArea.set(items);
}

// ============================================================
// Dzierzawa (mutex z terminem waznosci)
// ============================================================

interface Lease {
  owner: string;
  expiresAt: number;
}

/**
 * Wykonuje `fn` pod nazwana blokada. Zwraca null, jesli blokada jest zajeta.
 *
 * Kluczowy jest TERMIN WAZNOSCI. v1 miala zwykla flage isImporting — gdy
 * service worker zginal w trakcie importu, flaga zostawala ustawiona i
 * blokowala kolejne proby az do przeladowania rozszerzenia. Dzierzawa wygasa sama.
 */
export async function withLease<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const key = `lease:${name}`;
  const owner = crypto.randomUUID();
  const now = Date.now();

  const current = await getSession<Lease | null>(key, null);
  if (current && current.expiresAt > now) return null;

  await setSession({ [key]: { owner, expiresAt: now + ttlMs } satisfies Lease });

  // Potwierdzenie zwyciestwa: gdyby dwa wybudzenia workera weszly tu jednoczesnie,
  // wygrywa ten, ktorego zapis byl ostatni.
  const confirmed = await getSession<Lease | null>(key, null);
  if (!confirmed || confirmed.owner !== owner) return null;

  // Odnawianie w tle, zeby dluga operacja nie stracila blokady w polowie
  const renew = setInterval(() => {
    void setSession({ [key]: { owner, expiresAt: Date.now() + ttlMs } satisfies Lease });
  }, Math.max(5000, Math.floor(ttlMs / 3)));

  try {
    return await fn();
  } finally {
    clearInterval(renew);
    const held = await getSession<Lease | null>(key, null);
    if (held?.owner === owner) await sessionArea.remove(key);
  }
}

/** Czy trwa operacja pod ta blokada. Uzywane, zeby nie reagowac na wlasne zmiany zakladek. */
export async function isLeaseHeld(name: string): Promise<boolean> {
  const lease = await getSession<Lease | null>(`lease:${name}`, null);
  return !!lease && lease.expiresAt > Date.now();
}

// ============================================================
// Nazwy kluczy — w jednym miejscu, zeby literowka nie stworzyla cichego drugiego stanu
// ============================================================

export const KEYS = {
  server:     'server',      // { url, token, deviceId, profile, generation }
  cursor:     'cursor',      // ostatni seq FAKTYCZNIE zastosowany w przegladarce
  known:      'known',       // stan uzgodniony z serwerem, per id serwerowe
  mapping:    'mapping',     // { s2l, l2s } — id serwerowe <-> id zakladki w przegladarce
  outbox:     'outbox',      // operacje czekajace na potwierdzenie serwera
  settings:   'settings',
  filters:    'filterConfig',
  status:     'syncStatus',
  conflicts:  'conflicts',   // ostatnie konflikty do pokazania uzytkownikowi
  skipped:    'skipped',     // wezly serwera, ktorych ta przegladarka nie potrafi odtworzyc
  brake:      'brake',       // usuniecia wstrzymane przez hamulec bezpieczenstwa
  pending:    'pendingSince',
} as const;

export const LEASE = {
  sync:     'sync',
  applying: 'applying',
  identity: 'identity',
} as const;

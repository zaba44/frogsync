// ============================================================
// Wylacznosc operacji.
//
// Synchronizacja, parowanie, rozlaczanie i potwierdzenia ida przez JEDNA blokade.
// Poprzednia wersja uzywala dzierzawy w storage (odczyt, zapis, ponowny odczyt),
// a Codex pokazal, ze dwa przebiegi potrafia ja przejsc jednoczesnie — a parowanie
// w ogole ja omijalo, wiec konczacy sie stary przebieg mogl nadpisac nowa sesje.
//
// Web Locks API (navigator.locks) jest wylaczne dla calego rozszerzenia, dziala
// w service workerze Chromium i w tle Firefoksa, a blokada znika sama, gdy
// kontekst zginie — nie ma czego "wygaszac".
// ============================================================

interface LockManagerLike {
  request<T>(name: string, options: { ifAvailable?: boolean; mode?: 'exclusive' }, fn: (lock: unknown) => Promise<T>): Promise<T>;
  query?(): Promise<{ held?: { name: string }[] }>;
}

const native = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;

// Zapas na srodowiska bez Web Locks (testy w Node): zwykla kolejka w pamieci
const held = new Set<string>();
const waiting = new Map<string, (() => void)[]>();

async function fallback<T>(name: string, ifAvailable: boolean, fn: () => Promise<T>): Promise<T | null> {
  if (held.has(name)) {
    if (ifAvailable) return null;
    await new Promise<void>(resolve => { const q = waiting.get(name) ?? []; q.push(resolve); waiting.set(name, q); });
  }
  held.add(name);
  try { return await fn(); }
  finally {
    held.delete(name);
    waiting.get(name)?.shift()?.();
  }
}

export const MAIN_LOCK = 'frogsync';
export const APPLY_LOCK = 'frogsync-apply';

/** Czeka na wylacznosc i wykonuje fn. */
export async function exclusive<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (native) return native.request(name, { mode: 'exclusive' }, () => fn());
  return (await fallback(name, false, fn))!;
}

/** Wykonuje fn tylko, jesli blokada jest wolna; inaczej zwraca null. */
export async function ifFree<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  if (native) {
    return native.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => (lock ? fn() : null));
  }
  return fallback(name, true, fn);
}

export async function isHeld(name: string): Promise<boolean> {
  if (native?.query) {
    const state = await native.query();
    return !!state.held?.some(l => l.name === name);
  }
  return held.has(name);
}

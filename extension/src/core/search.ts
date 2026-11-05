// ============================================================
// Wyszukiwarki strony startowej — czysta logika, bez API przegladarki.
//
// Katalog jest na razie wbudowany (dostawa 3.1). Wlasne definicje i lista
// wspolna dla profilu dochodza w 3.2 — ten sam ksztalt SearchEngine.
// ============================================================

export interface SearchEngine {
  id: string;
  name: string;
  /** Szablon HTTPS z dokladnie jednym %s w miejscu zakodowanego zapytania. */
  url: string;
  /** Kolor znaczka przycisku. */
  color: string;
  /** Skad podpowiedzi sieciowe; 'none' = brak. */
  suggest: 'google' | 'none';
}

export const BUILTIN_ENGINES: readonly SearchEngine[] = [
  { id: 'google',    name: 'Google',      url: 'https://www.google.com/search?q=%s',              color: '#1a73e8', suggest: 'google' },
  { id: 'allegro',   name: 'Allegro',     url: 'https://allegro.pl/listing?string=%s',            color: '#ff5a00', suggest: 'none' },
  { id: 'youtube',   name: 'YouTube',     url: 'https://www.youtube.com/results?search_query=%s', color: '#e62117', suggest: 'none' },
  { id: 'maps',      name: 'Mapy',        url: 'https://www.google.com/maps/search/%s',           color: '#34a853', suggest: 'none' },
  { id: 'bing',      name: 'Bing',        url: 'https://www.bing.com/search?q=%s',                color: '#008373', suggest: 'none' },
  { id: 'ddg',       name: 'DuckDuckGo',  url: 'https://duckduckgo.com/?q=%s',                    color: '#de5833', suggest: 'none' },
  { id: 'wikipedia', name: 'Wikipedia',   url: 'https://pl.wikipedia.org/w/index.php?search=%s',  color: '#54595d', suggest: 'none' },
];

/** Wiecej przyciskow zamienia strone w drugi pasek zakladek; reszta jest pod "Wiecej". */
export const MAX_PINNED = 6;
export const DEFAULT_PINNED = ['google', 'allegro', 'youtube', 'maps'];
export const DEFAULT_ENGINE = 'google';

export function engineById(id: string, engines: readonly SearchEngine[] = BUILTIN_ENGINES): SearchEngine | undefined {
  return engines.find(e => e.id === id);
}

export function searchUrl(engine: SearchEngine, query: string): string {
  return engine.url.replace('%s', encodeURIComponent(query.trim()));
}

/**
 * Przypiete przyciski: tylko znane wyszukiwarki, bez powtorzen, najwyzej MAX_PINNED,
 * w kolejnosci ustawionej przez uzytkownika.
 */
export function normalizePinned(ids: readonly string[], engines: readonly SearchEngine[] = BUILTIN_ENGINES): string[] {
  const known = new Set(engines.map(e => e.id));
  const out: string[] = [];
  for (const id of ids) {
    if (known.has(id) && !out.includes(id)) out.push(id);
    if (out.length === MAX_PINNED) break;
  }
  return out;
}

// ---- adres zamiast zapytania ----

const SAFE_SCHEMES = /^(https?|ftp):\/\//i;

/**
 * Czy wpisany tekst to adres strony, a nie zapytanie. Jawny http(s)/ftp albo
 * jednoznaczna nazwa domenowa (z kropka, bez spacji), adres IP lub localhost z portem.
 * Inne schematy (javascript:, data:, file:) nigdy nie sa traktowane jak adres.
 */
export function asAddress(text: string): string | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  if (SAFE_SCHEMES.test(t)) {
    try { return new URL(t).href; } catch { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[\w.-]+:\d+/.test(t)) return null;   // inny schemat
  const host = t.split(/[/?#]/)[0];
  const hostname = host.replace(/:\d+$/, '');
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  const domain = /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(hostname) && !/^\d+(\.\d+)+$/.test(hostname);
  if (!(ipv4 || domain || hostname.toLowerCase() === 'localhost')) return null;
  if (hostname.toLowerCase() === 'localhost' && !/:\d+$/.test(host)) return null;
  try { return new URL('https://' + t).href; } catch { return null; }
}

// ---- podpowiedzi ----

export const GOOGLE_SUGGEST_ORIGIN = 'https://suggestqueries.google.com/*';

export function googleSuggestUrl(query: string): string {
  return 'https://suggestqueries.google.com/complete/search?client=firefox&hl=pl&ie=utf-8&oe=utf-8&q=' +
    encodeURIComponent(query.trim());
}

/** Odpowiedz Google: [zapytanie, [podpowiedzi...], ...]. Cokolwiek innego = brak podpowiedzi. */
export function parseGoogleSuggest(data: unknown, limit = 6): string[] {
  if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
  return data[1].filter((s): s is string => typeof s === 'string' && s.trim() !== '')
    .map(s => s.slice(0, 200)).slice(0, limit);
}

export interface BookmarkHit { title: string; url: string }

export type Suggestion =
  | { kind: 'bookmark'; key: string; title: string; url: string }
  | { kind: 'web'; key: string; text: string };

/** Najpierw zakladki (najwyzej 3), potem podpowiedzi sieciowe (najwyzej 6), bez powtorzen. */
export function mergeSuggestions(query: string, bookmarks: readonly BookmarkHit[], web: readonly string[]): Suggestion[] {
  const out: Suggestion[] = [];
  const seenUrl = new Set<string>();
  for (const b of bookmarks) {
    if (out.length === 3) break;
    if (!/^https?:/i.test(b.url) || seenUrl.has(b.url)) continue;
    seenUrl.add(b.url);
    out.push({ kind: 'bookmark', key: 'b:' + b.url, title: b.title, url: b.url });
  }
  const seenText = new Set([query.trim().toLowerCase()]);
  let webCount = 0;
  for (const w of web) {
    const k = w.trim().toLowerCase();
    if (seenText.has(k) || webCount === 6) continue;
    seenText.add(k);
    out.push({ kind: 'web', key: 'w:' + k, text: w });
    webCount++;
  }
  return out;
}

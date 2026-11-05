// ============================================================
// Import skrotow ze starego projektu Homepage (start_konfiguracja.json).
//
// Formaty eksportu Homepage: { document: { settings, shortcuts } },
// { settings, shortcuts } albo sama tablica skrotow. Skrot: { id, title, url }.
// Czysta logika — bez API przegladarki.
// ============================================================

export interface HomepageShortcut { id: string; title: string; url: string }

const MAX = 500;

export function parseHomepageExport(text: string): HomepageShortcut[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('To nie jest plik JSON ze starej strony startowej.'); }
  if (data && typeof data === 'object' && !Array.isArray(data) && 'document' in data) data = (data as { document: unknown }).document;
  const rows = Array.isArray(data) ? data
    : data && typeof data === 'object' ? (data as { shortcuts?: unknown }).shortcuts : undefined;
  if (!Array.isArray(rows)) throw new Error('Plik nie zawiera skrótów (start_konfiguracja.json ze starej strony startowej).');
  if (rows.length > MAX) throw new Error(`Plik ma więcej niż ${MAX} skrótów.`);

  const out: HomepageShortcut[] = [];
  const ids = new Set<string>();
  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    const r = row as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, 200) : '';
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    let parsed: URL;
    try { parsed = new URL(url); } catch { return; }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
    // Identyfikator z Homepage (UUID) — stabilny, wiec ponowny import rozpoznaje te same skroty
    let id = typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) ? r.id : `hp-${i}`;
    if (ids.has(id)) id = `${id.slice(0, 56)}-${i}`;
    ids.add(id);
    out.push({ id, title: title || parsed.hostname, url });
  });
  if (out.length === 0) throw new Error('W pliku nie ma żadnego skrótu z poprawnym adresem http(s).');
  return out;
}

/**
 * Co jeszcze trzeba dodac do folderu, zeby mial wszystkie skroty z pliku.
 * Liczy wystapienia adresu — celowe powtorzenia z pliku zostaja, a ponowny
 * import (takze przerwany w polowie) nie dubluje juz dodanych.
 */
export function missingShortcuts(shortcuts: readonly HomepageShortcut[], existingUrls: readonly (string | undefined)[]): HomepageShortcut[] {
  const have = new Map<string, number>();
  for (const u of existingUrls) if (u) have.set(u, (have.get(u) ?? 0) + 1);
  const out: HomepageShortcut[] = [];
  for (const s of shortcuts) {
    const n = have.get(s.url) ?? 0;
    if (n > 0) have.set(s.url, n - 1);
    else out.push(s);
  }
  return out;
}

/** Klucz importu: ten sam plik (te same skroty) = ten sam folder docelowy. */
export function importKey(shortcuts: readonly HomepageShortcut[]): string {
  let h = 0;
  for (const id of shortcuts.map(s => s.id).sort()) for (const ch of id + ',') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hp-${h.toString(36)}-${shortcuts.length}`;
}

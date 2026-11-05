export interface BookmarkContent {
  title: string;
  url: string | null;
}

export interface ContentConflict {
  field: 'title' | 'url';
  base: string | null;
  local: string | null;
  remote: string | null;
}

export interface ContentMerge {
  /** Tylko pola, ktore trzeba zapisac w lokalnej przegladarce. */
  changes: { title?: string; url?: string };
  /** Zachowane lokalnie pola wykryje kolejny zwykly diff. */
  preserved: ('title' | 'url')[];
  conflicts: ContentConflict[];
}

/**
 * Porownuje tresc z baza sprzed odpowiedzi serwera.
 * Rozne pola mozna scalic. Konflikt tego samego pola wygrywa serwer,
 * a wynik zawiera pelna odrzucona wartosc do zapisania przed zmiana.
 */
export function mergeContent(
  base: BookmarkContent | undefined,
  local: BookmarkContent,
  remote: BookmarkContent,
  options: { title: boolean; url: boolean; authoritative?: boolean },
): ContentMerge {
  const result: ContentMerge = { changes: {}, preserved: [], conflicts: [] };

  for (const field of ['title', 'url'] as const) {
    if (!options[field]) continue;
    const localValue = local[field];
    const remoteValue = remote[field];
    if (localValue === remoteValue) continue;

    const localChanged = base !== undefined && localValue !== base[field];
    const remoteChanged = base === undefined || remoteValue !== base[field];

    if (!options.authoritative && localChanged && !remoteChanged) {
      result.preserved.push(field);
      continue;
    }

    if (!options.authoritative && base && localChanged && remoteChanged) {
      result.conflicts.push({
        field, base: base[field], local: localValue, remote: remoteValue,
      });
    }

    if (field === 'title') result.changes.title = remoteValue ?? '';
    else result.changes.url = remoteValue ?? '';
  }

  return result;
}

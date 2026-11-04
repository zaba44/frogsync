import { getLocal, setLocal, KEYS } from './storage.js';

// ============================================================
// Filtry eksportu — co NIE ma trafiac do chmury.
//
// KRYTYCZNE: odfiltrowana zakladka jest NIEWIDOCZNA, a nie USUNIETA.
// Silnik synchronizacji nigdy nie wystawia tombstone'a dla klucza, ktory
// wpadl w filtr.
//
// v1 mylila te dwie rzeczy. saveBookmarks() filtrowalo drzewo przed wysylka,
// wiec wykluczone zakladki nie istnialy w chmurze — a importFullSync() kasowal
// lokalnie wszystko, czego w chmurze nie ma. Efekt: kazda wykluczona zakladka
// ginela przy pierwszej automatycznej synchronizacji.
// ============================================================

export interface BuiltinRule {
  id: string;
  label: string;
  source: string;
  type: 'folderName' | 'urlPrefix';
  pattern: string;
  enabledByDefault: boolean;
}

export interface ManualExclusion {
  id: string;
  type: 'folder' | 'url' | 'urlPattern';
  value: string;
  label: string;
}

export interface FilterConfig {
  builtinEnabled: Record<string, boolean>;
  manualExclusions: ManualExclusion[];
}

export const BUILTIN_RULES: BuiltinRule[] = [
  // Adresy wewnetrzne przegladarek — nie da sie ich odtworzyc w innej przegladarce
  { id: 'scheme-chrome',   label: 'chrome://',        source: 'Chromium', type: 'urlPrefix', pattern: 'chrome:',        enabledByDefault: true },
  { id: 'scheme-edge',     label: 'edge://',          source: 'Edge',     type: 'urlPrefix', pattern: 'edge:',          enabledByDefault: true },
  { id: 'scheme-brave',    label: 'brave://',         source: 'Brave',    type: 'urlPrefix', pattern: 'brave:',         enabledByDefault: true },
  { id: 'scheme-opera',    label: 'opera://',         source: 'Opera',    type: 'urlPrefix', pattern: 'opera:',         enabledByDefault: true },
  { id: 'scheme-vivaldi',  label: 'vivaldi://',       source: 'Vivaldi',  type: 'urlPrefix', pattern: 'vivaldi:',       enabledByDefault: true },
  { id: 'scheme-about',    label: 'about:',           source: 'Firefox',  type: 'urlPrefix', pattern: 'about:',         enabledByDefault: true },
  { id: 'scheme-place',    label: 'place: (zapytania Firefoksa)', source: 'Firefox', type: 'urlPrefix', pattern: 'place:', enabledByDefault: true },
  { id: 'scheme-moz',      label: 'moz-extension://', source: 'Firefox',  type: 'urlPrefix', pattern: 'moz-extension:', enabledByDefault: true },
  { id: 'scheme-ext',      label: 'chrome-extension://', source: 'Chromium', type: 'urlPrefix', pattern: 'chrome-extension:', enabledByDefault: true },
  { id: 'scheme-js',       label: 'javascript: (bookmarklety)', source: '—', type: 'urlPrefix', pattern: 'javascript:', enabledByDefault: false },
  { id: 'scheme-data',     label: 'data:',            source: '—',        type: 'urlPrefix', pattern: 'data:',          enabledByDefault: true },

  // Foldery specyficzne dla przegladarki — przenoszenie ich miesza bardziej niz pomaga
  { id: 'folder-pinboard', label: 'Pinboard',                source: 'Opera',   type: 'folderName', pattern: 'pinboard',                 enabledByDefault: true },
  { id: 'folder-speed',    label: 'Speed Dials',             source: 'Opera',   type: 'folderName', pattern: 'speed dials',              enabledByDefault: true },
  { id: 'folder-unsync',   label: 'Unsynchronized Pinboard', source: 'Opera',   type: 'folderName', pattern: 'unsynchronized pinboard',  enabledByDefault: true },
  { id: 'folder-trash-pl', label: 'Kosz',                    source: 'Opera',   type: 'folderName', pattern: 'kosz',                     enabledByDefault: true },
  { id: 'folder-trash-en', label: 'Trash',                   source: 'Opera',   type: 'folderName', pattern: 'trash',                    enabledByDefault: true },
];

export function defaultFilterConfig(): FilterConfig {
  const builtinEnabled: Record<string, boolean> = {};
  for (const rule of BUILTIN_RULES) builtinEnabled[rule.id] = rule.enabledByDefault;
  return { builtinEnabled, manualExclusions: [] };
}

export async function loadFilterConfig(): Promise<FilterConfig> {
  const stored = await getLocal<FilterConfig | null>(KEYS.filters, null);
  if (!stored) return defaultFilterConfig();

  // Uzupelniamy o reguly dodane w nowszych wersjach, zeby zapisana konfiguracja
  // nie zamrazala listy na zawsze.
  const merged = defaultFilterConfig();
  merged.manualExclusions = stored.manualExclusions ?? [];
  for (const [id, enabled] of Object.entries(stored.builtinEnabled ?? {})) {
    if (id in merged.builtinEnabled) merged.builtinEnabled[id] = enabled;
  }
  return merged;
}

export async function saveFilterConfig(config: FilterConfig): Promise<void> {
  await setLocal({ [KEYS.filters]: config });
}

// ============================================================
// Sprawdzanie
// ============================================================

export interface FilterMatcher {
  isUrlExcluded(url: string): boolean;
  isFolderExcluded(title: string, nodeId: string): boolean;
}

/** Kompiluje konfiguracje raz, zamiast przechodzic tablice regul dla kazdej zakladki. */
export function compileFilters(config: FilterConfig): FilterMatcher {
  const urlPrefixes = BUILTIN_RULES
    .filter(r => r.type === 'urlPrefix' && config.builtinEnabled[r.id] !== false)
    .map(r => r.pattern);

  const folderNames = new Set(
    BUILTIN_RULES
      .filter(r => r.type === 'folderName' && config.builtinEnabled[r.id] !== false)
      .map(r => r.pattern),
  );

  const manualUrls    = new Set<string>();
  const manualFolders = new Set<string>();
  const manualRegexes: RegExp[] = [];

  for (const exclusion of config.manualExclusions) {
    if (exclusion.type === 'url')        manualUrls.add(exclusion.value);
    else if (exclusion.type === 'folder') manualFolders.add(exclusion.value);
    else if (exclusion.type === 'urlPattern') {
      try { manualRegexes.push(wildcardToRegex(exclusion.value)); } catch { /* zly wzorzec ignorujemy */ }
    }
  }

  return {
    isUrlExcluded(url: string): boolean {
      const lower = url.toLowerCase();
      for (const prefix of urlPrefixes) if (lower.startsWith(prefix)) return true;
      if (manualUrls.has(url)) return true;
      for (const regex of manualRegexes) if (regex.test(url)) return true;
      return false;
    },
    isFolderExcluded(title: string, nodeId: string): boolean {
      if (manualFolders.has(nodeId)) return true;
      return folderNames.has(title.toLowerCase().trim());
    },
  };
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

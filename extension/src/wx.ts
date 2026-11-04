// ============================================================
// Typowany dostep do API przegladarki.
//
// Bez webextension-polyfill: Firefox wystawia `browser` z obietnicami,
// a Chrome zwraca obietnice z `chrome.*`, gdy nie podac callbacku.
// Deklarujemy dokladnie to, czego uzywamy — literowka w nazwie API
// jest bledem kompilacji, a nie awaria w locie.
// ============================================================

export interface WxBookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  /** Firefox: 'bookmark' | 'folder' | 'separator'. Chromium nie ma tego pola i nie zna separatorow. */
  type?: 'bookmark' | 'folder' | 'separator';
  dateAdded?: number;
  /** Chromium: 'managed' dla zakladek narzuconych polityka — tylko do odczytu. */
  unmodifiable?: string;
  children?: WxBookmarkNode[];
}

export interface WxAlarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

interface WxStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface WxEvent<T extends (...args: never[]) => unknown> {
  addListener(fn: T): void;
  removeListener?(fn: T): void;
}

interface WxApi {
  runtime: {
    id: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    getBrowserInfo?(): Promise<{ name: string; vendor: string; version: string }>;
    openOptionsPage(): Promise<void>;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: WxEvent<(message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void>;
    onInstalled: WxEvent<(details: { reason: string }) => void>;
    onStartup: WxEvent<() => void>;
  };
  storage: {
    local: WxStorageArea;
    session?: WxStorageArea;
  };
  bookmarks: {
    getTree(): Promise<WxBookmarkNode[]>;
    get(id: string): Promise<WxBookmarkNode[]>;
    getChildren(id: string): Promise<WxBookmarkNode[]>;
    create(item: { parentId?: string; title?: string; url?: string; index?: number; type?: 'bookmark' | 'folder' | 'separator' }): Promise<WxBookmarkNode>;
    update(id: string, changes: { title?: string; url?: string }): Promise<WxBookmarkNode>;
    move(id: string, destination: { parentId?: string; index?: number }): Promise<WxBookmarkNode>;
    remove(id: string): Promise<void>;
    removeTree(id: string): Promise<void>;
    onCreated: WxEvent<(...args: never[]) => void>;
    onRemoved: WxEvent<(...args: never[]) => void>;
    onChanged: WxEvent<(...args: never[]) => void>;
    onMoved: WxEvent<(...args: never[]) => void>;
    onChildrenReordered?: WxEvent<(...args: never[]) => void>;
    onImportEnded?: WxEvent<(...args: never[]) => void>;
  };
  alarms: {
    create(name: string, info: { delayInMinutes?: number; periodInMinutes?: number }): void;
    get(name: string): Promise<WxAlarm | undefined>;
    clear(name: string): Promise<boolean>;
    onAlarm: WxEvent<(alarm: WxAlarm) => void>;
  };
  action: {
    setIcon(details: { path?: Record<string, string> }): Promise<void>;
    setTitle(details: { title: string }): Promise<void>;
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  };
  tabs: {
    create(props: { url?: string; active?: boolean }): Promise<unknown>;
  };
  permissions: {
    contains(perms: { origins?: string[] }): Promise<boolean>;
    request(perms: { origins?: string[] }): Promise<boolean>;
  };
}

const globalAny = globalThis as unknown as { browser?: WxApi; chrome?: WxApi };

export const wx: WxApi = (globalAny.browser ?? globalAny.chrome)!;

/** Gecko wystawia runtime.getBrowserInfo; Chromium nie. Najprostszy pewny test silnika. */
export function isGecko(): boolean { return typeof wx?.runtime?.getBrowserInfo === 'function'; }

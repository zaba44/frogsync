// ============================================================
// Atrapa srodowiska WebExtension dla testu end-to-end.
//
// MUSI byc zaimportowana PRZED kodem wtyczki â€” wx.ts odczytuje
// globalThis.browser przy inicjalizacji modulu.
//
// Podmieniona jest wylacznie przegladarka. Silnik, klient HTTP i filtry to
// kod z paczki, a po drugiej stronie stoi prawdziwy serwer FrogSync.
//
// Atrapa odwzorowuje dwie roznice, na ktorych latwo sie poslizgnac:
//  - Chromium liczy indeks move() wzgledem listy SPRZED wyjecia elementu,
//  - Chromium nie zna separatorow i nie ma menu zakladek.
// ============================================================

export type Engine = 'gecko' | 'chromium';

interface Node {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  type: 'bookmark' | 'folder' | 'separator';
  dateAdded: number;
  unmodifiable?: string;
  children?: Node[];
}

/** Udaje ubicie wtyczki przez przegladarke w polowie pracy. */
export class SimulatedCrash extends Error {}

class FakeBookmarks {
  private readonly nodes = new Map<string, Node>();
  private next = 100;
  /** Ile kolejnych utworzen zakladek ma sie nie udac â€” symulacja chwilowego bledu przegladarki. */
  failNextCreates = 0;
  /** Ile kolejnych przesuniec ma sie nie udac. */
  failNextMoves = 0;
  /** Po tylu kolejnych zmianach drzewa "przegladarka ubija wtyczke". */
  crashAfter = -1;
  /** API zapisuje zakladke, ale worker nie dostaje odpowiedzi z jej ID. */
  loseNextBookmarkCreateReply = false;

  private mutation() {
    if (this.crashAfter === 0) { this.crashAfter = -1; throw new SimulatedCrash('ubicie wtyczki'); }
    if (this.crashAfter > 0) this.crashAfter--;
  }

  /** Folder zarzadzany polityka (zakladki firmowe w Chromium) â€” tylko do odczytu. */
  addManaged(title: string, urls: string[]) {
    const root = this.root();
    const folder: Node = { id: String(this.next++), parentId: root.id, title, type: 'folder', dateAdded: 0, unmodifiable: 'managed', children: [] };
    this.nodes.set(folder.id, folder);
    root.children!.push(folder);
    for (const url of urls) {
      const n: Node = { id: String(this.next++), parentId: folder.id, title: url, url, type: 'bookmark', dateAdded: 0, unmodifiable: 'managed' };
      this.nodes.set(n.id, n);
      folder.children!.push(n);
    }
    return folder.id;
  }

  constructor(readonly engine: Engine) {
    const root: Node = { id: engine === 'gecko' ? 'root________' : '0', title: '', type: 'folder', dateAdded: 0, children: [] };
    this.nodes.set(root.id, root);
    const specials = engine === 'gecko'
      ? [['menu________', 'Menu zakĹ‚adek'], ['toolbar_____', 'Pasek zakĹ‚adek'], ['unfiled_____', 'Inne zakĹ‚adki'], ['mobile______', 'ZakĹ‚adki z telefonu']]
      : [['1', 'Pasek zakĹ‚adek'], ['2', 'Inne zakĹ‚adki'], ['3', 'ZakĹ‚adki na telefonie']];
    for (const [id, title] of specials) {
      const node: Node = { id, parentId: root.id, title, type: 'folder', dateAdded: 0, children: [] };
      this.nodes.set(id, node);
      root.children!.push(node);
    }
  }

  get toolbar() { return this.engine === 'gecko' ? 'toolbar_____' : '1'; }
  get other() { return this.engine === 'gecko' ? 'unfiled_____' : '2'; }

  getTree(): Node[] { return [this.clone(this.root())]; }
  get(id: string): Node[] { const n = this.must(id); return [this.shallow(n)]; }
  getChildren(id: string): Node[] { return (this.must(id).children ?? []).map(c => this.shallow(c)); }

  create(p: { parentId?: string; title?: string; url?: string; index?: number; type?: string }): Node {
    this.mutation();
    const parent = this.must(p.parentId ?? this.other);
    const type = (p.type ?? (p.url !== undefined ? 'bookmark' : 'folder')) as Node['type'];
    if (type === 'separator' && this.engine === 'chromium') throw new Error('Chromium nie zna separatorow');
    if (type === 'bookmark') {
      if (this.failNextCreates > 0) { this.failNextCreates--; throw new Error('Symulowany blad przegladarki'); }
      if (this.engine === 'gecko' && /^chrome:/i.test(p.url ?? '')) throw new Error('Invalid URL');
      if (this.engine === 'chromium' && /^(place|about):/i.test(p.url ?? '')) throw new Error('Invalid URL');
    }
    const node: Node = { id: String(this.next++), parentId: parent.id, title: type === 'separator' ? '' : (p.title ?? ''),
      url: type === 'bookmark' ? p.url : undefined, type, dateAdded: Date.now(), children: type === 'folder' ? [] : undefined };
    this.nodes.set(node.id, node);
    const at = p.index ?? parent.children!.length;
    parent.children!.splice(Math.min(at, parent.children!.length), 0, node);
    if (type === 'bookmark' && this.loseNextBookmarkCreateReply) {
      this.loseNextBookmarkCreateReply = false;
      throw new SimulatedCrash('utracona odpowiedz po zapisie zakladki');
    }
    return this.shallow(node);
  }

  update(id: string, c: { title?: string; url?: string }): Node {
    this.mutation();
    const n = this.must(id);
    if (c.title !== undefined) n.title = c.title;
    if (c.url !== undefined) n.url = c.url;
    return this.shallow(n);
  }

  move(id: string, d: { parentId?: string; index?: number }): Node {
    this.mutation();
    if (this.failNextMoves > 0) { this.failNextMoves--; throw new Error('Symulowany blad przesuniecia'); }
    const n = this.must(id);
    const from = this.must(n.parentId!);
    const to = this.must(d.parentId ?? n.parentId!);
    const oldIndex = from.children!.indexOf(n);
    let index = d.index ?? to.children!.length;
    // BookmarkModel::Move w Chromium: przy przesuwaniu w dol w tym samym folderze
    // indeks jest liczony sprzed wyjecia elementu
    if (this.engine === 'chromium' && from === to && index > oldIndex) index--;
    from.children!.splice(oldIndex, 1);
    to.children!.splice(Math.min(index, to.children!.length), 0, n);
    n.parentId = to.id;
    return this.shallow(n);
  }

  /** Opera: usuniecie przenosi wpis (z tym samym id) do folderu Kosz w "Inne zakladki". */
  operaTrash = false;

  remove(id: string): void {
    this.mutation();
    const n = this.must(id);
    if (n.children?.length) throw new Error('Folder nie jest pusty');
    if (this.operaTrash) { this.moveToTrash(n); return; }
    this.removeTree(id);
  }

  private moveToTrash(n: Node): void {
    // Jak w prawdziwej Operze: Kosz jest korzeniem obok "Inne zakladki", nie jego podfolderem
    const other = this.root();
    let trash = other.children!.find(c => c.type === 'folder' && c.title === 'Kosz');
    if (!trash) {
      trash = { id: String(this.next++), parentId: other.id, title: 'Kosz', type: 'folder', dateAdded: Date.now(), children: [] };
      this.nodes.set(trash.id, trash); other.children!.push(trash);
    }
    if (n.parentId === trash.id) { this.removeTree(n.id); return; }
    const from = this.must(n.parentId!);
    from.children!.splice(from.children!.indexOf(n), 1);
    trash.children!.push(n); n.parentId = trash.id;
  }

  removeTree(id: string): void {
    if (this.operaTrash && this.must(id).parentId !== this.find('Kosz')?.id) { const n = this.must(id); this.moveToTrash(n); return; }
    const n = this.must(id);
    const parent = this.must(n.parentId!);
    parent.children!.splice(parent.children!.indexOf(n), 1);
    const drop = (x: Node) => { this.nodes.delete(x.id); x.children?.forEach(drop); };
    drop(n);
  }

  // ---- pomocniki testowe ----

  /** Dzieci folderu jako "tytul" (separator = "---"), do czytelnych porownan. */
  titles(folderId: string): string[] {
    return (this.must(folderId).children ?? []).map(c => c.type === 'separator' ? '---' : c.title);
  }
  find(title: string): Node | undefined { return [...this.nodes.values()].find(n => n.title === title); }
  findAll(predicate: (n: Node) => boolean): Node[] { return [...this.nodes.values()].filter(predicate); }
  bookmarkCount(): number { return [...this.nodes.values()].filter(n => n.type === 'bookmark').length; }

  private root() { return this.nodes.get(this.engine === 'gecko' ? 'root________' : '0')!; }
  private must(id: string): Node { const n = this.nodes.get(id); if (!n) throw new Error(`Brak wezla ${id}`); return n; }

  private shallow(n: Node): Node {
    const copy: Node = { id: n.id, parentId: n.parentId, title: n.title, url: n.url, type: n.type, dateAdded: n.dateAdded };
    if (n.unmodifiable) copy.unmodifiable = n.unmodifiable;
    if (this.engine === 'chromium') delete (copy as Partial<Node>).type;   // Chromium nie ma pola type
    return copy;
  }
  private clone(n: Node): Node {
    const c = this.shallow(n);
    if (n.children) c.children = n.children.map(x => this.clone(x));
    return c;
  }
}

class FakeArea {
  private readonly data = new Map<string, string>();
  async get(keys?: string | string[] | null) {
    const wanted = keys == null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of wanted) { const v = this.data.get(k); if (v !== undefined) out[k] = JSON.parse(v); }
    return out;
  }
  async set(items: Record<string, unknown>) { for (const [k, v] of Object.entries(items)) this.data.set(k, JSON.stringify(v)); }
  async remove(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k); }
}

export class FakeDevice {
  extensionVersion = '0.3.1';
  readonly bookmarks: FakeBookmarks;
  readonly local = new FakeArea();
  readonly session = new FakeArea();
  constructor(readonly name: string, readonly engine: Engine) { this.bookmarks = new FakeBookmarks(engine); }
}

let current = new FakeDevice('start', 'gecko');
export function use(device: FakeDevice) { current = device; }

const noop = async () => {};
const listener = { addListener() {}, removeListener() {} };

(globalThis as Record<string, unknown>).browser = {
  runtime: {
    id: 'e2e',
    getURL: (p: string) => p,
    getManifest: () => ({ version: current.extensionVersion }),
    // Obecnosc getBrowserInfo = Gecko; wx.isGecko() sprawdza to przy kazdym wywolaniu
    get getBrowserInfo() {
      return current.engine === 'gecko' ? async () => ({ name: 'Firefox', vendor: 'Mozilla', version: '140.0' }) : undefined;
    },
    openOptionsPage: noop, sendMessage: noop,
    onMessage: listener, onInstalled: listener, onStartup: listener,
  },
  storage: {
    local:   { get: (k?: never) => current.local.get(k),   set: (i: never) => current.local.set(i),   remove: (k: never) => current.local.remove(k) },
    session: { get: (k?: never) => current.session.get(k), set: (i: never) => current.session.set(i), remove: (k: never) => current.session.remove(k) },
  },
  bookmarks: {
    getTree:     async () => current.bookmarks.getTree(),
    get:         async (id: string) => current.bookmarks.get(id),
    getChildren: async (id: string) => current.bookmarks.getChildren(id),
    create:      async (p: never) => current.bookmarks.create(p),
    update:      async (id: string, c: never) => current.bookmarks.update(id, c),
    move:        async (id: string, d: never) => current.bookmarks.move(id, d),
    remove:      async (id: string) => current.bookmarks.remove(id),
    removeTree:  async (id: string) => current.bookmarks.removeTree(id),
    onCreated: listener, onRemoved: listener, onChanged: listener, onMoved: listener,
    onChildrenReordered: listener, onImportEnded: listener,
  },
  alarms: { create() {}, get: async () => undefined, clear: async () => true, onAlarm: listener },
  action: { setIcon: noop, setTitle: noop, setBadgeText: noop, setBadgeBackgroundColor: noop },
  tabs: { create: noop },
  permissions: { contains: async () => true, request: async () => true },
};

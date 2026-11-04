// ============================================================
// Wykrywanie lokalnych zmian — czysta funkcja, bez API przegladarki.
//
// Model STANOWY: porownujemy biezace drzewo przegladarki ze stanem ostatnio
// uzgodnionym z serwerem (known). Zdarzenia przegladarki sluza tylko jako
// sygnal "sprawdz teraz" — nie musimy ich odbierac, wiec ubity service worker,
// zgubione zdarzenie albo import tysiaca zakladek naraz niczego nie psuja.
//
// diff() wolamy wylacznie przy pustej kolejce wyslania (outbox), wiec known
// odpowiada stanowi potwierdzonemu przez serwer.
// ============================================================

export type Kind = 'folder' | 'bookmark' | 'separator';

export interface LocalNode {
  id: string;
  parentId?: string;
  kind: Kind | 'root';
  title: string;
  url?: string;
  /** Dzieci w kolejnosci przegladarki. */
  children?: LocalNode[];
}

export interface KnownNode {
  id: string;
  parentId: string | null;
  kind: Kind | 'root';
  title: string;
  url: string | null;
  order: string;
  version: number;
}

export interface Mapping {
  s2l: Record<string, string>;
  l2s: Record<string, string>;
}

export interface PlannedOp {
  clientOpId: string;
  type: 'create' | 'update' | 'move' | 'delete';
  nodeId: string;
  kind?: Kind;
  parentId?: string;
  title?: string;
  url?: string;
  afterId?: string | null;
  beforeId?: string | null;
  baseVersion?: number;
  baseSeq?: number;
  force?: boolean;
}

export interface DiffInput {
  /** Dzieci korzenia przegladarki (getTree()[0].children). */
  roots: LocalNode[];
  known: Record<string, KnownNode>;
  mapping: Mapping;
  /** Wykluczony wezel i jego poddrzewo sa NIEWIDOCZNE — nie tworzymy ich i nie kasujemy. */
  isExcluded(node: LocalNode, folderPath: string[]): boolean;
  newId(): string;
  newOpId(): string;
  /** Kursor wtyczki — baseSeq dla usuniec folderow. */
  cursor: number;
}

export interface DiffOutput {
  ops: PlannedOp[];
  newMappings: { serverId: string; localId: string }[];
}

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function diff(input: DiffInput): DiffOutput {
  const { known, mapping } = input;
  const ops: PlannedOp[] = [];
  const newMappings: { serverId: string; localId: string }[] = [];
  const l2s = { ...mapping.l2s };

  // Wszystkie lokalne id obecne w drzewie — do wykrywania usuniec.
  // Wezel obecny, ale wykluczony albo pod niezmapowanym korzeniem, NIE jest usuniety.
  const presentLocal = new Set<string>();
  const collect = (n: LocalNode) => { presentLocal.add(n.id); n.children?.forEach(collect); };
  input.roots.forEach(collect);

  // Dzieci w known, pogrupowane po rodzicu i posortowane wg klucza kolejnosci
  const knownChildren = new Map<string, KnownNode[]>();
  for (const node of Object.values(known)) {
    if (!node.parentId) continue;
    const list = knownChildren.get(node.parentId) ?? [];
    list.push(node);
    knownChildren.set(node.parentId, list);
  }
  for (const list of knownChildren.values()) list.sort((a, b) => ordinal(a.order, b.order));

  // Zsynchronizowane wezly, ktore uzytkownik PRZENIOSL do wykluczonego folderu.
  // To swiadoma decyzja co do konkretnego wpisu (Opera tak wlasnie "usuwa" — przenosi
  // do Kosza), wiec traktujemy ja jak usuniecie: przegladarki maja wygladac 1:1.
  // Wezel, ktory przestal byc widoczny przez zmiane reguly filtra albo nazwy
  // folderu, NIE jest przenoszony — zostaje tylko ukryty, zeby jedno klikniecie
  // w ustawieniach nie wykasowalo czegos ze wszystkich komputerow.
  const movedIntoExcluded = new Set<string>();
  const scanExcluded = (node: LocalNode, parentId: string | undefined, path: string[]) => {
    const sid = l2s[node.id];
    const k = sid ? known[sid] : undefined;
    if (k && k.kind !== 'root' && !input.isExcluded(node, path)) {
      const currentParent = parentId ? l2s[parentId] : undefined;
      if (currentParent !== k.parentId) movedIntoExcluded.add(sid!);
    }
    for (const child of node.children ?? []) scanExcluded(child, node.id, [...path, node.title]);
  };

  const visitFolder = (local: LocalNode, serverId: string, path: string[]) => {
    const synced: LocalNode[] = [];
    for (const child of local.children ?? []) {
      if (!input.isExcluded(child, path)) { synced.push(child); continue; }
      for (const grandchild of child.children ?? []) scanExcluded(grandchild, child.id, [...path, child.title]);
    }

    // Najpierw nadajemy id wszystkim nowym dzieciom, zeby kotwica beforeId
    // mogla wskazywac takze na wezel, ktory dopiero powstanie
    for (const child of synced) {
      if (!l2s[child.id]) {
        const id = input.newId();
        l2s[child.id] = id;
        newMappings.push({ serverId: id, localId: child.id });
      }
    }

    const sids = synced.map(child => l2s[child.id]);

    // Ktore dzieci musza dostac nowe miejsce: nowe, przeniesione z innego folderu
    // i te, ktore wypadly z najdluzszego zachowanego ciagu kolejnosci (LIS)
    const rank = new Map<string, number>();
    (knownChildren.get(serverId) ?? []).forEach((k, i) => rank.set(k.id, i));

    const stayers: number[] = [];   // indeksy w `synced` wezlow, ktore juz byly w tym folderze
    for (let i = 0; i < synced.length; i++) {
      const k = known[sids[i]];
      if (k && k.parentId === serverId && rank.has(sids[i])) stayers.push(i);
    }
    const keep = new Set(longestIncreasing(stayers.map(i => rank.get(sids[i])!)).map(j => stayers[j]));

    for (let i = 0; i < synced.length; i++) {
      const child = synced[i];
      const sid = sids[i];
      const k = known[sid];
      // afterId jest kotwica pewna: przetwarzamy od lewej, wiec poprzednik juz stoi
      // na swoim miejscu. beforeId to tylko zapas na wypadek, gdyby poprzednika
      // ktos w miedzyczasie usunal — dla pierwszej pozycji go NIE wysylamy, bo
      // nastepny sasiad moze jeszcze stac w innym folderze, a "afterId: null"
      // jednoznacznie znaczy "na poczatek".
      const afterId = i > 0 ? sids[i - 1] : null;
      const beforeId = afterId !== null && i + 1 < sids.length ? sids[i + 1] : null;

      if (!k) {
        // Nowy wezel (albo zmapowany, ale nigdy niepotwierdzony — wysylamy jeszcze raz;
        // serwer zwroci "exists", jesli jednak powstal)
        const op: PlannedOp = {
          clientOpId: input.newOpId(), type: 'create', nodeId: sid,
          kind: child.kind as Kind, parentId: serverId, afterId, beforeId,
        };
        if (child.kind !== 'separator') op.title = child.title;
        if (child.kind === 'bookmark') op.url = child.url ?? '';
        ops.push(op);
      } else {
        if (child.kind !== 'root') {
          const update: PlannedOp = { clientOpId: '', type: 'update', nodeId: sid, baseVersion: k.version };
          let changed = false;
          if (child.kind !== 'separator' && child.title !== k.title) { update.title = child.title; changed = true; }
          if (child.kind === 'bookmark' && (child.url ?? null) !== k.url) { update.url = child.url ?? ''; changed = true; }
          if (changed) { update.clientOpId = input.newOpId(); ops.push(update); }
        }

        const moved = k.parentId !== serverId;
        if (moved || !keep.has(i)) {
          ops.push({
            clientOpId: input.newOpId(), type: 'move', nodeId: sid,
            parentId: serverId, afterId, beforeId, baseVersion: k.version,
          });
        }
      }

      if (child.kind === 'folder') visitFolder(child, sid, [...path, child.title]);
    }
  };

  for (const root of input.roots) {
    const serverId = mapping.l2s[root.id];
    if (serverId) visitFolder(root, serverId, []);
    // Niezmapowany korzen (np. Kosz w Operze — osobny korzen obok "Inne zakladki"):
    // zsynchronizowany wpis, ktory tam trafil, zostal wyniesiony z synchronizacji
    // swiadomie, tak jak przy przeniesieniu do wykluczonego folderu
    else for (const child of root.children ?? []) scanExcluded(child, root.id, [root.title]);
  }

  // Zmapowane wezly, ktorych nie ma w drzewie — usuniete przez uzytkownika.
  // Wysylamy tylko najwyzszego brakujacego przodka; potomkow serwer kasuje kaskadowo.
  const missing = new Set<string>();
  for (const [sid, lid] of Object.entries(mapping.s2l)) {
    const k = known[sid];
    if (!k || k.kind === 'root') continue;
    if (!presentLocal.has(lid) || movedIntoExcluded.has(sid)) missing.add(sid);
  }
  for (const sid of [...missing].sort()) {
    const k = known[sid];
    if (k.parentId && missing.has(k.parentId)) continue;
    const op: PlannedOp = { clientOpId: input.newOpId(), type: 'delete', nodeId: sid, baseVersion: k.version };
    if (k.kind === 'folder') op.baseSeq = input.cursor;
    ops.push(op);
  }

  return { ops, newMappings };
}

/** Indeksy elementow najdluzszego scisle rosnacego podciagu (O(n log n)). */
export function longestIncreasing(values: number[]): number[] {
  const tails: number[] = [];          // indeks konca podciagu o dlugosci i+1
  const previous = new Array<number>(values.length).fill(-1);

  for (let i = 0; i < values.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1];
    tails[lo] = i;
  }

  const result: number[] = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) result.push(i);
  return result.reverse();
}

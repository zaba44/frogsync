import type { Kind, LocalNode } from './diff.js';
import { planReorder } from './reorder.js';

export const RESTORE_ROOTS = [
  'root:toolbar',
  'root:menu',
  'root:unsorted',
  'root:mobile',
] as const;

export type RestoreRoot = (typeof RESTORE_ROOTS)[number];

export type RestoreNode =
  | { kind: 'folder'; title: string; children: RestoreNode[] }
  | { kind: 'bookmark'; title: string; url: string }
  | { kind: 'separator'; title: '' };

export type RestoreTree = Record<RestoreRoot, RestoreNode[]>;

export function emptyRestoreTree(): RestoreTree {
  return { 'root:toolbar': [], 'root:menu': [], 'root:unsorted': [], 'root:mobile': [] };
}

export interface RestoreInput {
  tree: RestoreTree;
  roots: Partial<Record<RestoreRoot, LocalNode>>;
  /** Wezel i cale poddrzewo maja pozostac na miejscu. */
  protect(node: LocalNode): boolean;
  /** HTML nie ma lokalnych ID, wiec tu pasuja tylko reguly niezalezne od ID. */
  excludeImport(node: RestoreNode): boolean;
}

export type RestoreParent =
  | { root: RestoreRoot }
  | { entry: number };

export interface RestoreEntry {
  /** Id w planie, niezalezne od id przegladarki. */
  key: number;
  parent: RestoreParent;
  node: RestoreNode;
  localId?: string;
  update: boolean;
  reparent: boolean;
}

export interface RestorePlan {
  /** Rodzic zawsze wystepuje przed dzieckiem. */
  entries: RestoreEntry[];
  /** Usuwanie od lisci, dopiero po przeniesieniu zachowanych potomkow. */
  remove: { localId: string; kind: Kind }[];
  /** Folder zawiera chroniony wpis i nie mozna go usunac bez naruszenia filtra. */
  blockedFolders: string[];
  /** Podsumowanie liczy wezly, w tym foldery i separatory. */
  counts: { remove: number; move: number; update: number; create: number };
}

interface LocalEntry {
  node: LocalNode;
  parentId: string;
  path: string;
  depth: number;
  containsProtected: boolean;
}

interface TargetEntry {
  entry: RestoreEntry;
  path: string;
}

const pathKey = (root: RestoreRoot, folders: string[]) => JSON.stringify([root, ...folders]);

export function planRestore(input: RestoreInput): RestorePlan {
  const locals: LocalEntry[] = [];
  const targets: TargetEntry[] = [];
  const childrenByLocalParent = new Map<string, string[]>();

  function readLocal(parent: LocalNode, root: RestoreRoot, folders: string[]): boolean {
    childrenByLocalParent.set(parent.id, (parent.children ?? []).map(c => c.id));
    let containsProtected = false;
    for (const node of parent.children ?? []) {
      if (node.kind === 'root' || input.protect(node)) {
        containsProtected = true;
        continue;
      }

      const local: LocalEntry = {
        node, parentId: parent.id, path: pathKey(root, folders),
        depth: folders.length, containsProtected: false,
      };
      locals.push(local);

      if (node.kind === 'folder') {
        local.containsProtected = readLocal(node, root, [...folders, node.title]);
        containsProtected ||= local.containsProtected;
      }
    }
    return containsProtected;
  }

  function readTarget(nodes: RestoreNode[], root: RestoreRoot, parent: RestoreParent, folders: string[]): void {
    for (const node of nodes) {
      if (input.excludeImport(node)) continue;
      const key = targets.length;
      targets.push({
        entry: { key, parent, node, update: false, reparent: false },
        path: pathKey(root, folders),
      });
      if (node.kind === 'folder') {
        readTarget(node.children, root, { entry: key }, [...folders, node.title]);
      }
    }
  }

  for (const root of RESTORE_ROOTS) {
    const local = input.roots[root];
    if (local) readLocal(local, root, []);
    readTarget(input.tree[root], root, { root }, []);
  }

  const used = new Set<string>();
  const matches = new Map<number, LocalEntry>();

  function match(
    predicate: (target: TargetEntry, local: LocalEntry) => boolean,
    unique = false,
  ): void {
    for (const target of targets) {
      if (matches.has(target.entry.key)) continue;

      const candidates = locals.filter(local => !used.has(local.node.id) && predicate(target, local));
      if (candidates.length === 0 || (unique && candidates.length !== 1)) continue;

      const local = candidates[0];
      if (unique) {
        const competing = targets.filter(other =>
          !matches.has(other.entry.key) && predicate(other, local));
        if (competing.length !== 1) continue;
      }

      used.add(local.node.id);
      matches.set(target.entry.key, local);
    }
  }

  function sameBookmark(target: TargetEntry, local: LocalEntry): boolean {
    const desired = target.entry.node;
    return desired.kind === 'bookmark' && local.node.kind === 'bookmark' &&
      desired.url === local.node.url && desired.title === local.node.title;
  }

  // Przejscia globalne: slabsze dopasowanie nie zabiera wpisu dokladniejszej parze.
  match((target, local) => target.path === local.path && sameBookmark(target, local));
  match(sameBookmark);
  match((target, local) => target.entry.node.kind === 'bookmark' &&
    local.node.kind === 'bookmark' && target.entry.node.url === local.node.url, true);
  match((target, local) => target.path === local.path &&
    target.entry.node.kind === 'folder' && local.node.kind === 'folder' &&
    target.entry.node.title === local.node.title);
  match((target, local) => target.entry.node.kind === 'folder' &&
    local.node.kind === 'folder' && !local.containsProtected &&
    target.entry.node.title === local.node.title, true);
  match((target, local) => target.path === local.path &&
    target.entry.node.kind === 'separator' && local.node.kind === 'separator');

  const sameParent = new Map<string, string[]>();
  const blocked = new Set<string>();

  for (const target of targets) {
    const { entry } = target;
    const local = matches.get(entry.key);
    if (!local) continue;

    entry.localId = local.node.id;
    entry.update = entry.node.kind === 'bookmark' &&
      (entry.node.title !== local.node.title || entry.node.url !== local.node.url);

    const parentId = 'root' in entry.parent
      ? input.roots[entry.parent.root]?.id
      : matches.get(entry.parent.entry)?.node.id;

    entry.reparent = parentId !== local.parentId;
    if (local.containsProtected && entry.reparent) blocked.add(local.node.id);
    if (!entry.reparent) {
      const order = sameParent.get(local.parentId) ?? [];
      order.push(local.node.id);
      sameParent.set(local.parentId, order);
    }
  }

  const removed = locals.filter(local => !used.has(local.node.id));
  for (const local of removed) {
    if (local.containsProtected) blocked.add(local.node.id);
  }

  const entries = targets.map(t => t.entry);
  const remove = removed
    .filter(local => !local.containsProtected && local.node.kind !== 'root')
    .sort((a, b) => b.depth - a.depth)
    .map(local => ({ localId: local.node.id, kind: local.node.kind as Kind }));

  let reorder = 0;
  for (const [parentId, desired] of sameParent) {
    reorder += planReorder(childrenByLocalParent.get(parentId) ?? [], desired).length;
  }

  return {
    entries,
    remove,
    blockedFolders: [...blocked],
    counts: {
      remove: remove.length,
      move: entries.filter(entry => entry.reparent).length + reorder,
      update: entries.filter(entry => entry.update).length,
      create: entries.filter(entry => entry.localId === undefined).length,
    },
  };
}

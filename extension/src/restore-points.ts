import { emptyRestoreTree, RESTORE_ROOTS, type RestoreNode, type RestoreRoot, type RestoreTree } from './core/restore.js';
import type { LocalNode } from './core/diff.js';
import { getLocal, setLocal } from './storage.js';

const KEY = 'restorePoints';
const LIMIT = 5;

export type RestoreReason =
  | 'migration'
  | 'reset'
  | 'bootstrap'
  | 'html'
  | 'undo'
  | 'remote-delete'
  | 'local-delete'
  | 'import';

export interface RestorePointSummary {
  id: string;
  at: number;
  reason: RestoreReason;
}

export interface RestorePoint extends RestorePointSummary {
  /** Drzewo zapisane z kolejnoscia, bez ikon. */
  tree: RestoreTree;
  /** Migawka przekazana przez silnik; bez tokena i innych danych logowania. */
  engine: unknown;
}

export function captureRestoreTree(roots: Partial<Record<RestoreRoot, LocalNode>>): RestoreTree {
  const tree = emptyRestoreTree();

  function convert(children: LocalNode[]): RestoreNode[] {
    const result: RestoreNode[] = [];
    for (const node of children) {
      switch (node.kind) {
        case 'root':
          // Korzen logiczny jest przekazywany osobno przez silnik.
          break;
        case 'folder':
          result.push({ kind: 'folder', title: node.title, children: convert(node.children ?? []) });
          break;
        case 'bookmark':
          if (node.url !== undefined) result.push({ kind: 'bookmark', title: node.title, url: node.url });
          break;
        case 'separator':
          result.push({ kind: 'separator', title: '' });
          break;
      }
    }
    return result;
  }

  for (const root of RESTORE_ROOTS) tree[root] = convert(roots[root]?.children ?? []);
  return tree;
}

/** Wywolywac pod MAIN_LOCK, przed zmiana drzewa lub stanu silnika. */
export async function saveRestorePoint(
  reason: RestoreReason,
  tree: RestoreTree,
  engine: unknown,
  keepIds: readonly string[] = [],
): Promise<RestorePointSummary> {
  const points = await getLocal<RestorePoint[]>(KEY, []);
  const summary: RestorePointSummary = { id: crypto.randomUUID(), at: Date.now(), reason };
  const current: RestorePoint = { ...summary, tree, engine };
  const pinned = new Set(keepIds);
  const keep = points.filter(point => pinned.has(point.id));
  const rest = points.filter(point => !pinned.has(point.id));

  await setLocal({
    [KEY]: [current, ...keep, ...rest.slice(0, Math.max(0, LIMIT - keep.length - 1))],
  });
  return summary;
}

export async function listRestorePoints(): Promise<RestorePointSummary[]> {
  const points = await getLocal<RestorePoint[]>(KEY, []);
  return points
    .map(({ id, at, reason }) => ({ id, at, reason }))
    .sort((a, b) => b.at - a.at);
}

/** Do UI oddajemy drzewo; stan silnika zostaje w tle. */
export async function readRestorePointTree(id: string): Promise<RestoreTree> {
  const points = await getLocal<RestorePoint[]>(KEY, []);
  const point = points.find(item => item.id === id);
  if (!point) throw new Error('Ten punkt przywracania nie jest już dostępny.');
  return point.tree;
}

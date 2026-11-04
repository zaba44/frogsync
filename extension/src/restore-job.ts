import type { RestoreEntry, RestorePlan, RestoreRoot } from './core/restore.js';
import { planReorder } from './core/reorder.js';
import { childIds, children, createLocal, kindOf, moveTo, moveWithin, updateLocal } from './local.js';
import { getLocal, setLocal } from './storage.js';
import { isGecko, wx, type WxBookmarkNode } from './wx.js';

export const RESTORE_JOB_KEY = 'restoreJob';

export type RestoreRoots = Partial<Record<RestoreRoot, string>>;

export interface RestoreDeletion {
  localId: string;
  parentId: string;
  title: string;
  url?: string;
}

interface CreateIntent {
  entry: number;
  parentId: string;
  marker: string;
}

export interface RestoreJob {
  id: string;
  pointId: string;
  plan: RestorePlan;
  roots: RestoreRoots;
  deletions: RestoreDeletion[];
  /** Id serwera, na ktore uzytkownik wyrazil zgode w podsumowaniu. */
  approvedServerIds: string[];
  /** Zatwierdzenie nie moze przejsc do innej sesji albo generacji. */
  scope: { deviceId: string; generation: string } | null;
  phase: 'apply' | 'ready';
  localIds: Record<number, string>;
  intent?: CreateIntent;
}

export async function loadRestoreJob(): Promise<RestoreJob | null> {
  return getLocal<RestoreJob | null>(RESTORE_JOB_KEY, null);
}

async function persist(job: RestoreJob): Promise<void> {
  await setLocal({ [RESTORE_JOB_KEY]: job });
}

/**
 * Wywolywac pod MAIN_LOCK, po sprawdzeniu aktualnosci podsumowania.
 * Punkt i plan musza byc zapisane przed pierwsza zmiana w przegladarce.
 */
export async function startRestoreJob(
  job: Omit<RestoreJob, 'phase' | 'localIds' | 'intent'>,
): Promise<RestoreJob> {
  if (await loadRestoreJob()) throw new Error('Przywracanie jest już w toku.');
  if (job.plan.blockedFolders.length > 0) {
    throw new Error('Przywracanie wymagałoby zmiany folderu z chronionymi zakładkami.');
  }
  if (!isGecko() && job.plan.entries.some(entry => entry.node.kind === 'separator')) {
    throw new Error('Ta przeglądarka nie obsługuje separatorów z pliku.');
  }

  const planned = new Set(job.plan.remove.map(entry => entry.localId));
  const confirmed = new Set(job.deletions.map(entry => entry.localId));
  if (planned.size !== confirmed.size || [...planned].some(id => !confirmed.has(id))) {
    throw new Error('Lista usunięć zmieniła się. Przygotuj podsumowanie ponownie.');
  }

  const state: RestoreJob = {
    ...job,
    phase: 'apply',
    localIds: Object.fromEntries(job.plan.entries.flatMap(entry =>
      entry.localId === undefined ? [] : [[entry.key, entry.localId]])),
  };
  await persist(state);
  return state;
}

async function directChild(id: string): Promise<WxBookmarkNode | undefined> {
  // getTree pozwala odroznic brak wpisu od bledu samego API. Nie uznajemy
  // odrzuconego zapytania za potwierdzenie usuniecia.
  const stack = [...await wx.bookmarks.getTree()];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) return node;
    stack.push(...(node.children ?? []));
  }
  return undefined;
}

function destination(job: RestoreJob, entry: RestoreEntry): string {
  const parentId = 'root' in entry.parent
    ? job.roots[entry.parent.root]
    : job.localIds[entry.parent.entry];
  if (!parentId) throw new Error('Nie znaleziono folderu docelowego.');
  return parentId;
}

async function createOnce(job: RestoreJob, entry: RestoreEntry, parentId: string): Promise<string> {
  if (job.intent && (job.intent.entry !== entry.key || job.intent.parentId !== parentId)) {
    throw new Error('Niedokończony zapis nie pasuje do planu przywracania.');
  }

  if (!job.intent) {
    job.intent = { entry: entry.key, parentId, marker: `FrogSync ${crypto.randomUUID()}` };
    await persist(job);
  }

  const { marker } = job.intent;
  const { node } = entry;
  const marked = (await children(parentId)).filter(item => item.title === marker);
  if (marked.length > 1) throw new Error('Znaleziono więcej niż jeden wpis tymczasowy.');

  let id: string;
  if (node.kind === 'separator') {
    // Separator nie ma tytulu. Tworzymy go w unikalnym pustym folderze,
    // gdzie po restarcie mozna go rozpoznac bez zgadywania po pozycji.
    if (marked[0] && (kindOf(marked[0]) !== 'folder' || marked[0].unmodifiable)) {
      throw new Error('Folder tymczasowy został zmieniony.');
    }
    const staging = marked[0]?.id ?? await createLocal(parentId, 'folder', marker, null);
    const staged = await children(staging);
    if (staged.length > 1 || staged.some(item => kindOf(item) !== 'separator' || item.unmodifiable)) {
      throw new Error('Folder tymczasowy zawiera nieoczekiwane wpisy.');
    }

    id = staged[0]?.id ?? await createLocal(staging, 'separator', '', null);
    job.localIds[entry.key] = id;
    await persist(job);
    await moveTo(id, parentId);
    await wx.bookmarks.remove(staging);
  } else {
    if (marked[0] && (kindOf(marked[0]) !== node.kind || marked[0].unmodifiable)) {
      throw new Error('Wpis tymczasowy został zmieniony.');
    }

    id = marked[0]?.id ?? await createLocal(
      parentId, node.kind, marker, node.kind === 'bookmark' ? node.url : null,
    );
    job.localIds[entry.key] = id;
    await persist(job);
  }

  return id;
}

async function finishIntent(job: RestoreJob, entry: RestoreEntry, parentId: string): Promise<void> {
  if (job.intent?.entry !== entry.key) return;

  if (entry.node.kind === 'separator') {
    const staging = (await children(parentId)).find(item => item.title === job.intent!.marker);
    if (staging) {
      if (kindOf(staging) !== 'folder' || staging.unmodifiable || (await childIds(staging.id)).length > 0) {
        throw new Error('Nie można bezpiecznie usunąć folderu tymczasowego.');
      }
      await wx.bookmarks.remove(staging.id);
    }
  }
  delete job.intent;
  await persist(job);
}

async function applyEntry(job: RestoreJob, entry: RestoreEntry): Promise<void> {
  const parentId = destination(job, entry);
  const parent = await directChild(parentId);
  if (!parent || parent.unmodifiable || kindOf(parent) !== 'folder') {
    throw new Error('Folder docelowy nie jest dostępny do zapisu.');
  }

  const id = job.localIds[entry.key] ?? await createOnce(job, entry, parentId);
  const current = await directChild(id);
  if (!current || current.unmodifiable || kindOf(current) !== entry.node.kind) {
    throw new Error('Zakładki zmieniły się podczas przywracania.');
  }

  if (current.parentId !== parentId) await moveTo(id, parentId);

  const { node } = entry;
  if (node.kind !== 'separator') {
    const changes: { title?: string; url?: string } = {};
    if (current.title !== node.title) changes.title = node.title;
    if (node.kind === 'bookmark' && current.url !== node.url) changes.url = node.url;
    await updateLocal(id, changes);
  }

  await finishIntent(job, entry, parentId);
}

async function applyDeletions(job: RestoreJob): Promise<void> {
  const confirmed = new Map(job.deletions.map(entry => [entry.localId, entry]));
  for (const entry of job.plan.remove) {
    const expected = confirmed.get(entry.localId);
    if (!expected) throw new Error('Brak zgody na usunięcie wpisu.');

    const node = await directChild(entry.localId);
    if (!node) continue;

    if (node.unmodifiable || kindOf(node) !== entry.kind ||
        node.parentId !== expected.parentId || node.title !== expected.title || node.url !== expected.url) {
      throw new Error('Wpis przeznaczony do usunięcia zmienił się. Przywracanie wstrzymano.');
    }
    if (entry.kind === 'folder' && (await childIds(entry.localId)).length > 0) {
      throw new Error('Folder przeznaczony do usunięcia nadal zawiera zakładki.');
    }
    // Nigdy removeTree: nowe lub chronione dziecko ma zatrzymac operacje.
    await wx.bookmarks.remove(entry.localId);
  }
}

async function applyOrder(job: RestoreJob): Promise<void> {
  const groups = new Map<string, string[]>();
  for (const entry of job.plan.entries) {
    const parentId = destination(job, entry);
    const id = job.localIds[entry.key];
    if (!id) throw new Error('Plan zawiera nieodtworzony wpis.');

    const desired = groups.get(parentId) ?? [];
    desired.push(id);
    groups.set(parentId, desired);
  }

  for (const [parentId, desired] of groups) {
    let current = await childIds(parentId);
    const wanted = new Set(desired);
    if (desired.some(id => !current.includes(id))) {
      throw new Error('Zakładka została przeniesiona podczas przywracania.');
    }
    for (const move of planReorder(current, desired)) {
      const fresh = await childIds(parentId);
      if (JSON.stringify(fresh) !== JSON.stringify(current)) {
        throw new Error('Kolejność zmieniła się podczas przywracania.');
      }
      await moveWithin(move.id, parentId, move.index, current);
      current.splice(current.indexOf(move.id), 1);
      current.splice(move.index, 0, move.id);
    }

    current = (await childIds(parentId)).filter(id => wanted.has(id));
    if (JSON.stringify(current) !== JSON.stringify(desired)) {
      throw new Error('Nie udało się odtworzyć kolejności zakładek.');
    }
  }
}

/**
 * Wywolywac pod MAIN_LOCK, bez APPLY_LOCK. Dopoki phase != ready nie
 * uruchamiac zwyklej synchronizacji. Gotowego zadania nie usuwac, dopoki
 * outbox ze zgoda na konkretne usuniecia nie zostanie trwale zapisany.
 */
export async function resumeRestoreJob(job: RestoreJob): Promise<RestoreJob> {
  if (job.phase === 'ready') return job;

  for (const entry of job.plan.entries) await applyEntry(job, entry);
  await applyDeletions(job);
  await applyOrder(job);

  job.phase = 'ready';
  await persist(job);
  return job;
}

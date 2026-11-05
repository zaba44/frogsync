import { diff, type KnownNode, type LocalNode, type Mapping, type PlannedOp } from './core/diff.js';
import { planReorder } from './core/reorder.js';
import { runOrder, sameOrder, type OrderWork } from './order-work.js';
import { mergeContent } from './core/merge-content.js';
import { conflictId } from './conflict-id.js';
import { planBootstrap } from './core/bootstrap.js';
import * as api from './api.js';
import { getLocal, setLocal, KEYS } from './storage.js';
import { exclusive, ifFree, MAIN_LOCK, APPLY_LOCK } from './locks.js';
import { compileFilters, loadFilterConfig } from './filters.js';
import {
  readRoots, indexTree, ensureRootMapping, createLocal, updateLocal, moveToFolderEnd, moveWithin,
  removeLocal, childIds, children, moveTo, countBookmarks, exists, nativeRootId, resolveRoots,
  Unrepresentable, SERVER_ROOTS, ROOT_LABELS,
} from './local.js';
import type { ConflictNote, OpResult, ServerNode, ServerSession, SyncStatus } from './types.js';
import { wx } from './wx.js';
import { compareVersions } from './extension-version.js';
import { planRestore, RESTORE_ROOTS, type RestoreTree } from './core/restore.js';
import { formatBookmarkHtml } from './bookmark-html.js';
import {
  loadRestoreJob, resumeRestoreJob, startRestoreJob, RESTORE_JOB_KEY,
  type RestoreDeletion, type RestoreJob, type RestoreRoots,
} from './restore-job.js';
import {
  captureRestoreTree, listRestorePoints, readRestorePointTree, saveRestorePoint,
  type RestoreReason,
} from './restore-points.js';

export { listRestorePoints };

// ============================================================
// Silnik synchronizacji.
//
// Przebieg (NIE WOLNO odwracac kolejnosci wysylki i pobrania):
//   0. dokoncz przerwane tworzenie wpisow (intencje)
//   1. jesli trwa pierwsze polaczenie — dokoncz je (bootstrap), wysylka zablokowana
//   2. wyslij zalegle operacje
//   3. dokoncz zalegla prace lokalna (przestawienia, ponowienia, usuniecia)
//   4. TYLKO gdy nie ma zaleglosci: wykryj lokalne zmiany i wyslij
//   5. pobierz zmiany z serwera i zastosuj
//
// Krok 4 przy zaleglej pracy lokalnej wyslalby jako "zmiane uzytkownika" stan,
// ktory po prostu nie zdazyl sie jeszcze zastosowac (znalezisko Codexa).
//
// known = stan uzgodniony z serwerem. Zalegla praca lokalna jest trwala
// (reapply, pendingFolders, pendingDeletes), wiec kursor moze isc dalej —
// nic nie przepada, nawet gdy przegladarka ubije wtyczke w polowie.
// ============================================================

const BATCH = 200;
const BRAKE_ABSOLUTE = 50;
const BRAKE_FRACTION = 0.3;
/** Po tylu nieudanych probach przestajemy blokowac wykrywanie zmian przez jeden uparty wpis. */
const MAX_ATTEMPTS = 5;
export const QUARANTINE_TITLE = 'Zakładki sprzed FrogSync';

interface Brake {
  remote?: { ids: string[]; count: number };
  remoteApproved?: string[];
  local?: { ids: string[]; count: number };
  localApproved?: string[];
}

interface Intent { parent: string; kind: string; title: string; url: string | null; created?: string; at: number }

interface State {
  session: ServerSession;
  cursor: number;
  known: Record<string, KnownNode>;
  /** Baza tresci sprzed przyjecia nowego stanu serwera; przezywa ponowienia. */
  applyBases: Record<string, KnownNode>;
  /** Bootstrap i reset sa jawnie autorytatywne takze po restarcie workera. */
  authoritativeApply: string[];
  mapping: Mapping;
  outbox: (PlannedOp & { approved?: boolean })[];
  skipped: Record<string, { reason: string }>;
  rejectedLocal: Record<string, string>;
  conflicts: ConflictNote[];
  brake: Brake;
  requireFull: boolean;
  /** Wezly, ktorych stan z known trzeba nalozyc na przegladarke. */
  reapply: string[];
  attempts: Record<string, number>;
  /** Foldery serwera, w ktorych lokalna kolejnosc wymaga sprawdzenia. */
  pendingFolders: string[];
  orderWork: Record<string, OrderWork>;
  /** Migawka kolejnosci z chwili utworzenia operacji, kluczowana clientOpId. */
  placementSent: Record<string, Record<string, string[]>>;
  /** Usuniecia z serwera, ktorych jeszcze nie wykonano lokalnie (hamulec albo blad). */
  pendingDeletes: string[];
  approvedDeletes: string[];
  /** Korzenie odrzuconych usuniec; ponownie odczytujemy tylko ich zakres. */
  subtreeRefresh: string[];
  /** Brak lokalnego wpisu wynika z odrzuconego usuniecia, nie z nowej edycji. */
  restoreMissing: string[];
  bootstrap: { mode: 'replace' | 'merge'; startedAt: number; pointId?: string } | null;
}

const EMPTY_STATE = {
  cursor: 0, known: {}, mapping: { s2l: {}, l2s: {} }, outbox: [], skipped: {}, rejectedLocal: {},
  conflicts: [], brake: {}, requireFull: false, reapply: [], attempts: {}, pendingFolders: [],
  pendingDeletes: [], approvedDeletes: [], bootstrap: null,
  applyBases: {}, authoritativeApply: [],
  subtreeRefresh: [], restoreMissing: [],
  orderWork: {}, placementSent: {},
};

async function loadState(): Promise<State | null> {
  await resolveRoots();
  const session = await getLocal<ServerSession | null>(KEYS.server, null);
  if (!session) return null;
  const stored = await getLocal<Partial<State> | null>('engineState', null);
  if (stored) return { ...structuredClone(EMPTY_STATE), ...stored, session } as State;
  return migrateLegacy(session);
}

/**
 * Kolejka 0.1.0 zostaje w punkcie przywracania. Wysylke liczymy od nowa
 * z aktualnego drzewa, mapowania i known, zamiast ponawiac nieaktualny plan.
 */
async function migrateLegacy(session: ServerSession): Promise<State> {
  const mapping = await getLocal<State['mapping'] | null>(KEYS.mapping, null);
  const known = await getLocal<State['known']>(KEYS.known, {});
  const cursor = await getLocal<number>(KEYS.cursor, 0);
  const oldOutbox = await getLocal<unknown>(KEYS.outbox, []);
  const s: State = { ...structuredClone(EMPTY_STATE), session };

  if (mapping && Object.keys(mapping.s2l ?? {}).length > 0) {
    s.mapping = mapping;
    s.known = known;
    s.cursor = cursor;
  } else {
    s.bootstrap = { mode: 'merge', startedAt: Date.now() };
  }

  await checkpoint('migration', s, { oldOutbox, oldCursor: cursor });
  await saveState(s);
  await wx.storage.local.remove([KEYS.cursor, KEYS.known, KEYS.mapping, KEYS.outbox, KEYS.conflicts, KEYS.skipped, KEYS.brake, KEYS.pending]);
  return s;
}

/** Caly stan jednym zapisem — przerwanie w polowie nie zostawi rozjechanych kluczy. */
async function saveState(s: State, finishRestore = false): Promise<void> {
  const { session, ...rest } = s;
  rest.conflicts = rest.conflicts.slice(-50);
  await setLocal({
    [KEYS.server]: session,
    engineState: rest,
    ...(finishRestore ? { [RESTORE_JOB_KEY]: null } : {}),
  });
}

// ---- intencje: zapis zamiaru PRZED utworzeniem wpisu ----

async function loadIntents() { return getLocal<Record<string, Intent>>('intents', {}); }
async function saveIntents(i: Record<string, Intent>) { await setLocal({ intents: i }); }

// ---- kwarantanna: lista folderow trzymana poza stanem sesji (przezywa rozlaczenie) ----

export async function quarantineIds(): Promise<string[]> { return getLocal<string[]>('quarantine', []); }

async function restoreRoots(s: State | null) {
  const index = indexTree(await readRoots());
  const roots: Partial<Record<(typeof RESTORE_ROOTS)[number], LocalNode>> = {};
  const ids: RestoreRoots = {};
  const menu = s?.mapping.s2l['root:menu'];
  const nativeMenu = nativeRootId('root:menu');

  for (const root of RESTORE_ROOTS) {
    const id = nativeRootId(root) ?? s?.mapping.s2l[root];
    const node = id ? index.get(id) : undefined;
    if (!id || !node) continue;

    ids[root] = id;
    roots[root] = {
      ...node,
      children: (node.children ?? []).filter(c => nativeMenu || c.id !== menu),
    };
  }
  return { roots, ids, index };
}

async function checkpoint(reason: RestoreReason, s: State | null, extra?: unknown) {
  const { roots } = await restoreRoots(s);
  const job = await loadRestoreJob();
  const { session, ...engine } = s ?? { session: null };
  return saveRestorePoint(reason, captureRestoreTree(roots), {
    ...engine,
    scope: session ? { deviceId: session.deviceId, generation: session.generation } : null,
    extra,
  }, job ? [job.pointId] : []);
}

async function noRestoreInProgress(): Promise<void> {
  if (await loadRestoreJob()) {
    throw new Error('Przywracanie jest w toku. Użyj „Synchronizuj teraz”, aby je dokończyć.');
  }
}

async function prepareRestore(tree: RestoreTree, s: State | null) {
  await noRestoreInProgress();
  if (s && (!idle(s) || s.pendingDeletes.length > 0 || !s.session.generation)) {
    throw new Error('Najpierw dokończ synchronizację i rozstrzygnij wstrzymane usunięcia.');
  }

  const { roots, ids, index } = await restoreRoots(s);
  const filters = compileFilters(await loadFilterConfig());
  const quarantine = new Set(await quarantineIds());
  const menu = s?.mapping.s2l['root:menu'];
  const nativeMenu = nativeRootId('root:menu');
  const protectNames = new Set([
    'kosz', 'trash', 'pinboard', 'unsynchronized pinboard', 'speed dials',
    'nieuporządkowane', 'nieuporzadkowane', QUARANTINE_TITLE.toLowerCase(),
  ]);
  const protectedByPolicy = new Set<string>();

  // readRoots pomija wpisy zarzadzane. Oznaczamy ich rodzicow, zeby
  // planer nie uznal folderu z chroniona zawartoscia za zwykly pusty folder.
  const raw = [...await wx.bookmarks.getTree()];
  while (raw.length) {
    const node = raw.pop()!;
    if (node.unmodifiable) {
      if (node.parentId) protectedByPolicy.add(node.parentId);
      continue;
    }
    raw.push(...(node.children ?? []));
  }

  const plan = planRestore({
    tree,
    roots,
    protect: node => quarantine.has(node.id) || protectedByPolicy.has(node.id) ||
      (!nativeMenu && node.id === menu) ||
      (node.kind === 'folder' && (protectNames.has(node.title.trim().toLowerCase()) ||
        filters.isFolderExcluded(node.title, node.id))) ||
      (node.kind === 'bookmark' && filters.isUrlExcluded(node.url ?? '')),
    excludeImport: node =>
      (node.kind === 'folder' && (protectNames.has(node.title.trim().toLowerCase()) ||
        filters.isFolderExcluded(node.title, ''))) ||
      (node.kind === 'bookmark' && filters.isUrlExcluded(node.url)),
  });

  if (plan.blockedFolders.length) {
    throw new Error('Przywracanie wymagałoby zmiany folderu zawierającego chronione wpisy.');
  }
  for (const entry of plan.entries) {
    if ('root' in entry.parent && !ids[entry.parent.root]) {
      throw new Error(`Brakuje folderu docelowego: ${ROOT_LABELS[entry.parent.root]}.`);
    }
    if (entry.node.kind === 'separator' && !wx.runtime.getURL('').startsWith('moz-extension:')) {
      throw new Error('Ta przeglądarka nie obsługuje separatorów z kopii.');
    }
  }
  for (const id of Object.values(ids)) {
    if (protectedByPolicy.has(id)) {
      throw new Error('Jeden z folderów głównych zawiera wpisy zarządzane. Nie zastosowano zmian.');
    }
  }

  const deletions: RestoreDeletion[] = plan.remove.map(({ localId }) => {
    const node = index.get(localId);
    if (!node?.parentId) throw new Error('Nie znaleziono wpisu przeznaczonego do usunięcia.');
    return { localId, parentId: node.parentId, title: node.title, url: node.url };
  });
  const approvedServerIds = s ? deletions.flatMap(({ localId }) => {
    const sid = s.mapping.l2s[localId];
    return sid ? [sid] : [];
  }) : [];
  const scope = s ? { deviceId: s.session.deviceId, generation: s.session.generation } : null;

  const bytes = new TextEncoder().encode(JSON.stringify({
    tree, plan, ids, deletions, approvedServerIds, scope, roots,
  }));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const summaryId = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  return { plan, roots: ids, deletions, approvedServerIds, scope, summaryId };
}

async function restoreStateForPreview(): Promise<State | null> {
  await resolveRoots();
  const session = await getLocal<ServerSession | null>(KEYS.server, null);
  const stored = await getLocal<Partial<State> | null>('engineState', null);
  if (session && !stored) throw new Error('Najpierw uruchom synchronizację po aktualizacji wtyczki.');
  return session && stored ? { ...structuredClone(EMPTY_STATE), ...stored, session } as State : null;
}

async function previewTree(tree: RestoreTree) {
  const state = await restoreStateForPreview();
  const prepared = await prepareRestore(tree, state);
  return { summaryId: prepared.summaryId, counts: prepared.plan.counts };
}

export async function previewRestore(tree: RestoreTree) {
  return exclusive(MAIN_LOCK, () => previewTree(tree));
}

export async function previewUndo(id: string) {
  return exclusive(MAIN_LOCK, async () => previewTree(await readRestorePointTree(id)));
}

async function runRestoreInner(tree: RestoreTree, summaryId: string, reason: 'html' | 'undo') {
  const s = await restoreStateForPreview();
  const prepared = await prepareRestore(tree, s);
  if (summaryId !== prepared.summaryId) {
    throw new Error('Zakładki zmieniły się od podglądu. Przygotuj podsumowanie ponownie.');
  }

  if (s) {
    const hello = await api.hello(s.session);
    if (hello.generation !== s.session.generation || hello.head !== s.cursor) {
      throw new Error('Stan serwera zmienił się od podglądu. Najpierw zsynchronizuj zakładki.');
    }
    if ((hello.protocol ?? 0) < api.PROTOCOL) {
      throw new Error('Zaktualizuj serwer FrogSync przed przywracaniem zakładek.');
    }
  }

  const point = await checkpoint(reason, s);
  await startRestoreJob({
    id: crypto.randomUUID(), pointId: point.id, plan: prepared.plan,
    roots: prepared.roots, deletions: prepared.deletions,
    approvedServerIds: prepared.approvedServerIds, scope: prepared.scope,
  });
  return syncInner();
}

export async function runRestore(tree: RestoreTree, summaryId: string): Promise<SyncStatus> {
  return exclusive(MAIN_LOCK, () => runRestoreInner(tree, summaryId, 'html'));
}

export async function undoToPoint(id: string, summaryId: string): Promise<SyncStatus> {
  return exclusive(MAIN_LOCK, async () => runRestoreInner(await readRestorePointTree(id), summaryId, 'undo'));
}

export async function exportPointHtml(id: string): Promise<string> {
  return formatBookmarkHtml(await readRestorePointTree(id));
}

/** Notatki o konfliktach leza w stanie silnika — czytamy je bez blokady, tylko do pokazania. */
export async function conflictNotes(): Promise<ConflictNote[]> {
  return (await getLocal<Partial<State>>('engineState', {})).conflicts ?? [];
}

export async function restoreConflict(id: string): Promise<SyncStatus> {
  return exclusive(MAIN_LOCK, async () => {
    await noRestoreInProgress();
    const s = await loadState();
    if (!s) throw new Error('Najpierw połącz przeglądarkę z serwerem.');
    const note = s.conflicts.find(item => conflictId(item) === id);
    if (!note) throw new Error('Konflikt nie jest już dostępny.');
    if (note.restoredAt) return syncInner();
    if (!idle(s) || s.pendingDeletes.length) {
      throw new Error('Najpierw dokończ synchronizację, a potem ponów odzyskanie.');
    }

    const recovery = note.rejectedContent ?? note.rejectedPlacement ?? note.rejectedDeletion;
    if (!recovery) throw new Error('Ten konflikt nie zawiera zapisanej operacji.');
    if (recovery.generation !== s.session.generation) {
      throw new Error('Konflikt pochodzi sprzed odtworzenia serwera. Skorzystaj z punktu przywracania.');
    }

    const info = await api.hello(s.session);
    if (info.generation !== s.session.generation) {
      throw new Error('Serwer zmienił generację. Najpierw zsynchronizuj stan i sprawdź punkty przywracania.');
    }
    const { nodes } = await fetchAll(s, 0);
    const orderRecovery = note.rejectedPlacement?.order;
    const node = nodes.get(recovery.nodeId);
    if (!node || (node.kind === 'root' && !orderRecovery) || (orderRecovery && node.deleted)) {
      throw new Error('Wpis nie jest już dostępny na serwerze. Skorzystaj z punktu przywracania.');
    }

    const ops: PlannedOp[] = [];
    if (orderRecovery) {
      const parentId = note.rejectedPlacement!.parentId;
      if (parentId !== node.id || !['folder', 'root'].includes(node.kind)) {
        throw new Error('Zapisana kolejność nie należy do dostępnego folderu.');
      }

      const remote = [...nodes.values()]
        .filter(item => !item.deleted && item.parentId === parentId)
        .sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0)
        .map(item => item.id);
      const present = new Set(remote);
      const saved = [...new Set(orderRecovery)].filter(id => present.has(id));
      const selected = new Set(saved);
      let cursor = 0;
      const desired = remote.map(id => selected.has(id) ? saved[cursor++] : id);

      for (const move of planReorder(remote, desired)) {
        const at = desired.indexOf(move.id);
        ops.push({
          clientOpId: crypto.randomUUID(), type: 'move', nodeId: move.id,
          parentId, afterId: at > 0 ? desired[at - 1] : null, beforeId: null,
          baseVersion: nodes.get(move.id)!.version,
        });
      }
    } else if (note.rejectedContent) {
      const op: PlannedOp = {
        clientOpId: crypto.randomUUID(), type: 'update', nodeId: node.id,
        baseVersion: node.version, force: node.deleted,
      };
      for (const field of note.rejectedContent.fields) {
        if (field.field === 'title' && node.kind !== 'separator') op.title = field.local ?? '';
        if (field.field === 'url' && node.kind === 'bookmark') op.url = field.local ?? '';
      }
      ops.push(op);
    } else if (note.rejectedPlacement) {
      const place = note.rejectedPlacement;
      const parent = nodes.get(place.parentId);
      if (!parent || parent.deleted || !['folder', 'root'].includes(parent.kind)) {
        throw new Error('Zapisany folder docelowy nie jest już dostępny.');
      }
      if (node.deleted) {
        ops.push({
          clientOpId: crypto.randomUUID(), type: 'update', nodeId: node.id,
          baseVersion: node.version, force: true,
        });
      }
      ops.push({
        clientOpId: crypto.randomUUID(), type: 'move', nodeId: node.id,
        parentId: place.parentId, afterId: place.afterId, beforeId: place.beforeId,
        baseVersion: node.version,
      });
    } else {
      ops.push({
        clientOpId: crypto.randomUUID(), type: 'delete', nodeId: node.id,
        baseVersion: node.version, baseSeq: s.cursor,
      });
    }

    await checkpoint('undo', s);
    s.outbox = ops;
    const index = indexTree(await readRoots());
    for (const op of ops) {
      if (op.type === 'move' || op.type === 'create') {
        s.placementSent[op.clientOpId] = submittedOrder(s, op, index);
      }
    }
    if (orderRecovery) rememberOrder(s, node.id, true);
    note.restoredAt = Date.now();
    // Lokalnie wpis ma przyjac odzyskana wartosc z serwera. Bez tego stara wartosc
    // w przegladarce wygladalaby jak nowa edycja i wrocilaby na serwer.
    if (!orderRecovery) {
      delete s.applyBases[node.id];
      addUnique(s.authoritativeApply, node.id);
    }
    // Zgoda i operacja sa trwale w jednym zapisie. Utrata odpowiedzi
    // uruchomi idempotentne ponowienie zamiast drugiej operacji.
    await saveState(s);
    return syncInner();
  });
}

export async function clearConflicts(): Promise<SyncStatus> {
  return exclusive(MAIN_LOCK, async () => {
    const s = await loadState();
    if (s) { s.conflicts = []; await saveState(s); }
    return saveStatus({ conflicts: 0 });
  });
}

export async function loadStatus(): Promise<SyncStatus> {
  return getLocal<SyncStatus>(KEYS.status, {
    connection: 'unpaired', pendingOps: 0, localCount: 0, pulled: 0, pushed: 0, conflicts: 0, skipped: 0,
  });
}

async function saveStatus(patch: Partial<SyncStatus>): Promise<SyncStatus> {
  const next = { ...(await loadStatus()), ...patch };
  await setLocal({ [KEYS.status]: next });
  return next;
}

// ============================================================
// Wejscia z zewnatrz — wszystkie pod jedna blokada
// ============================================================

/** Przebieg synchronizacji; jesli inny wlasnie trwa, nic nie robi. */
export async function syncOnce(): Promise<SyncStatus> {
  return (await ifFree(MAIN_LOCK, syncInner)) ?? loadStatus();
}

export async function pairWith(url: string, code: string, label: string, mode: 'replace' | 'merge', expectContent: boolean): Promise<SyncStatus> {
  return exclusive(MAIN_LOCK, async () => {
    await noRestoreInProgress();
    const base = url.trim().replace(/\/+$/, '');
    const result = await api.pair(base, code, label, expectContent);
    const session: ServerSession = {
      url: base, token: result.token, deviceId: result.deviceId, deviceName: '', profile: result.profile, generation: '',
    };
    // Najpierw zachowujemy token. Wymaganie aktualizacji nie moze zgubic
    // jednorazowego parowania; syncInner zatrzyma prace przed bootstrapem.
    const info = await api.helloInfo(session);
    session.deviceName = info.device.name;
    session.generation = info.generation;

    // Nowe parowanie = czysty stan synchronizacji. Zakladki w przegladarce zostaja.
    // Bootstrap zapisany PRZED pierwszym przebiegiem: do jego konca nic nie wyjdzie na serwer.
    await setLocal({ [KEYS.server]: session, engineState: { ...EMPTY_STATE, bootstrap: { mode, startedAt: Date.now() } }, intents: {} });
    return syncInner();
  });
}

export async function unpair(): Promise<void> {
  await exclusive(MAIN_LOCK, async () => {
    await noRestoreInProgress();
    await setLocal({ [KEYS.server]: null, engineState: EMPTY_STATE, intents: {} });
    await saveStatus({
      connection: 'unpaired', pendingOps: 0, lastError: undefined, consecutiveFailures: 0,
      blockedDeletions: undefined, blockedLocalDeletions: undefined,
    });
  });
}

/** Zgoda dotyczy DOKLADNIE tej listy usuniec, ktora uzytkownik widzial w ostrzezeniu. */
export async function confirmDeletions(which: 'remote' | 'local'): Promise<SyncStatus> {
  return exclusive(MAIN_LOCK, async () => {
    const s = await loadState();
    if (!s) return loadStatus();
    await noRestoreInProgress();
    if (which === 'remote' && s.brake.remote) {
      await checkpoint('remote-delete', s);
      s.brake.remoteApproved = s.brake.remote.ids;
    }
    if (which === 'local' && s.brake.local) {
      await checkpoint('local-delete', s);
      s.brake.localApproved = s.brake.local.ids;
    }
    await saveState(s);
    return syncInner();
  });
}

// ============================================================
// Przebieg
// ============================================================

async function syncInner(): Promise<SyncStatus> {
  let s: State | null = null;
  let pushed = 0, pulled = 0;
  try {
    // Przed loadState: rowniez migracja i wznowienie przywracania zmieniaja stan.
    const session = await getLocal<ServerSession | null>(KEYS.server, null);
    if (session) {
      const info = await api.hello(session);
      const latest = info.latestExtensionVersion ?? '';
      await saveStatus({
        minExtensionVersion: info.minExtensionVersion ?? '',
        latestExtensionVersion: latest,
        updateAvailable: !!latest && compareVersions(api.extensionVersion(), latest) < 0,
      });
    } else {
      await saveStatus({ minExtensionVersion: '', latestExtensionVersion: '', updateAvailable: false });
    }

    s = await loadState();

    let job = await loadRestoreJob();
    if (job) {
      const scope = job.scope;
      if (scope
        ? (!s || scope.deviceId !== s.session.deviceId || scope.generation !== s.session.generation)
        : !!s) {
        throw new Error('Przywracanie należy do innej sesji. Nie wysłano zmian.');
      }
      job = await resumeRestoreJob(job);
      if (s) {
        if (!idle(s) || s.pendingDeletes.length > 0) {
          throw new Error('Przywrócono zakładki lokalnie, ale kolejka synchronizacji wymaga sprawdzenia.');
        }
        pushed += await detectAndSend(s, job);
      } else {
        await setLocal({ [RESTORE_JOB_KEY]: null });
      }
    }

    if (!s) return saveStatus({
      connection: 'unpaired', pendingOps: 0, lastError: undefined, consecutiveFailures: 0,
    });

    if (!s.session.generation) {
      const info = await api.hello(s.session);
      if (!info.generation) throw new Error('Serwer nie podał generacji. Zaktualizuj serwer FrogSync.');
      s.session.generation = info.generation;
      await saveState(s);
    }

    await reconcileIntents(s);

    if (s.bootstrap) {
      // runBootstrap moze zmienic tryb (pusty profil = scalanie) — czytamy go z tego samego obiektu
      const boot = s.bootstrap;
      pulled += await runBootstrap(s);
      if (!s.bootstrap && boot.mode === 'merge') pushed += await detectAndSend(s);
    } else {
      pushed += await flush(s);
      await reconcile(s, [], false);
      if (idle(s)) pushed += await detectAndSend(s);
      pulled += await pull(s, s.requireFull);
    }

    await saveState(s);
    try { await api.reportCursor(s.session, s.cursor); } catch { /* tylko dla panelu */ }

    const roots = await readRoots();
    const mapped = s.mapping.l2s;
    return saveStatus({
      connection: 'ok',
      lastSyncAt: Date.now(),
      lastError: undefined,
      consecutiveFailures: 0,
      pendingOps: s.outbox.length,
      // Tylko synchronizowane korzenie — Kosz Opery i podobne nie sa czescia kolekcji
      localCount: roots.filter(r => mapped[r.id]).reduce((n, r) => n + countBookmarks(r), 0),
      pushed, pulled,
      conflicts: s.conflicts.length,
      skipped: Object.keys(s.skipped).length,
      blockedDeletions: s.brake.remote && !approved(s.brake.remote.ids, s.brake.remoteApproved) ? s.brake.remote.count : undefined,
      blockedLocalDeletions: s.brake.local && !approved(s.brake.local.ids, s.brake.localApproved) ? s.brake.local.count : undefined,
    });

  } catch (err) {
    // Preflight nie laduje silnika, wiec przy outdated nie zapisujemy stanu,
    // nie rozliczamy intencji, nie ruszamy kolejki ani drzewa przegladarki.
    if (s) await saveState(s);
    const previous = await loadStatus();
    const stored = await getLocal<{ outbox?: unknown[] } | null>('engineState', null);
    return saveStatus({
      connection: err instanceof api.Outdated ? 'outdated' :
        err instanceof api.Offline ? 'offline' :
        err instanceof api.Unauthorized ? 'revoked' : 'error',
      lastError: err instanceof Error ? err.message : String(err),
      consecutiveFailures: (previous.consecutiveFailures ?? 0) + 1,
      pendingOps: s?.outbox.length ?? stored?.outbox?.length ?? previous.pendingOps,
      ...(err instanceof api.Outdated ? {
        minExtensionVersion: err.minimum,
        latestExtensionVersion: err.latest,
        updateAvailable: true,
      } : {}),
    });
  }
}

/** Wykrywanie zmian tylko przy braku jakichkolwiek zaleglosci — inaczej wyslalibysmy niezastosowany stan. */
function idle(s: State): boolean {
  // Usuniecia wstrzymane hamulcem nie blokuja wysylki: te wpisy wciaz sa lokalnie
  // i w known, wiec diff nie widzi w nich zmian — a uzytkownik moze dalej pracowac.
  const deletesPending = s.pendingDeletes.length > 0 && !s.brake.remote;
  return s.outbox.length === 0 && s.reapply.length === 0 && s.pendingFolders.length === 0 &&
         s.subtreeRefresh.length === 0 &&
         !deletesPending && !s.requireFull && !s.bootstrap;
}

function approved(ids: string[], ok?: string[]): boolean {
  if (!ok) return false;
  const set = new Set(ok);
  return ids.length === set.size && ids.every(id => set.has(id));
}

// ============================================================
// 0. Intencje
// ============================================================

/**
 * Przegladarka mogla ubic wtyczke miedzy utworzeniem wpisu a zapisem mapowania.
 * Kazde utworzenie poprzedza zapisana intencja; tutaj ja rozliczamy, zanim cokolwiek
 * policzymy — inaczej ponowne pobranie utworzyloby ten sam wpis drugi raz,
 * albo diff wyslalby go pod nowym identyfikatorem.
 */
async function reconcileIntents(s: State): Promise<void> {
  const intents = await loadIntents();
  const ids = Object.keys(intents);
  if (ids.length === 0) return;

  for (const sid of ids) {
    if (s.mapping.s2l[sid] && (await exists(s.mapping.s2l[sid]))) continue;
    const intent = intents[sid];
    let localId = intent.created && (await exists(intent.created)) ? intent.created : undefined;

    if (!localId && (await exists(intent.parent))) {
      // Utworzony, ale bez zapisanego id: szukamy jednoznacznego kandydata utworzonego po intencji
      const candidates = (await children(intent.parent)).filter(c =>
        !s.mapping.l2s[c.id] && (c.dateAdded ?? 0) >= intent.at - 1000 &&
        (intent.kind === 'separator' ? c.type === 'separator'
          : intent.kind === 'folder' ? c.url === undefined && c.title === intent.title
          : c.url === intent.url && c.title === intent.title));
      if (candidates.length === 1) localId = candidates[0].id;
    }

    if (localId) link(s, sid, localId);
  }
  await saveState(s);
  await saveIntents({});
}

// ============================================================
// 1. Pierwsze polaczenie
// ============================================================

async function runBootstrap(s: State): Promise<number> {
  if (s.bootstrap && !s.bootstrap.pointId) {
    s.bootstrap.pointId = (await checkpoint('bootstrap', s)).id;
    await saveState(s);
  }
  const { nodes, head } = await fetchAll(s, 0);
  const live = [...nodes.values()].filter(n => !n.deleted);
  // Pusty profil: zakladki tej przegladarki staja sie baza, niezaleznie od wyboru.
  // Zastepowanie pustka odlozyloby do kwarantanny cala kolekcje.
  const mode = live.some(n => n.kind !== 'root') ? s.bootstrap!.mode : 'merge';
  s.bootstrap!.mode = mode;

  if (await ensureRootMapping(s.mapping, live.some(n => n.parentId === 'root:menu'))) await saveState(s);

  const filters = compileFilters(await loadFilterConfig());
  const hidden = new Set([...(await quarantineIds()), s.mapping.s2l['root:menu'] ?? '']);
  const roots = await readRoots();
  const index = indexTree(roots);

  const planRoots = SERVER_ROOTS.flatMap(root => {
    const lid = s.mapping.s2l[root];
    const local = lid ? index.get(lid) : undefined;
    return local ? [{ local, serverId: root, label: ROOT_LABELS[root] }] : [];
  });

  const plan = planBootstrap({
    mode,
    server: live,
    roots: planRoots,
    alreadyMapped: new Set(Object.keys(s.mapping.l2s)),
    isHidden: node => hidden.has(node.id) || !!s.rejectedLocal[node.id] ||
      (node.kind === 'bookmark' && filters.isUrlExcluded(node.url ?? '')) ||
      (node.kind === 'folder' && filters.isFolderExcluded(node.title, node.id)),
  });

  for (const p of plan.pairs) link(s, p.serverId, p.localId);
  await saveState(s);

  // Odkladanie do kwarantanny. Po przerwaniu plan liczy sie od nowa — to, co juz
  // lezy w kwarantannie, jest dla niego niewidoczne, wiec nic nie przeniesie sie dwa razy.
  if (plan.quarantine.length > 0) {
    const quarantine = await ensureQuarantine();
    const folderCache = new Map<string, string>();
    for (const move of plan.quarantine) {
      const target = await ensurePath(quarantine, move.path, folderCache);
      if (await exists(move.localId)) await moveTo(move.localId, target);
    }
  }

  await applyNodes(s, live, true);
  await deleteLocally(s);   // w trybie zastepowania nie ma czego usuwac, ale zachowujemy jedna sciezke
  if (s.reapply.length === 0 && s.pendingFolders.length === 0) {
    s.cursor = head;
    s.bootstrap = null;
  }
  return nodes.size;
}

async function ensureQuarantine(): Promise<string> {
  const ids = await quarantineIds();
  for (const id of ids) if (await exists(id)) return id;

  const parent = nativeRootId('root:unsorted')!;
  // Intencja przed utworzeniem: przerwanie tuz po create nie zostawi niezarejestrowanego folderu
  const pending = await getLocal<number>('quarantinePending', 0);
  if (pending) {
    const found = (await children(parent)).find(c => c.url === undefined && c.title === QUARANTINE_TITLE && (c.dateAdded ?? 0) >= pending - 1000);
    if (found) { await setLocal({ quarantine: [...ids, found.id], quarantinePending: 0 }); return found.id; }
  }
  await setLocal({ quarantinePending: Date.now() });
  const created = await wx.bookmarks.create({ parentId: parent, title: QUARANTINE_TITLE });
  await setLocal({ quarantine: [...ids, created.id], quarantinePending: 0 });
  return created.id;
}

async function ensurePath(root: string, path: string[], cache: Map<string, string>): Promise<string> {
  let parent = root;
  for (let i = 0; i < path.length; i++) {
    const key = path.slice(0, i + 1).join('\u0001');
    const cached = cache.get(key);
    if (cached && (await exists(cached))) { parent = cached; continue; }
    const found = (await children(parent)).find(c => c.url === undefined && c.title === path[i]);
    parent = found ? found.id : (await wx.bookmarks.create({ parentId: parent, title: path[i] })).id;
    cache.set(key, parent);
  }
  return parent;
}

// ============================================================
// 2. Wysylka
// ============================================================

async function flush(s: State): Promise<number> {
  let sent = 0;
  while (s.outbox.length > 0) {
    const batch = s.outbox.slice(0, BATCH);
    // Zapas dla kolejek zapisanych przez starszy build. Nowe kolejki maja
    // migawke z tego samego drzewa, z ktorego powstal diff.
    const index = indexTree(await readRoots());
    let captured = false;
    for (const op of batch) {
      if ((op.type === 'move' || op.type === 'create') && !s.placementSent[op.clientOpId]) {
        s.placementSent[op.clientOpId] = submittedOrder(s, op, index);
        captured = true;
      }
    }
    if (captured) await saveState(s);
    let response;
    try {
      response = await api.sendOps(s.session, batch);
    } catch (err) {
      if (!(err instanceof api.ResetRequired)) throw err;
      await handleReset(s, err.generation);
      return sent;
    }
    const followUps: PlannedOp[] = [];
    response.results.forEach((result, i) => handleResult(s, batch[i], result, followUps));
    response.results.forEach((result, i) => {
      const op = batch[i];
      if (result.status !== 'applied' || (op.type !== 'move' && op.type !== 'create')) return;
      for (const [parent, expected] of Object.entries(s.placementSent[op.clientOpId] ?? {})) {
        rememberOrder(s, parent);
        const work = s.orderWork[parent];
        work.expected = [...expected];
        work.remote = serverOrder(s, parent).map(id => s.mapping.s2l[id])
          .filter((id): id is string => !!id);
        delete work.target;
      }
    });
    for (const op of batch) delete s.placementSent[op.clientOpId];
    s.outbox = [...s.outbox.slice(batch.length), ...followUps];
    sent += batch.length;
    await saveState(s);
  }
  return sent;
}

/**
 * Baza serwera zostala odtworzona z kopii. Niewyslane operacje dotycza stanu,
 * ktorego juz nie ma — nie odtwarzamy ich automatycznie. Pelne pobranie przyjmie
 * stan z kopii; lokalne wpisy, o ktorych serwer nie wie, zostana wyslane jako nowe.
 */
async function handleReset(s: State, generation: string): Promise<void> {
  if (!generation) throw new Error('Serwer nie podał nowej generacji. Wstrzymano synchronizację.');
  const point = await checkpoint('reset', s);
  s.conflicts.push({
    at: point.at, reason: 'reset-checkpoint', title: 'Serwer odtworzono z kopii',
    outcome: `Stan lokalny i niewysłane operacje zachowano w punkcie przywracania z ${new Date(point.at).toLocaleString('pl-PL')}.`,
  });
  s.conflicts[s.conflicts.length - 1].restorePointId = point.id;
  s.pendingDeletes = [];
  s.approvedDeletes = [];
  s.subtreeRefresh = [];
  s.restoreMissing = [];
  s.applyBases = {};
  s.authoritativeApply = [];
  s.reapply = [];
  s.pendingFolders = [];
  s.orderWork = {};
  s.placementSent = {};
  s.brake = {};
  if (s.outbox.length > 0) {
    s.conflicts.push({ at: Date.now(), reason: 'reset', title: `${s.outbox.length} niewysłanych zmian`,
      outcome: 'Serwer przywrócono z kopii — obowiązuje stan z kopii, a te zmiany nie zostały wysłane.' });
  }
  s.outbox = [];
  s.session.generation = generation;
  s.requireFull = true;
  await saveState(s);
}

function serverOrder(s: State, parent: string): string[] {
  return Object.values(s.known).filter(node => node.parentId === parent)
    .sort((a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 : 0)
    .map(node => node.id);
}

function rememberOrder(s: State, parent: string | null | undefined, authoritative = false): void {
  if (!parent) return;
  s.orderWork[parent] ??= { base: serverOrder(s, parent), authoritative: false };
  if (authoritative) s.orderWork[parent].authoritative = true;
  addUnique(s.pendingFolders, parent);
}

function submittedOrder(s: State, op: PlannedOp, index: Map<string, LocalNode>): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const parent of [op.parentId, s.known[op.nodeId]?.parentId]) {
    const lid = parent ? s.mapping.s2l[parent] : undefined;
    const node = lid ? index.get(lid) : undefined;
    if (parent && node) result[parent] = (node.children ?? []).map(child => child.id);
  }
  return result;
}

function rememberApplyBase(s: State, base: KnownNode, acknowledged?: PlannedOp): void {
  const expected = s.applyBases[base.id] ?? structuredClone(base);

  // Gdy nasza edycja zostala potwierdzona, baza zawiera jej wartosc.
  // Pozniejsza edycja uzytkownika jest wtedy nowa lokalna praca,
  // a nie konfliktem z odpowiedzia na jego poprzednia operacje.
  if (acknowledged?.type === 'update') {
    if (acknowledged.title !== undefined) expected.title = acknowledged.title;
    if (acknowledged.url !== undefined) expected.url = acknowledged.url;
  }
  if (acknowledged?.type === 'move' && acknowledged.parentId) {
    expected.parentId = acknowledged.parentId;
  }
  s.applyBases[base.id] = expected;
}

function handleResult(s: State, op: PlannedOp, r: OpResult, followUps: PlannedOp[]): void {
  const titleOf = () => r.node?.title || op.title || s.known[op.nodeId]?.title || '(bez nazwy)';
  const note = (reason: string, outcome: string) => {
    const entry: ConflictNote = { at: Date.now(), reason, title: titleOf(), outcome };
    if (r.node && ['title-changed', 'url-changed'].includes(reason)) {
      const fields: NonNullable<ConflictNote['rejectedContent']>['fields'] = [];
      const base = s.applyBases[op.nodeId] ?? s.known[op.nodeId];
      if (op.title !== undefined && op.title !== r.node.title) {
        fields.push({ field: 'title', base: base?.title ?? null, local: op.title, remote: r.node.title });
      }
      if (op.url !== undefined && op.url !== r.node.url) {
        fields.push({ field: 'url', base: base?.url ?? null, local: op.url, remote: r.node.url });
      }
      if (fields.length) entry.rejectedContent = {
        nodeId: op.nodeId, generation: s.session.generation,
        remoteVersion: r.node.version, fields,
      };
    }
    if (reason === 'moved-elsewhere' && op.parentId) {
      entry.rejectedPlacement = {
        nodeId: op.nodeId, generation: s.session.generation,
        parentId: op.parentId, afterId: op.afterId ?? null, beforeId: op.beforeId ?? null,
      };
    }
    if (op.type === 'delete' && ['edited-since', 'subtree-changed'].includes(reason)) {
      entry.rejectedDeletion = { nodeId: op.nodeId, generation: s.session.generation };
    }
    s.conflicts.push(entry);
  };
  const retry = (patch: Partial<PlannedOp>) => {
    const next = { ...op, ...patch, clientOpId: crypto.randomUUID() };
    const submitted = s.placementSent[op.clientOpId];
    if (submitted) s.placementSent[next.clientOpId] = structuredClone(submitted);
    followUps.push(next);
  };

  if (r.status === 'applied') {
    if (r.node?.deleted) { forget(s, op.nodeId); return; }
    if (!r.node) return;
    const previous = s.known[r.node.id];
    rememberOrder(s, previous?.parentId);
    rememberOrder(s, r.node.parentId);
    if (previous && (op.type === 'update' || op.type === 'move')) {
      rememberApplyBase(s, previous, op);
    }
    s.known[r.node.id] = toKnown(r.node);
    // Potwierdzenie niesie PELNY stan wezla — takze zmiany innej przegladarki
    // i miejsce nadane przez serwer (np. przy force: na koniec folderu).
    // Nakladamy go lokalnie przed nastepnym wykrywaniem zmian.
    if (op.type === 'update' || op.type === 'move') addUnique(s.reapply, r.node.id);
    if ((op.type === 'create' || op.type === 'move') && r.node.parentId) addUnique(s.pendingFolders, r.node.parentId);
    return;
  }

  if (r.status === 'rejected') {
    note(r.reason ?? 'rejected', 'Serwer odrzucił zmianę — zostaje tylko w tej przeglądarce.');
    if (op.type === 'create') {
      const localId = s.mapping.s2l[op.nodeId];
      if (localId) s.rejectedLocal[localId] = r.reason ?? 'rejected';
      unlink(s, op.nodeId);
    }
    return;
  }

  switch (r.reason) {
    case 'exists':
      if (r.node) s.known[r.node.id] = toKnown(r.node);
      return;
    case 'title-changed': case 'url-changed': case 'meta-changed':
      note(r.reason, 'W innej przeglądarce zmieniono to samo — obowiązuje tamta wersja.');
      return;
    case 'moved-elsewhere':
      note(r.reason, 'W innej przeglądarce przeniesiono ten wpis — obowiązuje tamto miejsce.');
      return;
    case 'deleted':
      note(r.reason, 'W innej przeglądarce usunięto ten wpis — przywrócono go, bo był tu zmieniany.');
      followUps.push({ clientOpId: crypto.randomUUID(), type: 'update', nodeId: op.nodeId,
        baseVersion: r.node?.version ?? op.baseVersion, force: true,
        ...(op.title !== undefined ? { title: op.title } : {}), ...(op.url !== undefined ? { url: op.url } : {}) });
      if (op.type === 'move') retry({ force: true });
      return;
    case 'anchor-missing':
      retry({ force: true });
      return;
    case 'parent-missing': case 'parent-deleted':
      note(r.reason, 'Folder docelowy usunięto w innej przeglądarce — wpis trafił do „Inne zakładki”.');
      retry({ parentId: 'root:unsorted', afterId: null, beforeId: null, force: true });
      return;
    case 'edited-since': case 'subtree-changed':
      // Nie kasujemy cudzej pracy: odpinamy poddrzewo, pelne pobranie przywroci je lokalnie
      note(r.reason, 'Usunięcie cofnięte: w innej przeglądarce zmieniono tę zawartość w międzyczasie.');
      // Nie odpinamy ocalalych potomkow ani nie przeladowujemy calego profilu.
      addUnique(s.subtreeRefresh, op.nodeId);
      return;
    default:
      note(r.reason ?? 'conflict', 'Nierozpoznany konflikt — obowiązuje wersja z serwera.');
  }
}

async function detectAndSend(s: State, restore?: RestoreJob): Promise<number> {
  const roots = await readRoots();
  if (await ensureRootMapping(s.mapping, Object.values(s.known).some(k => k.parentId === 'root:menu'))) await saveState(s);

  const filters = compileFilters(await loadFilterConfig());
  const quarantine = new Set(await quarantineIds());
  const menuStandIn = s.mapping.s2l['root:menu'];
  const index = indexTree(roots);
  const diffRoots: LocalNode[] = [...roots];
  if (menuStandIn && index.has(menuStandIn) && !roots.some(r => r.id === menuStandIn))
    diffRoots.push({ ...index.get(menuStandIn)!, kind: 'root' });

  const out = diff({
    roots: diffRoots,
    known: s.known,
    mapping: s.mapping,
    isExcluded: node =>
      node.id === menuStandIn || quarantine.has(node.id) || !!s.rejectedLocal[node.id] ||
      (node.kind === 'bookmark' && filters.isUrlExcluded(node.url ?? '')) ||
      (node.kind === 'folder' && filters.isFolderExcluded(node.title, node.id)),
    newId: () => crypto.randomUUID(),
    newOpId: () => crypto.randomUUID(),
    cursor: s.cursor,
  });

  const confirmed = new Set(restore?.approvedServerIds ?? []);
  const projectedParents = new Map(Object.values(s.known).map(node => [node.id, node.parentId]));
  for (const op of out.ops) {
    if ((op.type === 'create' || op.type === 'move') && op.parentId) {
      projectedParents.set(op.nodeId, op.parentId);
    }
  }

  function covered(id: string): boolean {
    if (!confirmed.has(id)) return false;
    if (s.known[id]?.kind !== 'folder') return true;
    // Sprawdzamy zarowno obecne, jak i planowane poddrzewo. Jesli serwer
    // odrzuci ktorys ruch, zgoda nadal nie obejmie niezatwierdzonego dziecka.
    for (const sid of projectedParents.keys()) {
      if (confirmed.has(sid)) continue;
      for (const projected of [false, true]) {
        const seen = new Set<string>();
        for (let p: string | null | undefined = sid; p && !seen.has(p);
          p = projected ? projectedParents.get(p) : s.known[p]?.parentId) {
          if (p === id) return false;
          seen.add(p);
        }
      }
    }
    return true;
  }

  let ops: State['outbox'] = out.ops.map(op =>
    op.type === 'delete' && covered(op.nodeId) ? { ...op, approved: true } : op);

  // ---- hamulec lokalny: zgoda z importu dotyczy tylko zatwierdzonych wezlow ----
  const deletes = ops.filter(o => o.type === 'delete' && !o.approved).map(o => o.nodeId).sort();
  if (deletes.length > 0) {
    const affected = knownBookmarksUnder(s, deletes);
    const total = Object.values(s.known).filter(k => k.kind === 'bookmark').length;
    const limit = Math.max(BRAKE_ABSOLUTE, Math.floor(total * BRAKE_FRACTION));
    if (affected > limit && !approved(deletes, s.brake.localApproved)) {
      s.brake.local = { ids: deletes, count: affected };
      ops = ops.filter(o => o.type !== 'delete' || o.approved);
    } else {
      s.brake.local = undefined;
      s.brake.localApproved = undefined;
    }
  } else {
    s.brake.local = undefined;
  }

  if (ops.length === 0) { await saveState(s, !!restore); return 0; }

  for (const m of out.newMappings) link(s, m.serverId, m.localId);
  s.outbox = ops;
  for (const op of ops) {
    if (op.type === 'move' || op.type === 'create') {
      s.placementSent[op.clientOpId] = submittedOrder(s, op, index);
    }
  }
  // Zapis kolejki i zakonczenie zadania musza byc jednym zapisem storage.
  await saveState(s, !!restore);
  return flush(s);
}

function knownBookmarksUnder(s: State, roots: string[]): number {
  const byParent = new Map<string, string[]>();
  for (const k of Object.values(s.known)) if (k.parentId) {
    const list = byParent.get(k.parentId) ?? [];
    list.push(k.id);
    byParent.set(k.parentId, list);
  }
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (s.known[id]?.kind === 'bookmark') seen.add(id);
    for (const c of byParent.get(id) ?? []) walk(c);
  };
  roots.forEach(walk);
  return seen.size;
}

// ============================================================
// 5. Pobranie
// ============================================================

async function fetchAll(s: State, after: number): Promise<{ nodes: Map<string, ServerNode>; head: number }> {
  const nodes = new Map<string, ServerNode>();
  let head = after;
  // Wszystkie strony, dopiero potem stosowanie — dziennik oddaje aktualny stan,
  // wiec dziecko moze przyjsc na wczesniejszej stronie niz rodzic
  for (;;) {
    const page = await api.changes(s.session, after);
    if (!s.session.generation) s.session.generation = page.generation;
    for (const n of page.nodes) nodes.set(n.id, n);
    after = page.next;
    head = Math.max(head, page.next);
    if (!page.more) break;
  }
  return { nodes, head };
}

async function pull(s: State, full: boolean): Promise<number> {
  let result;
  const refreshed = [...s.subtreeRefresh];
  try {
    result = await fetchAll(s, full ? 0 : s.cursor);

    if (!full && refreshed.length) {
      // Stanowy dziennik nie ma endpointu poddrzewa. Pobieramy migawke,
      // ale do stosowania wybieramy tylko zakres konfliktu i brakujacych rodzicow.
      const snapshot = await fetchAll(s, 0);
      const selected = new Set(refreshed);
      const candidates = [
        ...Object.values(s.known),
        ...snapshot.nodes.values(),
      ];
      let grew = true;
      while (grew) {
        grew = false;
        for (const node of candidates) {
          if (node.parentId && selected.has(node.parentId) && !selected.has(node.id)) {
            selected.add(node.id);
            grew = true;
          }
        }
      }

      for (const id of [...selected]) {
        const seen = new Set<string>();
        for (let parent = snapshot.nodes.get(id)?.parentId; parent && !seen.has(parent);) {
          seen.add(parent);
          if (!s.mapping.s2l[parent]) selected.add(parent);
          parent = snapshot.nodes.get(parent)?.parentId;
        }
      }

      for (const id of selected) {
        const node = snapshot.nodes.get(id);
        if (!node) continue;
        result.nodes.set(id, node);
        if (!node.deleted && node.kind !== 'root') {
          addUnique(s.reapply, id);
          addUnique(s.restoreMissing, id);
        }
      }
      // Nie przesuwamy kursora do snapshot.head: pomineloby to niezalezne
      // zmiany, ktore powstaly po pierwszym pobraniu.
    }
  } catch (err) {
    if (!(err instanceof api.ResetRequired)) throw err;
    await handleReset(s, err.generation);
    result = await fetchAll(s, 0);
    full = true;
  }
  const { nodes, head } = result;

  if (full) {
    // Zmapowane wezly, o ktorych serwer nie wie (np. po odtworzeniu starszej kopii):
    // odpinamy je, a diff wysle je jako nowe. Nic nie ginie.
    for (const sid of Object.keys(s.mapping.s2l)) {
      if (!sid.startsWith('root:') && !nodes.has(sid)) { unlink(s, sid); delete s.known[sid]; }
    }
  }

  if (nodes.size > 0) {
    const live = [...nodes.values()].filter(n => !n.deleted);
    for (const n of nodes.values()) {
      if (n.deleted && s.known[n.id]) {
        addUnique(s.pendingDeletes, n.id);
        if (n.approved) addUnique(s.approvedDeletes, n.id);
        else s.approvedDeletes = s.approvedDeletes.filter(id => id !== n.id);
      } else if (!n.deleted) {
        s.pendingDeletes = s.pendingDeletes.filter(id => id !== n.id);
        s.approvedDeletes = s.approvedDeletes.filter(id => id !== n.id);
      }
    }
    await applyNodes(s, live, full);
  }
  // Zawsze, nie tylko gdy cos przyszlo: usuniecia wstrzymane hamulcem wykonuja sie
  // po potwierdzeniu, kiedy serwer nie ma juz nic nowego do wyslania
  await deleteLocally(s);

  s.cursor = head;
  s.requireFull = false;
  s.subtreeRefresh = s.subtreeRefresh.filter(id => !refreshed.includes(id));
  return nodes.size;
}

// ============================================================
// Stosowanie lokalne
// ============================================================

/** Przyjmuje stan serwera do known i probuje nalozyc go na przegladarke. */
async function applyNodes(s: State, live: ServerNode[], full: boolean): Promise<void> {
  const previous = new Map<string, KnownNode | undefined>();
  for (const n of live) {
    if (n.kind === 'root') continue;
    const prev = s.known[n.id];
    rememberOrder(s, prev?.parentId, full);
    rememberOrder(s, n.parentId, full);
    previous.set(n.id, prev);
    if (prev) rememberApplyBase(s, prev);
    if (full) addUnique(s.authoritativeApply, n.id);
    s.known[n.id] = toKnown(n);
    if (!prev || prev.order !== n.order || prev.parentId !== n.parentId || full) {
      if (n.parentId) addUnique(s.pendingFolders, n.parentId);
      if (prev?.parentId && prev.parentId !== n.parentId) addUnique(s.pendingFolders, prev.parentId);
    }
    if (full || !prev || n.version > prev.version) addUnique(s.reapply, n.id);
  }
  // Nowy known, stara baza i lista pracy trafiaja do jednego zapisu.
  await saveState(s);
  await reconcile(s, [...previous.entries()], full);
}

/**
 * Doprowadza przegladarke do stanu known dla wezlow w reapply i kolejnosci
 * w pendingFolders. Wszystko, co sie nie udalo, zostaje w tych listach
 * na nastepny przebieg — trwale, wiec nie przepada przy ubiciu wtyczki.
 */
async function reconcile(s: State, previousEntries: [string, KnownNode | undefined][], full: boolean): Promise<void> {
  if (s.reapply.length === 0 && s.pendingFolders.length === 0 && s.pendingDeletes.length === 0) return;
  const previous = new Map(previousEntries);

  const needMenu = Object.values(s.known).some(k => k.parentId === 'root:menu');
  if (await ensureRootMapping(s.mapping, needMenu)) await saveState(s);

  await exclusive(APPLY_LOCK, async () => {
    let index = indexTree(await readRoots());
    const intents = await loadIntents();

    // Rodzice przed dziecmi
    const depth = (sid: string) => { let d = 0; for (let p = s.known[sid]?.parentId; p && d < 1000; d++) p = s.known[p]?.parentId; return d; };
    const queue = [...s.reapply].filter(id => s.known[id]).sort((a, b) => depth(a) - depth(b));
    const done = new Set<string>();

    for (const sid of queue) {
      const k = s.known[sid];
      const outcome = await applyOne(s, k, index, intents, previous.get(sid), full);
      if (outcome === 'retry') {
        const attempts = (s.attempts[sid] ?? 0) + 1;
        s.attempts[sid] = attempts;
        if (attempts >= MAX_ATTEMPTS) {
          s.skipped[sid] = { reason: 'nie udało się zastosować po kilku próbach' };
          s.conflicts.push({ at: Date.now(), reason: 'apply-failed', title: k.title || '(bez nazwy)',
            outcome: 'Nie udało się zapisać tego wpisu w tej przeglądarce — zostaje na serwerze.' });
          done.add(sid);
        }
      } else {
        done.add(sid);
        delete s.attempts[sid];
        if (outcome === 'skip') s.skipped[sid] ??= { reason: 'ta przeglądarka nie obsługuje tego wpisu' };
      }
      if (outcome === 'created') index = indexTree(await readRoots());
    }
    s.reapply = s.reapply.filter(id => !done.has(id) && s.known[id]);
    for (const id of done) delete s.applyBases[id];
    s.authoritativeApply = s.authoritativeApply.filter(id => !done.has(id));
    s.restoreMissing = s.restoreMissing.filter(id => !done.has(id));

    // Mapowanie musi byc trwale przed usunieciem intencji tworzenia.
    // Restart po tym zapisie odczyta mapowanie i rozliczy pozostala intencje.
    await saveState(s);
    await saveIntents({});

    // Kolejnosc — minimalna liczba przesuniec
    const finished = new Set<string>();
    for (const serverFolder of [...s.pendingFolders]) {
      const localFolder = s.mapping.s2l[serverFolder];
      if (!localFolder || !(await exists(localFolder))) {
        if (!s.known[serverFolder] && !serverFolder.startsWith('root:')) {
          finished.add(serverFolder);
          delete s.orderWork[serverFolder];
        }
        continue;
      }

      rememberOrder(s, serverFolder, full);
      const work = s.orderWork[serverFolder];
      try {
        const complete = await runOrder(work, {
          read: () => childIds(localFolder),
          remote: () => serverOrder(s, serverFolder)
            .map(id => s.mapping.s2l[id]).filter((id): id is string => !!id),
          localId: id => s.mapping.s2l[id],
          save: () => saveState(s),
          move: (id, index, before) => moveWithin(id, localFolder, index, before),
          conflict: async localOrder => {
            const rejectedPlacement = {
              nodeId: serverFolder,
              generation: s.session.generation,
              parentId: serverFolder,
              afterId: null,
              beforeId: null,
              order: localOrder.map(id => s.mapping.l2s[id]).filter((id): id is string => !!id),
            };
            if (!s.conflicts.some(note => !note.restoredAt &&
              JSON.stringify(note.rejectedPlacement) === JSON.stringify(rejectedPlacement))) {
              s.conflicts.push({
                at: Date.now(),
                reason: 'order-changed',
                title: s.known[serverFolder]?.title ||
                  ROOT_LABELS[serverFolder as keyof typeof ROOT_LABELS] || '(folder)',
                outcome: 'Kolejność zmieniono w obu przeglądarkach. Zachowano Twoją wersję do przywrócenia.',
                rejectedPlacement,
              });
            }
            await saveState(s);
          },
        });

        if (complete) {
          finished.add(serverFolder);
          delete s.orderWork[serverFolder];
        }
      } catch {
        // Dziennik before/after pozostaje do rozliczenia w nastepnym przebiegu.
      }
    }
    s.pendingFolders = s.pendingFolders.filter(id => !finished.has(id));
  });

  await saveState(s);
}

type Outcome = 'ok' | 'created' | 'retry' | 'skip';

async function applyOne(
  s: State, k: KnownNode, index: Map<string, LocalNode>, intents: Record<string, Intent>,
  prev: KnownNode | undefined, full: boolean,
): Promise<Outcome> {
  full ||= s.authoritativeApply.includes(k.id);
  if (k.kind === 'root' || !k.parentId) return 'ok';
  if (s.skipped[k.parentId]) return 'skip';   // rodzica nie da sie tu odtworzyc — dziecka tez

  const parentLocal = s.mapping.s2l[k.parentId];
  if (!parentLocal || !(index.has(parentLocal) || (await exists(parentLocal)))) return 'retry';

  const localId = s.mapping.s2l[k.id];
  // Indeks pochodzi sprzed innych operacji i mogl sie zdezaktualizowac.
  const local = localId ? await nodeFresh(localId) : undefined;

  if (!local) {
    // Zmapowany, niezmieniony na serwerze, a lokalnie brak: uzytkownik wlasnie go usunal.
    // Usuniecie wyjdzie w nastepnym przebiegu — nie odtwarzamy go.
    const base = s.applyBases[k.id] ?? prev;
    if (localId && !full && base && !s.restoreMissing.includes(k.id)) {
      const changedContent = base.title !== k.title || base.url !== k.url;
      if (!changedContent) return 'ok';

      // Lokalne usuniecie kontra zdalna edycja tresci: zachowujemy decyzje
      // o usunieciu, zanim odtworzymy zmieniony wpis serwera.
      if (!s.conflicts.some(note => note.rejectedDeletion?.nodeId === k.id &&
        note.rejectedDeletion.generation === s.session.generation && !note.restoredAt)) {
        s.conflicts.push({
          at: Date.now(), reason: 'local-delete-conflict', title: k.title || '(bez nazwy)',
          outcome: 'Odtworzono wpis zmieniony w innej przeglądarce. Twoją decyzję o usunięciu zachowano.',
          rejectedDeletion: { nodeId: k.id, generation: s.session.generation },
        });
        await saveState(s);
      }
    }

    intents[k.id] = { parent: parentLocal, kind: k.kind, title: k.title, url: k.url, at: Date.now() };
    await saveIntents(intents);
    try {
      const created = await createLocal(parentLocal, k.kind as never, k.title, k.url);
      intents[k.id].created = created;
      await saveIntents(intents);
      if (localId) delete s.mapping.l2s[localId];
      link(s, k.id, created);
      delete s.skipped[k.id];
      addUnique(s.pendingFolders, k.parentId);
      return 'created';
    } catch (err) {
      delete intents[k.id];
      await saveIntents(intents);
      return err instanceof Unrepresentable ? 'skip' : 'retry';
    }
  }

  try {
    const base = s.applyBases[k.id] ?? prev;
    const merged = mergeContent(
      base,
      { title: local.title, url: local.url ?? null },
      { title: k.title, url: k.url },
      { title: k.kind !== 'separator', url: k.kind === 'bookmark', authoritative: full },
    );

    if (merged.conflicts.length > 0) {
      const rejectedContent = {
        nodeId: k.id,
        generation: s.session.generation,
        remoteVersion: k.version,
        fields: merged.conflicts,
      };
      const signature = JSON.stringify(rejectedContent);
      if (!s.conflicts.some(note => JSON.stringify(note.rejectedContent) === signature)) {
        s.conflicts.push({
          at: Date.now(),
          reason: 'content-changed',
          title: local.title || '(bez nazwy)',
          outcome: 'To samo pole zmieniono w obu przeglądarkach. Zastosowano wersję serwera; Twoją odrzuconą wartość zachowano.',
          rejectedContent,
        });
      }
      // Nie nadpisujemy odrzuconej wartosci, dopoki nie ma trwalej kopii.
      await saveState(s);
    }

    const checkedContent = await nodeFresh(local.id);
    if (!checkedContent || checkedContent.title !== local.title ||
      (checkedContent.url ?? null) !== (local.url ?? null) ||
      checkedContent.parentId !== local.parentId) {
      return 'retry';
    }
    await updateLocal(local.id, merged.changes);

    // Tytul i URL mogly wymagac zapisu storage. Odczytujemy rodzica ponownie.
    const current = await nodeFresh(local.id);
    if (!current) return 'retry';
    if (current.parentId !== parentLocal) {
      const currentParent = current.parentId ? s.mapping.l2s[current.parentId] : undefined;
      const localMoved = !!base && currentParent !== base.parentId;
      const remoteMoved = !!base && k.parentId !== base.parentId;

      if (!full && localMoved && !remoteMoved) {
        // Lokalny ruch pozostaje do wyslania zwyklym diffem.
        return 'ok';
      }

      let placementBefore: string[] | undefined;
      if (!full && localMoved && remoteMoved && current.parentId) {
        const siblings = await childIds(current.parentId);
        placementBefore = siblings;
        const at = siblings.indexOf(current.id);
        const mapped = (id: string | undefined) => id ? s.mapping.l2s[id] ?? null : null;
        if (currentParent) {
          const rejectedPlacement = {
            nodeId: k.id, generation: s.session.generation, parentId: currentParent,
            afterId: mapped(siblings[at - 1]), beforeId: mapped(siblings[at + 1]),
          };
          if (!s.conflicts.some(note =>
            JSON.stringify(note.rejectedPlacement) === JSON.stringify(rejectedPlacement) && !note.restoredAt)) {
            s.conflicts.push({
              at: Date.now(), reason: 'parent-changed', title: current.title || '(bez nazwy)',
              outcome: 'Wpis przeniesiono w obu przeglądarkach. Zastosowano miejsce z serwera; Twoje miejsce zachowano.',
              rejectedPlacement,
            });
          }
          await saveState(s);
        } else {
          // Niezmapowany rodzic jest nowym lokalnym folderem. Diff musi
          // najpierw utworzyc ten folder; nie wyciagamy z niego wpisu.
          return 'ok';
        }
      }

      const checked = await nodeFresh(current.id);
      if (!checked || checked.parentId !== current.parentId) return 'retry';
      if (placementBefore && current.parentId &&
        !sameOrder(await childIds(current.parentId), placementBefore)) return 'retry';
      await moveToFolderEnd(current.id, parentLocal);
      addUnique(s.pendingFolders, k.parentId);
    }
    return 'ok';
  } catch {
    return 'retry';
  }
}

async function nodeFresh(id: string): Promise<LocalNode | undefined> {
  try {
    const [n] = await wx.bookmarks.get(id);
    if (!n) return undefined;
    return { id: n.id, parentId: n.parentId, kind: n.url !== undefined ? 'bookmark' : 'folder', title: n.title ?? '', url: n.url };
  } catch { return undefined; }
}

/**
 * Usuniecia przychodzace z serwera.
 *
 * Od najglebszych, i wylacznie wpisy objete tombstone'em. Folder usuwamy dopiero
 * pusty: lokalne dzieci, ktorych serwer nie kasowal (wykluczone filtrem, nigdy
 * niewyslane), przenosimy wyzej, do najblizszego przetrwalego folderu. Poprzednia
 * wersja wolala removeTree i zabierala je razem z folderem (znalezisko Codexa).
 */
async function deleteLocally(s: State): Promise<void> {
  if (s.pendingDeletes.length === 0) return;
  await preserveEditedBeforeDelete(s);
  if (s.pendingDeletes.length === 0) return;
  const roots = await readRoots();
  const index = indexTree(roots);
  const doomed = new Set(s.pendingDeletes);

  const approvedByOrigin = new Set(s.approvedDeletes);
  const ids = [...doomed].filter(id => !approvedByOrigin.has(id)).sort();
  const affected = ids.filter(id => index.get(s.mapping.s2l[id])?.kind === 'bookmark').length;
  const total = roots.reduce((sum, r) => sum + countBookmarks(r), 0);
  const limit = Math.max(BRAKE_ABSOLUTE, Math.floor(total * BRAKE_FRACTION));
  const blocked = affected > limit && !approved(ids, s.brake.remoteApproved);
  s.brake.remote = blocked ? { ids, count: affected } : undefined;
  s.brake.remoteApproved = undefined;

  const ready = blocked ? [...doomed].filter(id => approvedByOrigin.has(id)) : [...doomed];
  const localDepth = (lid: string) => { let d = 0; for (let p = index.get(lid)?.parentId; p && d < 1000; p = index.get(p)?.parentId) d++; return d; };
  const order = ready.sort((a, b) => localDepth(s.mapping.s2l[b] ?? '') - localDepth(s.mapping.s2l[a] ?? ''));

  if (ready.filter(id => index.get(s.mapping.s2l[id])?.kind === 'bookmark').length > limit) {
    await checkpoint('remote-delete', s);
  }

  await exclusive(APPLY_LOCK, async () => {
    for (const sid of order) {
      const lid = s.mapping.s2l[sid];
      if (!lid || !(await exists(lid))) { forget(s, sid); continue; }

      const node = index.get(lid);
      if (node && node.kind !== 'bookmark' && node.kind !== 'separator') {
        // Chronione dzieci w gore — do rodzica usuwanego folderu
        const parent = node.parentId;
        for (const child of await children(lid)) {
          const childSid = s.mapping.l2s[child.id];
          if (childSid && doomed.has(childSid)) continue;   // usuniecie dziecka nie wyszlo — folder zostaje
          if (parent) { try { await moveTo(child.id, parent); } catch { /* sprobujemy w nastepnym przebiegu */ } }
        }
      }
      if (await removeLocal(lid)) forget(s, sid);
    }
  });

  s.pendingDeletes = s.pendingDeletes.filter(id => s.known[id] || s.mapping.s2l[id]);
}

// ============================================================
// Pomocniki stanu
// ============================================================

async function preserveEditedBeforeDelete(s: State): Promise<void> {
  const doomed = new Set(s.pendingDeletes);
  const index = indexTree(await readRoots());
  const keep = new Set<string>();
  const filters = compileFilters(await loadFilterConfig());
  const quarantine = new Set(await quarantineIds());

  for (const sid of doomed) {
    const local = index.get(s.mapping.s2l[sid]);
    const base = s.applyBases[sid] ?? s.known[sid];
    if (!local || !base) continue;

    const parent = local.parentId ? s.mapping.l2s[local.parentId] : undefined;
    const edited = local.title !== base.title ||
      (local.kind === 'bookmark' && (local.url ?? null) !== base.url) ||
      parent !== base.parentId;

    const newChild = local.kind === 'folder' && (local.children ?? []).some(child =>
      !s.mapping.l2s[child.id] && !quarantine.has(child.id) &&
      !(child.kind === 'folder' && filters.isFolderExcluded(child.title, child.id)) &&
      !(child.kind === 'bookmark' && filters.isUrlExcluded(child.url ?? '')));

    if (edited || newChild) keep.add(sid);
  }

  // Przywrocenie potomka wymaga zywych przodkow. Zachowujemy ich GUID-y.
  for (const sid of [...keep]) {
    const seen = new Set<string>();
    for (let parent = s.known[sid]?.parentId; parent && !seen.has(parent);
      parent = s.known[parent]?.parentId) {
      seen.add(parent);
      if (doomed.has(parent)) keep.add(parent);
    }
  }
  if (!keep.size) return;

  await checkpoint('remote-delete', s);
  const depth = (sid: string) => {
    let value = 0;
    const seen = new Set<string>();
    for (let p = s.known[sid]?.parentId; p && !seen.has(p); p = s.known[p]?.parentId) {
      seen.add(p);
      value++;
    }
    return value;
  };

  const recovery: PlannedOp[] = [];
  for (const sid of [...keep].sort((a, b) => depth(a) - depth(b))) {
    const node = s.known[sid];
    if (!node || node.kind === 'root') continue;
    const local = index.get(s.mapping.s2l[sid]);
    recovery.push({
      clientOpId: crypto.randomUUID(), type: 'update', nodeId: sid,
      baseVersion: node.version, force: true,
      ...(node.kind !== 'separator' ? { title: local?.title ?? node.title } : {}),
      ...(node.kind === 'bookmark' ? { url: local?.url ?? node.url ?? '' } : {}),
    });
  }

  s.outbox.push(...recovery);
  s.pendingDeletes = s.pendingDeletes.filter(id => !keep.has(id));
  s.approvedDeletes = s.approvedDeletes.filter(id => !keep.has(id));
  s.conflicts.push({
    at: Date.now(), reason: 'edited-before-delete', title: `${keep.size} zachowanych wpisów`,
    outcome: 'Nie usunięto lokalnie zmienionych wpisów ani potrzebnych im folderów. Zmiany zapisano do wysłania; powstał punkt przywracania.',
  });
  await saveState(s);
}

function toKnown(n: ServerNode): KnownNode {
  return { id: n.id, parentId: n.parentId, kind: n.kind, title: n.title, url: n.url, order: n.order, version: n.version };
}

function addUnique(list: string[], id: string): void { if (!list.includes(id)) list.push(id); }

function link(s: State, sid: string, lid: string): void {
  const previous = s.mapping.s2l[sid];
  if (previous) delete s.mapping.l2s[previous];
  s.mapping.s2l[sid] = lid;
  s.mapping.l2s[lid] = sid;
}

function forget(s: State, sid: string): void {
  unlink(s, sid);
  delete s.known[sid];
  delete s.skipped[sid];
  delete s.attempts[sid];
  delete s.applyBases[sid];
  s.authoritativeApply = s.authoritativeApply.filter(id => id !== sid);
  s.restoreMissing = s.restoreMissing.filter(id => id !== sid);
  s.subtreeRefresh = s.subtreeRefresh.filter(id => id !== sid);
  delete s.orderWork[sid];
  s.reapply = s.reapply.filter(x => x !== sid);
  s.pendingDeletes = s.pendingDeletes.filter(x => x !== sid);
  s.approvedDeletes = s.approvedDeletes.filter(x => x !== sid);
}

function unlink(s: State, sid: string): void {
  const lid = s.mapping.s2l[sid];
  if (lid) delete s.mapping.l2s[lid];
  delete s.mapping.s2l[sid];
}


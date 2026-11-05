// Typy wspoldzielone. DTO odpowiadaja server/Sync/SyncModels.cs.

import type { Kind, KnownNode, PlannedOp as CorePlannedOp } from './core/diff.js';
import type { RestoreTree } from './core/restore.js';
export type { Kind, KnownNode };

export type PlannedOp = CorePlannedOp & { approved?: boolean };

export interface ServerNode {
  id: string;
  parentId: string | null;
  kind: Kind | 'root';
  title: string;
  url: string | null;
  order: string;
  meta: Record<string, unknown>;
  deleted: boolean;
  approved?: boolean;
  version: number;
  seq: number;
}

export interface ChangesResponse {
  nodes: ServerNode[];
  next: number;
  more: boolean;
  head: number;
  generation: string;
}

export interface OpResult {
  clientOpId: string;
  status: 'applied' | 'conflict' | 'rejected';
  reason?: string;
  node?: ServerNode;
  duplicate?: boolean;
}

export interface OpsResponse {
  results: OpResult[];
  head: number;
}

export interface ServerSession {
  url: string;
  token: string;
  deviceId: string;
  deviceName: string;
  profile: { id: string; name: string };
  generation: string;
}

export interface Settings {
  autoSync: boolean;
  pollMinutes: number;
  /** Kafelki FrogSync na nowej karcie; false = pusta karta. */
  startPage: boolean;
  /** Opera: przekierowanie Speed Dialu nowej karty na strone FrogSync (wymaga zgody "tabs"). */
  operaNewTab: boolean;
  /** Podpowiedzi z zakladek w polu wyszukiwania. */
  searchBookmarks: boolean;
  /** Podpowiedzi Google — wpisywany tekst idzie do Google; wymaga zgody na suggestqueries.google.com. */
  googleSuggest: boolean;
  /** Enter na tekscie, ktory jest adresem, otwiera strone zamiast szukac. */
  enterOpensAddress: boolean;
  /** Przyciski pod polem (najwyzej 6), w tej kolejnosci. */
  pinnedEngines: string[];
  /** Wyszukiwarka dla Enter. */
  defaultEngine: string;
}

export const DEFAULT_SETTINGS: Settings = {
  autoSync: true, pollMinutes: 1, startPage: true, operaNewTab: false,
  searchBookmarks: false, googleSuggest: false, enterOpensAddress: true,
  pinnedEngines: ['google', 'allegro', 'youtube', 'maps'], defaultEngine: 'google',
};

export type ConnectionState =
  | 'unpaired'
  | 'no-permission'
  | 'offline'
  | 'cert'
  | 'revoked'
  | 'error'
  | 'outdated'
  | 'ok';

export interface SyncStatus {
  connection: ConnectionState;
  lastSyncAt?: number;
  lastError?: string;
  consecutiveFailures?: number;
  minExtensionVersion?: string;
  latestExtensionVersion?: string;
  updateAvailable?: boolean;
  pendingOps: number;
  localCount: number;
  pulled: number;
  pushed: number;
  conflicts: number;
  skipped: number;
  /** Usuniecia z innej przegladarki wstrzymane hamulcem. */
  blockedDeletions?: number;
  /** Masowe usuniecie w tej przegladarce wstrzymane przed wyslaniem. */
  blockedLocalDeletions?: number;
}

export interface RejectedContent {
  nodeId: string;
  generation: string;
  remoteVersion: number;
  fields: {
    field: 'title' | 'url';
    base: string | null;
    local: string | null;
    remote: string | null;
  }[];
}

export interface RejectedPlacement {
  nodeId: string;
  generation: string;
  parentId: string;
  afterId: string | null;
  beforeId: string | null;
}

export interface RejectedDeletion {
  nodeId: string;
  generation: string;
}

export interface ConflictNote {
  at: number;
  reason: string;
  title: string;
  outcome: string;
  /** Odrzucona wartosc zostaje zapisana przed zmiana w przegladarce. */
  rejectedContent?: RejectedContent;
  rejectedPlacement?: RejectedPlacement;
  rejectedDeletion?: RejectedDeletion;
  restorePointId?: string;
  /** Operacja odzyskania zostala trwale dodana do kolejki. */
  restoredAt?: number;
}

export type Message =
  | { type: 'GET_STATUS' }
  | { type: 'SYNC_NOW' }
  | { type: 'PREVIEW'; url: string; code: string }
  | { type: 'PAIR'; url: string; code: string; mode: 'replace' | 'merge'; expectContent: boolean }
  | { type: 'UNPAIR' }
  | { type: 'CONFIRM_DELETIONS'; which: 'remote' | 'local' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; settings: Partial<Settings> }
  | { type: 'GET_FILTERS' }
  | { type: 'SAVE_FILTERS'; config: unknown }
  | { type: 'CLEAR_CONFLICTS' }
  | { type: 'PREVIEW_RESTORE'; tree: RestoreTree }
  | { type: 'RUN_RESTORE'; tree: RestoreTree; summaryId: string }
  | { type: 'LIST_RESTORE_POINTS' }
  | { type: 'PREVIEW_UNDO'; id: string }
  | { type: 'UNDO_TO_POINT'; id: string; summaryId: string }
  | { type: 'RESTORE_CONFLICT'; id: string }
  | { type: 'EXPORT_POINT_HTML'; id: string };

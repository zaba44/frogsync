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
}

export const DEFAULT_SETTINGS: Settings = { autoSync: true, pollMinutes: 1 };

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

export interface ConflictNote {
  at: number;
  reason: string;
  title: string;
  outcome: string;
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
  | { type: 'EXPORT_POINT_HTML'; id: string };

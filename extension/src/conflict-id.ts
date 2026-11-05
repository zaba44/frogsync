import type { ConflictNote } from './types.js';

/** Dziala rowniez dla notatek zapisanych przed dodaniem przycisku odzyskania. */
export function conflictId(note: ConflictNote): string {
  return JSON.stringify([
    note.at,
    note.reason,
    note.title,
    note.rejectedContent ?? null,
    note.rejectedPlacement ?? null,
    note.rejectedDeletion ?? null,
  ]);
}

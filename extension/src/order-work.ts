import { planReorder, type LocalMove } from './core/reorder.js';

export interface OrderWork {
  /** Kolejnosc serwerowa sprzed przyjecia zmian; identyfikatory serwerowe. */
  base: string[];
  authoritative: boolean;
  /** Ostatnia oczekiwana kolejnosc lokalna po naszych ruchach. */
  expected?: string[];
  /** Kolejnosc serwera, wzgledem ktorej podjeto ostatnia decyzje. */
  remote?: string[];
  target?: string[];
  writing?: { before: string[]; after: string[]; move: LocalMove };
}

export interface OrderIO {
  read(): Promise<string[]>;
  remote(): string[];
  localId(serverId: string): string | undefined;
  save(): Promise<void>;
  conflict(localOrder: string[]): Promise<void>;
  move(id: string, index: number, before: string[]): Promise<void>;
}

export const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

export function mergeOrder(
  baseLocal: string[],
  baseRemote: string[],
  local: string[],
  remote: string[],
) {
  const present = new Set(local);
  const remoteSet = new Set(remote);
  const baseSet = new Set(baseLocal);
  const common = new Set(
    baseRemote.filter(id => present.has(id) && remoteSet.has(id) && baseSet.has(id)),
  );
  const project = (ids: string[]) => ids.filter(id => common.has(id));
  const l = project(local);
  const r = project(remote);
  const localChanged = !sameOrder(l, project(baseLocal));
  const remoteChanged = !sameOrder(r, project(baseRemote));
  const conflict = localChanged && remoteChanged && !sameOrder(l, r);

  // Nowe pozycje serwera zachowuja swoje miejsca. Lokalny ruch zmienia
  // wzajemny porzadek wspolnych pozycji, a nie indeksy dodanych sasiadow.
  let cursor = 0;
  const desired = localChanged && !remoteChanged
    ? remote.map(id => common.has(id) ? l[cursor++] : id)
    : [...remote];

  return { desired, conflict };
}

/**
 * Wywolywac pod MAIN_LOCK i APPLY_LOCK.
 * Kazdy ruch ma zapisane before/after. Odrzucona obietnica move nie jest
 * dowodem, ze ruch sie nie wykonal.
 */
export async function runOrder(work: OrderWork, io: OrderIO): Promise<boolean> {
  for (let step = 0; step < 10000; step++) {
    let current = await io.read();

    if (work.writing) {
      const write = work.writing;
      if (sameOrder(current, write.after)) {
        work.expected = [...write.after];
      } else if (!sameOrder(current, write.before)) {
        // Inny wynik moze oznaczac pozniejsza edycje uzytkownika.
        // Nie ponawiamy starego planu na tym stanie.
        delete work.target;
      }
      delete work.writing;
      await io.save();
      current = await io.read();
    }

    const present = new Set(current);
    const remote = io.remote().filter(id => present.has(id));
    const changed = !work.expected || !sameOrder(current, work.expected) ||
      !work.remote || !sameOrder(remote, work.remote);

    if (!work.target || changed || work.authoritative) {
      const base = work.base.map(id => io.localId(id))
        .filter((id): id is string => !!id);
      const decision = work.authoritative && !work.expected
        ? { desired: remote, conflict: false }
        : mergeOrder(work.expected ?? base, work.remote ?? base, current, remote);

      work.expected = [...current];
      work.remote = [...remote];
      work.target = [...decision.desired];
      work.authoritative = false;
      await io.save();

      if (decision.conflict) {
        const synced = new Set(remote);
        await io.conflict(current.filter(id => synced.has(id)));
      }

      // Zapis zadania i notatki oddaje sterowanie.
      const checked = await io.read();
      if (!sameOrder(checked, current)) {
        delete work.target;
        continue;
      }
    }

    const target = work.target!;
    const wanted = new Set(target);
    if (sameOrder(current.filter(id => wanted.has(id)), target)) return true;

    const move = planReorder(current, target)[0];
    if (!move) return false;

    const after = [...current];
    const from = after.indexOf(move.id);
    if (from < 0) return false;
    after.splice(from, 1);
    after.splice(move.index, 0, move.id);

    work.writing = { before: [...current], after, move };
    await io.save();

    const checked = await io.read();
    if (!sameOrder(checked, current)) {
      delete work.writing;
      delete work.target;
      continue;
    }

    // Przy utracie odpowiedzi writing pozostaje w storage.
    await io.move(move.id, move.index, current);
    const actual = await io.read();
    if (sameOrder(actual, after)) {
      work.expected = [...after];
    } else {
      delete work.target;
    }
    delete work.writing;
    await io.save();
  }
  return false;
}

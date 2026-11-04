import { longestIncreasing } from './diff.js';

// ============================================================
// Lokalne przestawianie dzieci folderu po pobraniu zmian z serwera.
//
// Przenosimy minimalna liczbe wezlow (n - najdluzszy zachowany ciag), zeby
// nie wywolywac lawiny zdarzen onMoved i nie przestawiac rzeczy bez potrzeby.
// Wezly niesynchronizowane (wykluczone filtrem) zachowuja swoja wzajemna kolejnosc.
// ============================================================

/** index = POZYCJA DOCELOWA po przeniesieniu (semantyka Firefoksa). */
export interface LocalMove {
  id: string;
  index: number;
}

/**
 * @param current        wszystkie dzieci folderu w obecnej kolejnosci
 * @param desiredSynced  synchronizowane dzieci w kolejnosci serwera (podzbior current)
 * @returns przesuniecia do wykonania SEKWENCYJNIE, w podanej kolejnosci
 */
export function planReorder(current: string[], desiredSynced: string[]): LocalMove[] {
  const wanted = new Set(desiredSynced);
  const rank = new Map(desiredSynced.map((id, i) => [id, i]));

  const syncedNow = current.filter(id => wanted.has(id));
  const keep = new Set(longestIncreasing(syncedNow.map(id => rank.get(id)!)).map(i => syncedNow[i]));

  const list = [...current];
  const moves: LocalMove[] = [];

  // Od lewej do prawej wg kolejnosci docelowej: kazdy przenoszony wezel trafia
  // tuz za swojego docelowego poprzednika, ktory jest juz na wlasciwym miejscu
  for (let i = 0; i < desiredSynced.length; i++) {
    const id = desiredSynced[i];
    if (keep.has(id) || !list.includes(id)) continue;

    list.splice(list.indexOf(id), 1);

    let target: number;
    if (i > 0) {
      target = list.indexOf(desiredSynced[i - 1]) + 1;
    } else {
      // Pierwszy w kolejnosci: przed pierwszym innym synchronizowanym wezlem,
      // zeby niesynchronizowane elementy na poczatku zostaly na poczatku
      const firstSynced = list.findIndex(x => wanted.has(x));
      target = firstSynced >= 0 ? firstSynced : list.length;
    }

    list.splice(target, 0, id);
    moves.push({ id, index: target });
  }

  return moves;
}

/**
 * Przelicza pozycje docelowa (semantyka Firefoksa) na argument index dla Chromium.
 *
 * Chromium interpretuje index wzgledem listy SPRZED wyjecia elementu: przy
 * przesuwaniu w dol w obrebie tego samego folderu sam odejmuje jeden
 * (BookmarkModel::Move: "if (index > old_index) index--"). Zeby element
 * wyladowal na pozycji t, trzeba wiec podac t + 1, gdy obecna pozycja < t.
 * Przy przesuwaniu w gore albo do innego folderu indeks jest ten sam.
 *
 * @param currentChildren dzieci folderu docelowego PRZED przeniesieniem
 */
export function chromiumIndex(currentChildren: string[], id: string, targetIndex: number): number {
  const from = currentChildren.indexOf(id);
  return from >= 0 && from < targetIndex ? targetIndex + 1 : targetIndex;
}

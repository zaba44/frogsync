import type { Kind, LocalNode } from './diff.js';

// ============================================================
// Plan pierwszego polaczenia przegladarki z NIEPUSTYM profilem.
//
// Czysta funkcja: wejscie to drzewo przegladarki i stan serwera, wyjscie to
// lista par do adopcji i lista rzeczy do odlozenia. Silnik wykonuje plan,
// a po przerwaniu po prostu liczy go od nowa z aktualnego drzewa — to, co
// juz trafilo do kwarantanny, jest dla planu niewidoczne, wiec wznowienie
// niczego nie przenosi dwa razy.
//
// Tryby:
//   replace — przegladarka dostaje dokladnie kolekcje z serwera; jej zakladki,
//             ktorych serwer nie zna, ida do "Zakladki sprzed FrogSync"
//             (nie sa wysylane ani kasowane). Domyslny: chroni baze przed
//             zakladkami producenta nowej przegladarki.
//   merge   — dopasowane zostaja, reszta zostanie wyslana jako nowe wpisy.
// ============================================================

export interface PlanServerNode {
  id: string;
  parentId: string | null;
  kind: Kind | 'root';
  title: string;
  url: string | null;
  order: string;
}

export interface QuarantineMove {
  localId: string;
  /** Pochodzenie odtwarzane w kwarantannie, np. ["Pasek zakladek", "Praca"]. */
  path: string[];
}

export interface BootstrapPlan {
  pairs: { serverId: string; localId: string }[];
  quarantine: QuarantineMove[];
}

export interface BootstrapInput {
  mode: 'replace' | 'merge';
  /** Zywe wezly serwera (bez usunietych). */
  server: PlanServerNode[];
  /** Korzenie przegladarki: id lokalne korzenia -> { serverRootId, label }. */
  roots: { local: LocalNode; serverId: string; label: string }[];
  /** Juz zmapowane id lokalne (np. po wznowieniu) — nie dopasowujemy ich drugi raz. */
  alreadyMapped: Set<string>;
  /** Wezly niewidoczne: kwarantanna, folder zastepczy menu, wykluczone filtrem. */
  isHidden(node: LocalNode): boolean;
}

const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function planBootstrap(input: BootstrapInput): BootstrapPlan {
  const byParent = new Map<string, PlanServerNode[]>();
  for (const n of input.server) {
    if (!n.parentId) continue;
    const list = byParent.get(n.parentId) ?? [];
    list.push(n);
    byParent.set(n.parentId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => ordinal(a.order, b.order));

  const pairs: BootstrapPlan['pairs'] = [];
  const quarantine: QuarantineMove[] = [];
  const pairedServer = new Set<string>();

  const visit = (serverId: string, local: LocalNode, path: string[]) => {
    const free = (local.children ?? []).filter(c => !input.isHidden(c) && !input.alreadyMapped.has(c.id));
    const used = new Set<string>();

    const take = (predicate: (c: LocalNode) => boolean) => {
      const found = free.find(c => !used.has(c.id) && predicate(c));
      if (found) used.add(found.id);
      return found;
    };

    // Dopasowanie jeden do jednego, w kolejnosci serwera: najpierw adres i tytul,
    // potem sam adres; foldery po nazwie; separatory po kolei
    const serverChildren = (byParent.get(serverId) ?? []).filter(n => !pairedServer.has(n.id));
    const matches: { server: PlanServerNode; local: LocalNode }[] = [];
    for (const n of serverChildren.filter(n => n.kind === 'bookmark')) {
      const m = take(c => c.kind === 'bookmark' && c.url === n.url && c.title === n.title);
      if (m) matches.push({ server: n, local: m });
    }
    for (const n of serverChildren.filter(n => n.kind === 'bookmark' && !matches.some(x => x.server === n))) {
      const m = take(c => c.kind === 'bookmark' && c.url === n.url);
      if (m) matches.push({ server: n, local: m });
    }
    for (const n of serverChildren.filter(n => n.kind === 'folder')) {
      const m = take(c => c.kind === 'folder' && c.title === n.title);
      if (m) matches.push({ server: n, local: m });
    }
    for (const n of serverChildren.filter(n => n.kind === 'separator')) {
      const m = take(c => c.kind === 'separator');
      if (m) matches.push({ server: n, local: m });
    }

    for (const { server, local: matched } of matches) {
      pairs.push({ serverId: server.id, localId: matched.id });
      pairedServer.add(server.id);
      if (server.kind === 'folder') visit(server.id, matched, [...path, matched.title]);
    }

    // Folder dopasowany po nazwie, ale z dodatkowymi dziecmi: dopasowane zostaja,
    // nadmiarowe ida do kwarantanny z odtworzona sciezka. Niedopasowane poddrzewo
    // przenosimy w calosci — jednym ruchem, nie wpis po wpisie.
    if (input.mode === 'replace') {
      for (const c of free) if (!used.has(c.id)) quarantine.push({ localId: c.id, path });
    }
  };

  for (const root of input.roots) visit(root.serverId, root.local, [root.label]);

  return { pairs, quarantine };
}

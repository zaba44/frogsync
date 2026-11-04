// ============================================================
// Testy rdzenia: diff() i planReorder().
//
// Najwazniejszy jest test wlasnosci: losowe drzewo, losowe edycje uzytkownika,
// diff wylicza operacje, SYMULATOR SERWERA stosuje je po kolei dokladnie tak,
// jak robi to SyncService.Place — i wynik na serwerze musi byc identyczny
// z drzewem w przegladarce. Bez zadnego konfliktu.
// ============================================================

import { diff, longestIncreasing, type KnownNode, type LocalNode, type Mapping, type PlannedOp } from '../src/core/diff.js';
import { planReorder, chromiumIndex } from '../src/core/reorder.js';

let failures = 0;
let checks = 0;
function expect(condition: boolean, message: string) {
  checks++;
  if (!condition) { failures++; if (failures <= 15) console.error('FAIL  ' + message); }
}

// Deterministyczny generator, zeby blad dalo sie odtworzyc z numeru ziarna
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

// ============================================================
// Symulator serwera — tablice dzieci zamiast kluczy kolejnosci
// ============================================================

interface SNode { id: string; parentId: string | null; kind: string; title: string; url: string | null; version: number; }

class Server {
  nodes = new Map<string, SNode>();
  children = new Map<string, string[]>();

  addRoot(id: string) { this.nodes.set(id, { id, parentId: null, kind: 'root', title: id, url: null, version: 1 }); this.children.set(id, []); }

  place(parentId: string, id: string, afterId?: string | null, beforeId?: string | null): string | null {
    const list = this.children.get(parentId)!;
    if (afterId == null && beforeId == null) { list.unshift(id); return null; }
    if (afterId != null) { const i = list.indexOf(afterId); if (i >= 0) { list.splice(i + 1, 0, id); return null; } }
    if (beforeId != null) { const i = list.indexOf(beforeId); if (i >= 0) { list.splice(i, 0, id); return null; } }
    if (afterId == null && beforeId != null && list.length === 0) { list.push(id); return null; }
    return 'anchor-missing';
  }

  apply(op: PlannedOp): string | null {
    switch (op.type) {
      case 'create': {
        if (this.nodes.has(op.nodeId)) return 'exists';
        if (!this.children.has(op.parentId!)) return 'parent-missing';
        const problem = this.place(op.parentId!, op.nodeId, op.afterId, op.beforeId);
        if (problem) return problem;
        this.nodes.set(op.nodeId, { id: op.nodeId, parentId: op.parentId!, kind: op.kind!, title: op.title ?? '', url: op.url ?? null, version: 1 });
        if (op.kind === 'folder') this.children.set(op.nodeId, []);
        return null;
      }
      case 'update': {
        const n = this.nodes.get(op.nodeId); if (!n) return 'missing';
        if (n.version !== op.baseVersion) return 'stale-version';
        if (op.title !== undefined) n.title = op.title;
        if (op.url !== undefined) n.url = op.url;
        n.version++;
        return null;
      }
      case 'move': {
        const n = this.nodes.get(op.nodeId); if (!n) return 'missing';
        if (!this.children.has(op.parentId!)) return 'parent-missing';
        const old = this.children.get(n.parentId!)!;
        old.splice(old.indexOf(n.id), 1);
        const problem = this.place(op.parentId!, n.id, op.afterId, op.beforeId);
        if (problem) { old.push(n.id); return problem; }
        n.parentId = op.parentId!;
        n.version++;
        return null;
      }
      case 'delete': {
        const n = this.nodes.get(op.nodeId); if (!n) return 'missing';
        const drop = (id: string) => {
          for (const c of this.children.get(id) ?? []) drop(c);
          this.children.delete(id);
          this.nodes.delete(id);
        };
        const siblings = this.children.get(n.parentId!)!;
        siblings.splice(siblings.indexOf(n.id), 1);
        drop(n.id);
        return null;
      }
    }
  }

  /** known w postaci, jaka trzyma wtyczka — klucze kolejnosci rosnace jak pozycje. */
  known(): Record<string, KnownNode> {
    const result: Record<string, KnownNode> = {};
    for (const n of this.nodes.values()) {
      const order = n.parentId ? String(this.children.get(n.parentId)!.indexOf(n.id)).padStart(5, '0') : 'a';
      result[n.id] = { id: n.id, parentId: n.parentId, kind: n.kind as KnownNode['kind'], title: n.title, url: n.url, order, version: n.version };
    }
    return result;
  }
}

// ============================================================
// Lokalne drzewo
// ============================================================

interface LNode { id: string; kind: string; title: string; url?: string; children?: LNode[]; parent?: LNode; }

function toLocal(n: LNode): LocalNode {
  return { id: n.id, kind: n.kind as LocalNode['kind'], title: n.title, url: n.url, children: n.children?.map(toLocal) };
}

function allNodes(roots: LNode[]): LNode[] {
  const out: LNode[] = [];
  const walk = (n: LNode) => { out.push(n); n.children?.forEach(walk); };
  roots.forEach(walk);
  return out;
}

function isInside(node: LNode, ancestor: LNode): boolean {
  for (let p: LNode | undefined = node; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

const EXCLUDED = '!pominiety';


// ============================================================
// Test wlasnosci diff()
// ============================================================

function scenario(seed: number): string | null {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  let counter = 0;
  const sid = () => `s-${++counter}`;
  let lc = 0;
  const lid = () => `L-${++lc}`;

  // 1. Stan poczatkowy: serwer i lokalnie to samo, wszystko zmapowane
  const server = new Server();
  const mapping: Mapping = { s2l: {}, l2s: {} };
  const roots: LNode[] = [];
  for (const root of ['root:toolbar', 'root:unsorted']) {
    server.addRoot(root);
    const local: LNode = { id: lid(), kind: 'root', title: root, children: [] };
    roots.push(local);
    mapping.s2l[root] = local.id; mapping.l2s[local.id] = root;
  }

  const initial = 5 + Math.floor(r() * 25);
  for (let i = 0; i < initial; i++) {
    const folders = allNodes(roots).filter(n => n.kind !== 'bookmark' && n.kind !== 'separator');
    const parent = pick(folders);
    const kind = r() < 0.3 ? 'folder' : r() < 0.1 ? 'separator' : 'bookmark';
    const id = sid();
    const parentSid = mapping.l2s[parent.id];
    const siblings = server.children.get(parentSid)!;
    const at = Math.floor(r() * (siblings.length + 1));
    server.apply({ clientOpId: 'x', type: 'create', nodeId: id, kind: kind as 'folder', parentId: parentSid,
      title: kind === 'separator' ? '' : `t${id}`, url: kind === 'bookmark' ? `https://e.x/${id}` : undefined,
      afterId: at > 0 ? siblings[at - 1] : null, beforeId: siblings[at] ?? null });
    const local: LNode = { id: lid(), kind, title: kind === 'separator' ? '' : `t${id}`,
      url: kind === 'bookmark' ? `https://e.x/${id}` : undefined, children: kind === 'folder' ? [] : undefined, parent };
    parent.children!.splice(at, 0, local);
    mapping.s2l[id] = local.id; mapping.l2s[local.id] = id;
  }

  // 2. Losowe edycje uzytkownika
  const edits = 1 + Math.floor(r() * 12);
  for (let e = 0; e < edits; e++) {
    const nodes = allNodes(roots).filter(n => n.kind !== 'root');
    const folders = allNodes(roots).filter(n => n.kind === 'root' || n.kind === 'folder');
    const action = r();

    if (action < 0.25) {                                   // dodanie
      const parent = pick(folders);
      const kind = r() < 0.25 ? 'folder' : 'bookmark';
      const excluded = r() < 0.15;
      const node: LNode = { id: lid(), kind, title: excluded ? EXCLUDED : `nowy${lc}`,
        url: kind === 'bookmark' ? `https://n.x/${lc}` : undefined, children: kind === 'folder' ? [] : undefined, parent };
      parent.children!.splice(Math.floor(r() * (parent.children!.length + 1)), 0, node);
    } else if (action < 0.4 && nodes.length) {             // usuniecie
      const victim = pick(nodes);
      victim.parent!.children!.splice(victim.parent!.children!.indexOf(victim), 1);
    } else if (action < 0.7 && nodes.length) {             // przeniesienie / przestawienie
      const node = pick(nodes);
      // Takze do folderow wykluczonych: przeniesienie tam = usuniecie z serwera
      const targets = folders.filter(f => !isInside(f, node));
      const target = pick(targets);
      node.parent!.children!.splice(node.parent!.children!.indexOf(node), 1);
      target.children!.splice(Math.floor(r() * (target.children!.length + 1)), 0, node);
      node.parent = target;
    } else if (nodes.length) {                             // zmiana tytulu / adresu
      const node = pick(nodes.filter(n => n.kind !== 'separator').concat(nodes.slice(0, 1)));
      if (node.kind === 'separator') continue;
      if (node.title === EXCLUDED) continue;
      node.title = `zmieniony${e}-${node.id}`;
      if (node.kind === 'bookmark' && r() < 0.4) node.url = `https://zmieniony.x/${e}/${node.id}`;
    }
  }

  // 3. diff i odtworzenie na serwerze
  let opCounter = 0;
  const out = diff({
    roots: roots.map(toLocal),
    known: server.known(),
    mapping,
    isExcluded: node => node.title === EXCLUDED,
    newId: sid,
    newOpId: () => `op-${++opCounter}`,
    cursor: 0,
  });

  for (const m of out.newMappings) { mapping.s2l[m.serverId] = m.localId; mapping.l2s[m.localId] = m.serverId; }

  for (const op of out.ops) {
    const problem = server.apply(op);
    if (problem) return `operacja ${op.type} ${op.nodeId} -> ${problem}`;
  }

  // 4. Porownanie: serwer musi wygladac dokladnie jak przegladarka (bez wykluczonych)
  const compare = (local: LNode, serverId: string): string | null => {
    const expected = (local.children ?? []).filter(c => c.title !== EXCLUDED);
    const actual = server.children.get(serverId) ?? [];
    const expectedIds = expected.map(c => mapping.l2s[c.id]);
    if (JSON.stringify(expectedIds) !== JSON.stringify(actual))
      return `kolejnosc w ${serverId}: oczekiwano ${expectedIds.join(',')}, jest ${actual.join(',')}`;
    for (const child of expected) {
      const s = server.nodes.get(mapping.l2s[child.id])!;
      if (child.kind !== 'separator' && s.title !== child.title) return `tytul ${s.id}: ${s.title} != ${child.title}`;
      if (child.kind === 'bookmark' && s.url !== child.url) return `adres ${s.id}`;
      if (child.kind === 'folder') { const deeper = compare(child, s.id); if (deeper) return deeper; }
    }
    return null;
  };
  for (const root of roots) {
    const problem = compare(root, mapping.l2s[root.id]);
    if (problem) return problem;
  }

  // 5. Drugi diff po zsynchronizowaniu nie moze juz niczego wyprodukowac
  const again = diff({
    roots: roots.map(toLocal), known: server.known(), mapping,
    isExcluded: node => node.title === EXCLUDED, newId: sid, newOpId: () => 'x', cursor: 0,
  });
  if (again.ops.length > 0) return `po synchronizacji diff dalej widzi ${again.ops.length} zmian (${again.ops[0].type})`;

  return null;
}

for (let seed = 1; seed <= 3000; seed++) {
  const problem = scenario(seed);
  expect(problem === null, `diff, ziarno ${seed}: ${problem}`);
}

// ---- przypadki szczegolne ----

{
  // Brak zmian -> brak operacji
  const known: Record<string, KnownNode> = {
    'root:toolbar': { id: 'root:toolbar', parentId: null, kind: 'root', title: '', url: null, order: 'a', version: 1 },
    a: { id: 'a', parentId: 'root:toolbar', kind: 'bookmark', title: 'A', url: 'https://a', order: 'a0', version: 3 },
  };
  const mapping: Mapping = { s2l: { 'root:toolbar': '1', a: '10' }, l2s: { '1': 'root:toolbar', '10': 'a' } };
  const roots: LocalNode[] = [{ id: '1', kind: 'root', title: '', children: [{ id: '10', kind: 'bookmark', title: 'A', url: 'https://a' }] }];
  const out = diff({ roots, known, mapping, isExcluded: () => false, newId: () => 'n', newOpId: () => 'o', cursor: 7 });
  expect(out.ops.length === 0, 'bez zmian nie moze byc operacji');

  // Wykluczony zmapowany wezel: zadnej operacji (niewidoczny, nie usuniety)
  const hidden = diff({ roots, known, mapping, isExcluded: n => n.id === '10', newId: () => 'n', newOpId: () => 'o', cursor: 7 });
  expect(hidden.ops.length === 0, 'wykluczenie nie moze wysylac usuniecia');

  // Usuniecie folderu niesie baseSeq, potomkowie nie dostaja wlasnych usuniec
  const known2 = { ...known,
    f: { id: 'f', parentId: 'root:toolbar', kind: 'folder' as const, title: 'F', url: null, order: 'a1', version: 2 },
    g: { id: 'g', parentId: 'f', kind: 'bookmark' as const, title: 'G', url: 'https://g', order: 'a0', version: 1 } };
  const mapping2: Mapping = { s2l: { ...mapping.s2l, f: '20', g: '21' }, l2s: { ...mapping.l2s, '20': 'f', '21': 'g' } };
  const del = diff({ roots, known: known2, mapping: mapping2, isExcluded: () => false, newId: () => 'n', newOpId: () => 'o', cursor: 42 });
  expect(del.ops.length === 1 && del.ops[0].type === 'delete' && del.ops[0].nodeId === 'f' && del.ops[0].baseSeq === 42,
    'usuniecie folderu: jedna operacja na folder z baseSeq');
}

// ============================================================
// planReorder i chromiumIndex
// ============================================================

for (let seed = 1; seed <= 3000; seed++) {
  const r = rng(seed * 7919);
  const n = 1 + Math.floor(r() * 15);
  const all = Array.from({ length: n }, (_, i) => `n${i}`);
  const current = [...all].sort(() => r() - 0.5);
  const synced = current.filter(() => r() < 0.75);
  const desired = [...synced].sort(() => r() - 0.5);

  const moves = planReorder(current, desired);
  const list = [...current];
  for (const m of moves) { list.splice(list.indexOf(m.id), 1); list.splice(m.index, 0, m.id); }

  const syncedAfter = list.filter(id => desired.includes(id));
  expect(JSON.stringify(syncedAfter) === JSON.stringify(desired), `planReorder ${seed}: kolejnosc sie nie zgadza`);

  const unsyncedBefore = current.filter(id => !desired.includes(id));
  const unsyncedAfter = list.filter(id => !desired.includes(id));
  expect(JSON.stringify(unsyncedBefore) === JSON.stringify(unsyncedAfter), `planReorder ${seed}: ruszone niesynchronizowane`);

  const rank = new Map(desired.map((id, i) => [id, i]));
  const lis = longestIncreasing(current.filter(id => rank.has(id)).map(id => rank.get(id)!)).length;
  expect(moves.length === desired.length - lis, `planReorder ${seed}: ${moves.length} przesuniec zamiast ${desired.length - lis}`);

  // Chromium: model z BookmarkModel::Move
  const chrome = [...current];
  for (const m of moves) {
    const from = chrome.indexOf(m.id);
    let index = chromiumIndex(chrome, m.id, m.index);
    if (index > from) index--;
    chrome.splice(from, 1);
    chrome.splice(index, 0, m.id);
  }
  expect(JSON.stringify(chrome) === JSON.stringify(list), `chromiumIndex ${seed}: Chromium ulozylby inaczej`);
}

console.log(failures === 0
  ? `OK — ${checks} sprawdzen rdzenia przeszlo (3000 scenariuszy diff, 3000 planReorder).`
  : `${failures} z ${checks} sprawdzen nie przeszlo.`);
process.exit(failures === 0 ? 0 : 1);

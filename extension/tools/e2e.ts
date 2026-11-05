// Atrapa przegladarki MUSI byc pierwsza.
import { FakeDevice, use } from './e2e-env.js';

import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { syncOnce, pairWith, loadStatus, confirmDeletions, conflictNotes, QUARANTINE_TITLE } from '../src/engine.js';
import * as api from '../src/api.js';
import { loadFilterConfig, saveFilterConfig } from '../src/filters.js';
import { getLocal, KEYS } from '../src/storage.js';
import type { SyncStatus } from '../src/types.js';

// ============================================================
// Test end-to-end wtyczki FrogSync przeciw prawdziwemu serwerowi.
//
// Kazdy scenariusz odpowiada konkretnemu problemowi zgloszonemu w starych
// projektach albo przypadkowi brzegowemu znalezionemu przez Codexa.
// ============================================================

// Serwer testowy ma certyfikat samopodpisany
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_PROJECT = resolve(process.env.FROGSYNC_SERVER ?? join(here, '..', '..', 'server'));

const created: FakeDevice[] = [];
let passed = 0;
const failures: string[] = [];

async function scenario(name: string, body: () => Promise<void>) {
  const started = Date.now();
  try { await body(); passed++; console.log(`  ok    ${name} [${Date.now() - started} ms]`); }
  catch (err) { failures.push(name); console.log(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`); }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// ============================================================
// Serwer i panel
// ============================================================

async function freePort(): Promise<number> {
  return new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
}

let server: ChildProcess | null = null;
let baseUrl = '';
let cookie = '';

async function startServer(): Promise<void> {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'frogsync-e2e-'));
  baseUrl = `https://127.0.0.1:${port}`;

  let setupCode = '';
  server = spawn('dotnet', ['run', '--no-build', '-c', 'Release', '--project', SERVER_PROJECT], {
    env: { ...process.env, FROGSYNC_DATA: data, FROGSYNC_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onData = (chunk: Buffer) => {
    const m = /(?<![A-Z2-9])([A-Z2-9]{4}-[A-Z2-9]{4})(?![A-Z2-9])/.exec(chunk.toString());
    if (m && !setupCode) setupCode = m[1];
  };
  server.stdout!.on('data', onData);
  server.stderr!.on('data', onData);
  process.on('exit', () => { server?.kill(); try { rmSync(data, { recursive: true, force: true }); } catch { /* serwer jeszcze trzyma pliki — zostawiamy w katalogu tymczasowym */ } });

  for (let i = 0; i < 300 && !setupCode; i++) await new Promise(r => setTimeout(r, 100));
  expect(setupCode, 'serwer nie wystartowal albo nie wypisal kodu konfiguracji');

  const start = await admin('setup/start', { setupCode, password: 'haslo-testowe-123' });
  await admin('setup/finish', { setupCode, totp: totp(start.secret) });
}

async function admin(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}/admin/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-FrogSync': '1', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`panel ${path}: HTTP ${response.status} ${JSON.stringify(json)}`);
  return json;
}

function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

const profiles = new Map<string, string>();
async function profile(name: string): Promise<string> {
  if (!profiles.has(name)) profiles.set(name, (await admin('profiles', { name })).id);
  return profiles.get(name)!;
}

async function newBrowser(name: string, engine: 'gecko' | 'chromium', profileName: string,
  setup?: (d: FakeDevice) => void, mode: 'replace' | 'merge' = 'replace',
  options: { braveIds?: boolean } = {}): Promise<FakeDevice> {
  const device = new FakeDevice(name, engine, options);
  created.push(device);
  use(device);
  setup?.(device);
  const { code } = await admin(`profiles/${await profile(profileName)}/pairing`, { deviceName: name });
  // Tak jak ustawienia wtyczki: najpierw podglad (nie zuzywa kodu), potem parowanie
  const preview = await api.preview(baseUrl, code);
  const status = await pairWith(baseUrl, code, name, mode, preview.hasContent);
  expect(status.connection === 'ok', `${name}: parowanie zakonczylo sie stanem ${status.connection} (${status.lastError ?? ''})`);
  return device;
}

async function sync(device: FakeDevice): Promise<SyncStatus> {
  use(device);
  const status = await syncOnce();
  expect(status.connection === 'ok', `${device.name}: synchronizacja zakonczyla sie stanem ${status.connection} (${status.lastError ?? ''})`);
  return status;
}

/** Kilka rund na wszystkich urzadzeniach — az kazde zobaczy zmiany pozostalych. */
async function converge(...devices: FakeDevice[]) {
  for (let round = 0; round < 3; round++) for (const d of devices) await sync(d);
}

const tb = (d: FakeDevice) => d.bookmarks.toolbar;
function add(d: FakeDevice, title: string, url: string, parent = tb(d), index?: number) {
  use(d); return d.bookmarks.create({ parentId: parent, title, url, index }).id;
}
function same(a: string[], b: string[], what: string) {
  expect(JSON.stringify(a) === JSON.stringify(b), `${what}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

// ============================================================

await startServer();
console.log(`Serwer testowy: ${baseUrl}\n`);

await scenario('pierwsza przegladarka wysyla swoja kolekcje do pustego profilu', async () => {
  const a = await newBrowser('A1', 'gecko', 'P1', d => {
    use(d);
    d.bookmarks.create({ parentId: d.bookmarks.toolbar, title: 'Alfa', url: 'https://alfa.pl/' });
    const f = d.bookmarks.create({ parentId: d.bookmarks.toolbar, title: 'Praca' });
    d.bookmarks.create({ parentId: f.id, title: 'Jira', url: 'https://jira.firma.pl/' });
  });
  const state = await admin('state');
  const p = state.data.profiles.find((x: any) => x.name === 'P1');
  expect(p.bookmarks === 2, `serwer powinien miec 2 zakladki, ma ${p.bookmarks}`);
  same(a.bookmarks.titles(tb(a)), ['Alfa', 'Praca'], 'pasek A');
});

await scenario('druga przegladarka z czesciowo tymi samymi zakladkami: adopcja bez duplikatow', async () => {
  // To dokladnie sytuacja "zakladki sie dubluja" — druga przegladarka ma juz
  // czesc tych samych zakladek, ktorych NIE moze dostac drugi raz
  const b = await newBrowser('B1', 'chromium', 'P1', d => {
    use(d);
    d.bookmarks.create({ parentId: '1', title: 'Alfa', url: 'https://alfa.pl/' });
    d.bookmarks.create({ parentId: '1', title: 'Tylko B', url: 'https://tylko-b.pl/' });
  }, 'merge');
  const a = [...devices()].find(d => d.name === 'A1')!;
  await converge(a, b);

  expect(b.bookmarks.findAll(n => n.url === 'https://alfa.pl/').length === 1, 'Alfa zdublowana w B');
  expect(a.bookmarks.findAll(n => n.url === 'https://alfa.pl/').length === 1, 'Alfa zdublowana w A');
  expect(a.bookmarks.find('Tylko B'), 'A nie dostalo zakladki z B');
  expect(b.bookmarks.find('Jira'), 'B nie dostalo zakladki z podfolderu A');
  same(b.bookmarks.titles('1'), a.bookmarks.titles(tb(a)), 'kolejnosc paskow A i B');
});

await scenario('zakladka dodana NA GORE folderu laduje na gorze w drugiej przegladarce', async () => {
  // Zgloszone w v2: zakladki z innego komputera ladowaly na koncu listy
  const [a, b] = pair('A1', 'B1');
  const praca = a.bookmarks.find('Praca')!.id;
  add(a, 'Na gorze', 'https://gora.pl/', praca, 0);
  await converge(a, b);
  const bPraca = b.bookmarks.find('Praca')!.id;
  same(b.bookmarks.titles(bPraca), ['Na gorze', 'Jira'], 'folder Praca w B');
});

await scenario('usuniecie propaguje sie i nie wraca', async () => {
  const [a, b] = pair('A1', 'B1');
  use(a); a.bookmarks.removeTree(a.bookmarks.find('Tylko B')!.id);
  await converge(a, b);
  expect(!b.bookmarks.find('Tylko B'), 'usuniecie nie dotarlo do B');
  await converge(b, a, b);
  expect(!a.bookmarks.find('Tylko B') && !b.bookmarks.find('Tylko B'), 'usunieta zakladka wrocila');
});

await scenario('przestawienie kolejnosci w Chromium odtwarza sie w Firefoksie', async () => {
  const [a, b] = pair('A1', 'B1');
  add(b, 'Beta', 'https://beta.pl/', '1');
  add(b, 'Gamma', 'https://gamma.pl/', '1');
  await converge(a, b);
  // Gamma na sam poczatek — przesuniecie w gore; Alfa na koniec — w dol (tu Chromium liczy indeks inaczej)
  use(b);
  b.bookmarks.move(b.bookmarks.find('Gamma')!.id, { parentId: '1', index: 0 });
  b.bookmarks.move(b.bookmarks.find('Alfa')!.id, { parentId: '1', index: b.bookmarks.titles('1').length });
  await converge(b, a);
  same(a.bookmarks.titles(tb(a)), b.bookmarks.titles('1'), 'kolejnosc paska po przestawieniu');
});

await scenario('przeniesienie miedzy folderami i zmiana nazwy folderu', async () => {
  const [a, b] = pair('A1', 'B1');
  use(a);
  const praca = a.bookmarks.find('Praca')!.id;
  a.bookmarks.move(a.bookmarks.find('Beta')!.id, { parentId: praca, index: 1 });
  a.bookmarks.update(praca, { title: 'Praca 2026' });
  await converge(a, b);
  const bPraca = b.bookmarks.find('Praca 2026');
  expect(bPraca, 'zmiana nazwy folderu nie dotarla');
  same(b.bookmarks.titles(bPraca!.id), a.bookmarks.titles(praca), 'zawartosc folderu po przeniesieniu');
});

await scenario('rownoczesna zmiana nazwy i przeniesienie tego samego wpisu: obie zmiany zostaja', async () => {
  const [a, b] = pair('A1', 'B1');
  use(a); a.bookmarks.update(a.bookmarks.find('Gamma')!.id, { title: 'Gamma nowa' });
  use(b); b.bookmarks.move(b.bookmarks.find('Gamma')!.id, { parentId: b.bookmarks.find('Praca 2026')!.id, index: 0 });
  await converge(a, b);
  for (const d of [a, b]) {
    const g = d.bookmarks.find('Gamma nowa');
    expect(g, `${d.name}: zgubiona zmiana nazwy`);
    expect(g!.parentId === d.bookmarks.find('Praca 2026')!.id, `${d.name}: zgubione przeniesienie`);
  }
});

await scenario('konflikt tej samej nazwy: jedna wersja wygrywa, bez duplikatu, z notatka', async () => {
  const [a, b] = pair('A1', 'B1');
  use(a); a.bookmarks.update(a.bookmarks.find('Beta')!.id, { title: 'Beta z A' });
  use(b); b.bookmarks.update(b.bookmarks.find('Beta')!.id, { title: 'Beta z B' });
  await sync(a);
  await sync(b);   // B przegrywa — serwer ma juz wersje A
  await converge(a, b);
  expect(a.bookmarks.find('Beta z A') && b.bookmarks.find('Beta z A'), 'obie przegladarki powinny miec wersje A');
  expect(!b.bookmarks.find('Beta z B'), 'przegrana wersja zostala w B');
  use(b);
  const conflicts = await conflictNotes();
  expect(conflicts.some(c => c.reason === 'title-changed'), 'brak notatki o konflikcie w B');
});

await scenario('usuniecie folderu, w ktorym druga przegladarka wlasnie cos zmienila: nic nie ginie', async () => {
  // Znalezisko Codexa: kasowanie folderu nie moze zabrac cudzej, niewidzianej pracy
  const [a, b] = pair('A1', 'B1');
  const bPraca = b.bookmarks.find('Praca 2026')!.id;
  add(b, 'Swieza z B', 'https://swieza.pl/', bPraca);
  await sync(b);
  use(a); a.bookmarks.removeTree(a.bookmarks.find('Praca 2026')!.id);   // A jeszcze nie widzialo zmiany B
  await converge(a, b);
  expect(a.bookmarks.find('Swieza z B'), 'zakladka B zginela razem z folderem');
  expect(b.bookmarks.find('Swieza z B'), 'zakladka B zniknela w B');
});

await scenario('nieudane utworzenie zakladki jest ponawiane bez recznego wymuszania', async () => {
  // Blad v2: kursor szedl dalej mimo nieudanego zapisu -> "czasem musze wymusic"
  const [a, b] = pair('A1', 'B1');
  add(a, 'Oporna', 'https://oporna.pl/');
  await sync(a);
  b.bookmarks.failNextCreates = 1000;
  await sync(b);
  expect(!b.bookmarks.find('Oporna'), 'symulacja bledu nie zadzialala');
  b.bookmarks.failNextCreates = 0;
  await sync(b);
  expect(b.bookmarks.find('Oporna'), 'zakladka nie dotarla w zwyklym przebiegu');
});

await scenario('menu zakladek z Firefoksa przechodzi przez Chromium i wraca nietkniete', async () => {
  const [a, b] = pair('A1', 'B1');
  add(a, 'Z menu', 'https://menu.pl/', 'menu________');
  await converge(a, b);
  const standIn = b.bookmarks.find('Menu zakładek' /* folder zastepczy w Chromium */);
  expect(standIn && standIn.parentId === '2', 'brak folderu zastepczego menu w Chromium');
  expect(b.bookmarks.find('Z menu')?.parentId === standIn!.id, 'zakladka z menu nie trafila do folderu zastepczego');
  use(b); b.bookmarks.update(b.bookmarks.find('Z menu')!.id, { title: 'Z menu (zmieniona w Chromium)' });
  await converge(b, a);
  expect(a.bookmarks.find('Z menu (zmieniona w Chromium)')?.parentId === 'menu________', 'zakladka nie wrocila do menu Firefoksa');
});

await scenario('separator z Firefoksa: Chromium go pomija, a Firefox nie traci', async () => {
  const a = await newBrowser('A2', 'gecko', 'P2', d => {
    use(d);
    d.bookmarks.create({ parentId: d.bookmarks.toolbar, title: 'Przed', url: 'https://przed.pl/' });
    d.bookmarks.create({ parentId: d.bookmarks.toolbar, type: 'separator' });
    d.bookmarks.create({ parentId: d.bookmarks.toolbar, title: 'Po', url: 'https://po.pl/' });
  });
  const b = await newBrowser('B2', 'chromium', 'P2');
  const c = await newBrowser('C2', 'gecko', 'P2');
  await converge(a, b, c);
  same(b.bookmarks.titles('1'), ['Przed', 'Po'], 'Chromium');
  same(c.bookmarks.titles(tb(c)), ['Przed', '---', 'Po'], 'drugi Firefox');
  // Przestawienie w Chromium nie moze zgubic separatora w Firefoksach
  use(b); b.bookmarks.move(b.bookmarks.find('Po')!.id, { parentId: '1', index: 0 });
  await converge(b, a, c);
  expect(a.bookmarks.titles(tb(a)).includes('---') && c.bookmarks.titles(tb(c)).includes('---'), 'separator zginal');
  expect(a.bookmarks.titles(tb(a)).indexOf('Po') < a.bookmarks.titles(tb(a)).indexOf('Przed'), 'przestawienie nie dotarlo');
});

await scenario('filtr: wykluczona zakladka nie wychodzi i nigdy nie jest kasowana', async () => {
  const [a, b] = pair('A1', 'B1');
  use(a);
  const config = await loadFilterConfig();
  config.manualExclusions.push({ id: 'x', type: 'urlPattern', value: 'https://intranet.local/*', label: 'intranet' });
  await saveFilterConfig(config);
  add(a, 'Tajna', 'https://intranet.local/tajne');
  await converge(a, b);
  expect(!b.bookmarks.find('Tajna'), 'wykluczona zakladka wyciekla');
  await converge(a, b, a);
  expect(a.bookmarks.find('Tajna'), 'wykluczona zakladka zostala skasowana lokalnie');
});

await scenario('przeniesienie do wykluczonego folderu (np. Kosz w Operze) usuwa z innych przegladarek', async () => {
  // Opera "usuwa" zakladke, przenoszac ja do folderu Kosz — wykluczonego wbudowanym filtrem.
  // Przegladarki maja wygladac 1:1, wiec w pozostalych ta zakladka ma zniknac.
  const [a, b] = pair('A1', 'B1');
  add(a, 'Do kosza', 'https://do-kosza.pl/');
  await converge(a, b);
  expect(b.bookmarks.find('Do kosza'), 'B najpierw powinno dostac zakladke');

  use(b);
  const kosz = b.bookmarks.create({ parentId: '2', title: 'Kosz' }).id;
  b.bookmarks.move(b.bookmarks.find('Do kosza')!.id, { parentId: kosz });
  await converge(b, a);

  expect(!a.bookmarks.find('Do kosza'), 'zakladka przeniesiona do Kosza zostala w A');
  expect(b.bookmarks.find('Do kosza')?.parentId === kosz, 'w B zakladka ma zostac w Koszu');
  expect(!a.bookmarks.find('Kosz'), 'wykluczony folder Kosz wyciekl do A');
});

await scenario('wlaczenie reguly filtra tylko ukrywa — niczego nie kasuje na innych komputerach', async () => {
  const [a, b] = pair('A1', 'B1');
  add(a, 'Bookmarklet', 'javascript:alert(1)');
  await converge(a, b);
  expect(b.bookmarks.find('Bookmarklet'), 'B powinno dostac bookmarklet (regula domyslnie wylaczona)');

  use(b);
  const config = await loadFilterConfig();
  config.builtinEnabled['scheme-js'] = true;
  await saveFilterConfig(config);
  await converge(b, a);
  expect(a.bookmarks.find('Bookmarklet'), 'wlaczenie reguly w B skasowalo bookmarklet w A');
  expect(b.bookmarks.find('Bookmarklet'), 'wlaczenie reguly skasowalo bookmarklet lokalnie w B');
});

await scenario('hamulec: masowe usuniecie czeka na potwierdzenie', async () => {
  const a = await newBrowser('A3', 'gecko', 'P3', d => {
    use(d);
    for (let i = 0; i < 80; i++) d.bookmarks.create({ parentId: d.bookmarks.toolbar, title: `Masowa ${i}`, url: `https://m.pl/${i}` });
  });
  const b = await newBrowser('B3', 'chromium', 'P3');
  await converge(a, b);
  expect(b.bookmarks.bookmarkCount() === 80, `B ma ${b.bookmarks.bookmarkCount()} zakladek zamiast 80`);
  use(a); for (const n of a.bookmarks.findAll(n => n.title.startsWith('Masowa '))) a.bookmarks.removeTree(n.id);
  await sync(a);
  // A ma wlasny hamulec — najpierw uzytkownik potwierdza tam, ze usuniecie bylo zamierzone
  use(a); await confirmDeletions('local');
  const status = await sync(b);
  expect((status.blockedDeletions ?? 0) >= 80, `hamulec nie zadzialal (blockedDeletions=${status.blockedDeletions})`);
  expect(b.bookmarks.bookmarkCount() === 80, 'B skasowalo mimo hamulca');
});

await scenario('serwer niedostepny: zmiany czekaja i wychodza po powrocie', async () => {
  const [a, b] = pair('A1', 'B1');
  use(a);
  const session = await getLocal<any>(KEYS.server, null);
  const realUrl = session.url;
  await (await import('../src/storage.js')).setLocal({ [KEYS.server]: { ...session, url: 'https://127.0.0.1:1' } });
  add(a, 'Offline', 'https://offline.pl/');
  const down = await syncOnce();
  expect(down.connection === 'offline', `oczekiwano offline, jest ${down.connection}`);
  await (await import('../src/storage.js')).setLocal({ [KEYS.server]: { ...session, url: realUrl } });
  await converge(a, b);
  expect(b.bookmarks.find('Offline'), 'zmiana z czasu bez serwera nie dotarla');
});

await scenario('minimum wersji: outdated zatrzymuje caly przebieg i zachowuje prace do aktualizacji', async () => {
  const a = await newBrowser('Version A', 'chromium', 'Wersje rozszerzenia', device => {
    add(device, 'Do zmiany', 'https://version-e2e.example/edit');
    add(device, 'Do usuniecia', 'https://version-e2e.example/delete');
  });
  const b = await newBrowser('Version B', 'gecko', 'Wersje rozszerzenia');
  await converge(a, b);

  use(a);
  const storage = await import('../src/storage.js');
  const state = await getLocal<any>('engineState', null);
  const old = a.bookmarks.find('Do zmiany')!;
  const removed = a.bookmarks.find('Do usuniecia')!;
  const sid = state.mapping.l2s[old.id];
  const operation = {
    clientOpId: crypto.randomUUID(), type: 'update', nodeId: sid,
    title: 'Zmieniona offline', baseVersion: state.known[sid].version,
  };
  a.bookmarks.update(old.id, { title: 'Zmieniona offline' });
  a.bookmarks.removeTree(removed.id);
  add(a, 'Dodana offline', 'https://version-e2e.example/new');
  await storage.setLocal({ engineState: { ...state, outbox: [operation] } });

  const beforeState = JSON.stringify(await getLocal('engineState', null));
  const beforeTree = JSON.stringify(a.bookmarks.getTree());
  const realFetch = globalThis.fetch;
  let nonHello = 0;
  let sentVersion = '';
  let helloCount = 0;

  // Atrapa zmienia tylko wymagania zwracane przez prawdziwe hello.
  // Egzekwowanie minimum po stronie serwera pokrywa test C#.
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v1/')) {
      if (!url.includes('/api/v1/hello')) nonHello++;
      else {
        helloCount++;
        sentVersion = new Headers(init?.headers).get('X-FrogSync-Version') ?? '';
        const response = await realFetch(input, init);
        if (!response.ok) return response;
        const json = await response.json();
        return new Response(JSON.stringify({
          ...json, minExtensionVersion: '0.3.2', latestExtensionVersion: '0.3.10',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return realFetch(input, init);
  };

  try {
    const blocked = await syncOnce();
    expect(blocked.connection === 'outdated' && !!blocked.lastError, 'brak jawnego outdated');
    expect(blocked.pendingOps === 1 && blocked.minExtensionVersion === '0.3.2',
      'status zgubil kolejke albo wymaganie wersji');
    expect(helloCount === 1 && nonHello === 0 && sentVersion === '0.3.1',
      'stary klient wyslal cos poza hello albo nie zglosil wersji');
    expect(JSON.stringify(await getLocal('engineState', null)) === beforeState,
      'outdated zmienilo stan lub kolejke silnika');
    expect(JSON.stringify(a.bookmarks.getTree()) === beforeTree, 'outdated zmienilo zakladki');

    a.extensionVersion = '0.3.2';
    const resumed = await syncOnce();
    expect(resumed.connection === 'ok' && !resumed.lastError && resumed.pendingOps === 0,
      'po aktualizacji nie wznowiono synchronizacji');
    expect(resumed.updateAvailable && resumed.latestExtensionVersion === '0.3.10',
      'brak dyskretnego powiadomienia o nowszej wersji');
    expect((sentVersion as string) === '0.3.2', 'naglowek nie odczytuje biezacej wersji manifestu');

    // Przywracamy siec przed przejsciem na B, aby jej wersja nie byla blokowana atrapa.
    globalThis.fetch = realFetch;
    await converge(a, b);
    expect(b.bookmarks.find('Zmieniona offline') && b.bookmarks.find('Dodana offline'),
      'po aktualizacji nie dotarly zachowane edycje');
    expect(!a.bookmarks.find('Do usuniecia') && !b.bookmarks.find('Do usuniecia'),
      'lokalne usuniecie wrocilo po aktualizacji');
  } finally {
    globalThis.fetch = realFetch;
    a.extensionVersion = '0.3.1';
  }
});

await scenario('wersja aktualna: informacja o dostepnej aktualizacji znika bez zmiany sesji', async () => {
  const a = await newBrowser('Version current', 'gecko', 'Wersje aktualna');
  use(a);
  const beforeSession = JSON.stringify(await getLocal(KEYS.server, null));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!url.includes('/api/v1/hello') || !response.ok) return response;
    const json = await response.json();
    return new Response(JSON.stringify({
      ...json, minExtensionVersion: '0.3.1', latestExtensionVersion: '0.3.10',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    expect((await sync(a)).updateAvailable, 'brak informacji o nowszej wersji');
    a.extensionVersion = '0.3.10';
    const current = await sync(a);
    expect(!current.updateAvailable && current.connection === 'ok', 'wersje porownywane sa tekstowo');
    expect(JSON.stringify(await getLocal(KEYS.server, null)) === beforeSession,
      'sprawdzenie wersji zmienilo sesje');
  } finally {
    globalThis.fetch = realFetch;
    a.extensionVersion = '0.3.1';
  }
});

await scenario('tresc: lokalny tytul zmieniony podczas pull nie ginie przy zdalnej zmianie URL', async () => {
  const a = await newBrowser('Content merge A', 'chromium', 'Scalanie tresci', device => {
    add(device, 'Poczatkowy tytul', 'https://content-merge.example/old');
  });
  const b = await newBrowser('Content merge B', 'gecko', 'Scalanie tresci');
  await converge(a, b);

  use(b);
  b.bookmarks.update(b.bookmarks.find('Poczatkowy tytul')!.id,
    { url: 'https://content-merge.example/new' });
  await sync(b);

  use(a);
  const localId = a.bookmarks.find('Poczatkowy tytul')!.id;
  const realFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!injected && response.ok && url.includes('/api/v1/changes?')) {
      injected = true;
      a.bookmarks.update(localId, { title: 'Lokalny tytul podczas pull' });
    }
    return response;
  };

  try {
    await sync(a);
    const local = a.bookmarks.get(localId)[0];
    expect(injected, 'nie wykonano edycji podczas pull');
    expect(local.title === 'Lokalny tytul podczas pull' &&
      local.url === 'https://content-merge.example/new',
      'pull nadpisal lokalny tytul lub zgubil zdalny URL');
  } finally {
    globalThis.fetch = realFetch;
  }

  await converge(a, b);
  for (const device of [a, b]) {
    const node = device.bookmarks.find('Lokalny tytul podczas pull');
    expect(node?.url === 'https://content-merge.example/new',
      `${device.name}: niezalezne zmiany nie zbiegly sie`);
    expect(device.bookmarks.findAll(n => n.url === 'https://content-merge.example/new').length === 1,
      `${device.name}: utworzono duplikat`);
  }
});

await scenario('tresc: konflikt podczas pull zachowuje odrzucony tytul przed zastosowaniem serwera', async () => {
  const a = await newBrowser('Content conflict A', 'chromium', 'Konflikt tresci', device => {
    add(device, 'Baza tytulu', 'https://content-conflict.example/');
  });
  const b = await newBrowser('Content conflict B', 'gecko', 'Konflikt tresci');
  await converge(a, b);

  use(b);
  b.bookmarks.update(b.bookmarks.find('Baza tytulu')!.id, { title: 'Tytul serwera' });
  await sync(b);

  use(a);
  const localId = a.bookmarks.find('Baza tytulu')!.id;
  const realFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!injected && response.ok && url.includes('/api/v1/changes?')) {
      injected = true;
      a.bookmarks.update(localId, { title: 'Odrzucony lokalny tytul' });
    }
    return response;
  };

  try {
    await sync(a);
    expect(a.bookmarks.get(localId)[0].title === 'Tytul serwera',
      'rzeczywisty konflikt nie zostal rozstrzygniety na rzecz serwera');

    const notes = await conflictNotes();
    const saved = notes.find(note => note.rejectedContent?.fields.some(field =>
      field.field === 'title' && field.local === 'Odrzucony lokalny tytul'));
    expect(saved?.rejectedContent, 'brak trwalej odrzuconej wartosci');
    const field = saved.rejectedContent.fields.find(item => item.field === 'title')!;
    expect(field.base === 'Baza tytulu' && field.remote === 'Tytul serwera',
      'notatka nie zachowala bazy i wersji serwera');
  } finally {
    globalThis.fetch = realFetch;
  }

  await converge(a, b);
  use(a);
  expect((await conflictNotes()).some(note => note.rejectedContent?.fields.some(field =>
    field.local === 'Odrzucony lokalny tytul')), 'kolejny przebieg zgubil odrzucona wartosc');
});

await scenario('tresc: edycja po wyslaniu update zostaje lokalna zmiana do kolejnego przebiegu', async () => {
  const a = await newBrowser('Content ack A', 'chromium', 'Edycja podczas odpowiedzi', device => {
    add(device, 'Przed wyslaniem', 'https://content-ack.example/');
  });
  const b = await newBrowser('Content ack B', 'gecko', 'Edycja podczas odpowiedzi');
  await converge(a, b);

  use(a);
  const localId = a.bookmarks.find('Przed wyslaniem')!.id;
  a.bookmarks.update(localId, { title: 'Pierwsza edycja' });
  const realFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!injected && response.ok && url.endsWith('/api/v1/ops')) {
      injected = true;
      a.bookmarks.update(localId, { title: 'Druga edycja podczas odpowiedzi' });
    }
    return response;
  };

  try {
    await sync(a);
    expect(injected && a.bookmarks.get(localId)[0].title === 'Druga edycja podczas odpowiedzi',
      'potwierdzenie pierwszej edycji nadpisalo druga');
  } finally {
    globalThis.fetch = realFetch;
  }

  await converge(a, b);
  expect(b.bookmarks.find('Druga edycja podczas odpowiedzi'),
    'druga edycja nie wyszla zwyklym diffem');
});

await scenario('rodzic: lokalny ruch podczas pull zostaje przy zdalnej edycji tytulu', async () => {
  const a = await newBrowser('Parent safe A', 'chromium', 'Ochrona rodzica', d => {
    d.bookmarks.create({ parentId: tb(d), title: 'Cel ruchu' });
    add(d, 'Przed ruchem', 'https://parent-safe.example/');
  });
  const b = await newBrowser('Parent safe B', 'gecko', 'Ochrona rodzica');
  await converge(a, b);

  use(b);
  b.bookmarks.update(b.bookmarks.find('Przed ruchem')!.id, { title: 'Tytul z B' });
  await sync(b);

  use(a);
  const id = a.bookmarks.find('Przed ruchem')!.id;
  const target = a.bookmarks.find('Cel ruchu')!.id;
  const realFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!injected && response.ok && url.includes('/api/v1/changes?')) {
      injected = true;
      a.bookmarks.move(id, { parentId: target });
    }
    return response;
  };
  try {
    await sync(a);
    expect(a.bookmarks.get(id)[0].parentId === target, 'pull cofnal lokalny ruch');
    expect(a.bookmarks.get(id)[0].title === 'Tytul z B', 'zdalny tytul nie zostal zastosowany');
  } finally { globalThis.fetch = realFetch; }

  await converge(a, b);
  expect(b.bookmarks.find('Tytul z B')?.parentId === b.bookmarks.find('Cel ruchu')?.id,
    'lokalny ruch nie dotarl do B');
});

await scenario('usuniecie: lokalny brak podczas pull nie odtwarza niezmienionej tresci po ruchu serwera', async () => {
  const a = await newBrowser('Delete safe A', 'chromium', 'Ochrona lokalnego usuniecia', d => {
    d.bookmarks.create({ parentId: tb(d), title: 'Nowy rodzic' });
    add(d, 'Usuwana lokalnie', 'https://delete-safe.example/');
  });
  const b = await newBrowser('Delete safe B', 'gecko', 'Ochrona lokalnego usuniecia');
  await converge(a, b);

  use(b);
  b.bookmarks.move(b.bookmarks.find('Usuwana lokalnie')!.id,
    { parentId: b.bookmarks.find('Nowy rodzic')!.id });
  await sync(b);

  use(a);
  const id = a.bookmarks.find('Usuwana lokalnie')!.id;
  const realFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!injected && response.ok && url.includes('/api/v1/changes?')) {
      injected = true;
      a.bookmarks.removeTree(id);
    }
    return response;
  };
  try {
    await sync(a);
    expect(!a.bookmarks.find('Usuwana lokalnie'), 'pull odtworzyl lokalnie usuniety wpis');
  } finally { globalThis.fetch = realFetch; }

  await converge(a, b);
  expect(!b.bookmarks.find('Usuwana lokalnie'), 'lokalne usuniecie nie wyszlo na serwer');
});

await scenario('tombstone: edytowany potomek i jego folder przezywaja zdalne kasowanie', async () => {
  const a = await newBrowser('Delete edited A', 'chromium', 'Edytowany potomek', d => {
    const folder = d.bookmarks.create({ parentId: tb(d), title: 'Kasowany folder' });
    add(d, 'Potomek przed edycja', 'https://edited-child.example/', folder.id);
  });
  const b = await newBrowser('Delete edited B', 'gecko', 'Edytowany potomek');
  await converge(a, b);

  const keptId = a.bookmarks.find('Potomek przed edycja')!.id;
  use(b);
  b.bookmarks.removeTree(b.bookmarks.find('Kasowany folder')!.id);
  await sync(b);

  use(a);
  const realFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!injected && response.ok && url.includes('/api/v1/changes?')) {
      injected = true;
      a.bookmarks.update(keptId, { title: 'Edytowany tuz przed tombstone' });
    }
    return response;
  };
  try {
    await sync(a);
    expect(a.bookmarks.find('Edytowany tuz przed tombstone')?.id === keptId,
      'zdalne kasowanie usunelo lokalna edycje');
  } finally { globalThis.fetch = realFetch; }

  await converge(a, b);
  expect(a.bookmarks.find('Edytowany tuz przed tombstone')?.id === keptId, 'odtworzenie zmienilo lokalne ID');
  expect(b.bookmarks.find('Edytowany tuz przed tombstone'), 'zachowana edycja nie dotarla do B');
  expect(b.bookmarks.findAll(n => n.url === 'https://edited-child.example/').length === 1,
    'odtworzenie potomka utworzylo duplikat');
});

await scenario('konflikt kasowania uzgadnia poddrzewo bez cofania niezaleglej lokalnej edycji', async () => {
  const a = await newBrowser('Scoped A', 'chromium', 'Zakres odtworzenia', d => {
    const folder = d.bookmarks.create({ parentId: tb(d), title: 'Folder konfliktu' });
    add(d, 'Stary potomek', 'https://scoped.example/child', folder.id);
    add(d, 'Niezalezna baza', 'https://scoped.example/other');
  });
  const b = await newBrowser('Scoped B', 'gecko', 'Zakres odtworzenia');
  await converge(a, b);

  use(b);
  add(b, 'Nowy potomek z B', 'https://scoped.example/new', b.bookmarks.find('Folder konfliktu')!.id);
  await sync(b);

  use(a);
  const independent = a.bookmarks.find('Niezalezna baza')!.id;
  a.bookmarks.removeTree(a.bookmarks.find('Folder konfliktu')!.id);
  const realFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!injected && response.ok && url.endsWith('/api/v1/ops')) {
      injected = true;
      a.bookmarks.update(independent, { title: 'Niezalezna pozniejsza edycja' });
    }
    return response;
  };
  try {
    await sync(a);
    expect(a.bookmarks.find('Nowy potomek z B'), 'nie odtworzono zakresu konfliktu');
    expect(a.bookmarks.get(independent)[0].title === 'Niezalezna pozniejsza edycja',
      'konflikt poddrzewa cofnal niezalezna edycje');
  } finally { globalThis.fetch = realFetch; }

  await converge(a, b);
  expect(b.bookmarks.find('Niezalezna pozniejsza edycja'), 'niezalezna edycja nie dotarla');
  expect(a.bookmarks.findAll(n => n.url === 'https://scoped.example/new').length === 1,
    'zakres odtworzono z duplikatem');
});

await scenario('konflikt: przywrocenie zapisanej tresci jest trwale i idempotentne', async () => {
  const engine = await import('../src/engine.js');
  const { conflictId } = await import('../src/conflict-id.js');
  const a = await newBrowser('Recover A', 'chromium', 'Odzyskanie konfliktu', d => {
    add(d, 'Tytul bazowy', 'https://recover-conflict.example/');
  });
  const b = await newBrowser('Recover B', 'gecko', 'Odzyskanie konfliktu');
  await converge(a, b);

  use(b);
  b.bookmarks.update(b.bookmarks.find('Tytul bazowy')!.id, { title: 'Wygral serwer' });
  await sync(b);
  use(a);
  a.bookmarks.update(a.bookmarks.find('Tytul bazowy')!.id, { title: 'Moja odrzucona wersja' });
  await converge(a, b);

  use(a);
  const note = (await conflictNotes()).find(item => item.rejectedContent?.fields.some(field =>
    field.local === 'Moja odrzucona wersja'));
  expect(note, 'brak zapisanej wersji po odrzuconej operacji');
  const id = conflictId(note);
  const result = await engine.restoreConflict(id);
  expect(result.connection === 'ok' && !result.lastError, 'odzyskanie nie powiodlo sie');
  await converge(a, b);
  expect(b.bookmarks.find('Moja odrzucona wersja'), 'odzyskana tresc nie dotarla do B');

  use(a);
  const session = await getLocal<any>(KEYS.server, null);
  const before = (await api.hello(session)).head;
  await engine.restoreConflict(id);
  expect((await api.hello(session)).head === before, 'drugie klikniecie wykonalo druga operacje');
});

await scenario('Brave: korzenie o innych numerach (1, 368, 369) synchronizuja sie poprawnie', async () => {
  // Brave numeruje "Inne zakladki" i "Zakladki na komorce" inaczej niz Chrome (2, 3)
  const a = await newBrowser('Brave src', 'gecko', 'Brave', d => {
    use(d);
    add(d, 'Na pasku', 'https://brave-pasek.example/');
    d.bookmarks.create({ parentId: d.bookmarks.other, title: 'W innych', url: 'https://brave-inne.example/' });
  });
  const b = await newBrowser('Brave', 'chromium', 'Brave', d => {
    use(d);
    add(d, 'Fabryczna Brave', 'https://brave.com/');
  }, 'replace', { braveIds: true });
  await converge(a, b);

  expect(b.bookmarks.find('Na pasku')?.parentId === '1', 'pasek nie dotarl do Brave');
  expect(b.bookmarks.find('W innych')?.parentId === '368', '"Inne zakladki" nie trafily do korzenia 368');
  expect(b.bookmarks.find(QUARANTINE_TITLE)?.parentId === '368', 'kwarantanna poza "Innymi zakladkami" Brave');
  expect(!a.bookmarks.find('Fabryczna Brave'), 'zakladka fabryczna Brave wyszla na serwer');

  use(b); add(b, 'Z Brave', 'https://z-brave.example/');
  await converge(b, a);
  expect(a.bookmarks.find('Z Brave'), 'zmiana z Brave nie dotarla');
});

await scenario('strona startowa: wyszukiwarki, adresy i podpowiedzi (logika)', async () => {
  const s = await import('../src/core/search.js');
  same(s.normalizePinned(['google', 'google', 'nieznana', 'allegro', 'youtube', 'maps', 'bing', 'ddg', 'wikipedia']),
    ['google', 'allegro', 'youtube', 'maps', 'bing', 'ddg'], 'limit 6 przypietych, bez powtorzen i nieznanych');
  expect(s.searchUrl(s.engineById('allegro')!, ' buty zimowe ') === 'https://allegro.pl/listing?string=buty%20zimowe', 'zly adres Allegro');
  const cases: [string, string | null][] = [
    ['onet.pl', 'https://onet.pl/'], ['https://x.pl/a?b=1', 'https://x.pl/a?b=1'], ['192.168.144.66:18443', 'https://192.168.144.66:18443/'],
    ['localhost:8080', 'https://localhost:8080/'], ['javascript:alert(1)', null], ['data:text/html,x', null],
    ['buty zimowe', null], ['pogoda', null], ['3.5', null], ['file:///c:/x', null],
  ];
  for (const [text, want] of cases) expect(s.asAddress(text) === want, `asAddress(${text}) = ${s.asAddress(text)}, oczekiwano ${want}`);
  same(s.parseGoogleSuggest(['pog', ['pogoda', 'pogoda jutro', 7, '']]), ['pogoda', 'pogoda jutro'], 'odczyt podpowiedzi Google');
  same(s.parseGoogleSuggest({ zly: true }), [], 'zla odpowiedz Google');
  const merged = s.mergeSuggestions('pogoda',
    [1, 2, 3, 4].map(i => ({ title: `Z${i}`, url: `https://z${i}.pl/` })).concat([{ title: 'dup', url: 'https://z1.pl/' }]),
    ['Pogoda', 'pogoda jutro', 'pogoda jutro', 'a', 'b', 'c', 'd', 'e', 'f']);
  same(merged.map(m => m.kind === 'bookmark' ? m.title : m.text),
    ['Z1', 'Z2', 'Z3', 'pogoda jutro', 'a', 'b', 'c', 'd', 'e'], 'najpierw 3 zakladki, potem 6 podpowiedzi bez powtorzen');
});

await scenario('Opera: nowa karta ze Speed Dialem przestawiona tylko gdy wolno', async () => {
  const { onOperaTabCreated } = await import('../src/opera-newtab.js');
  const storage = await import('../src/storage.js');
  const d = new FakeDevice('Opera tabs', 'chromium');
  use(d);
  const b = (globalThis as any).browser;
  const real = { update: b.tabs.update, query: b.tabs.query, contains: b.permissions.contains };
  const updated: number[] = [];
  let tabsInWindow = 2, granted = true;
  b.tabs.update = async (id: number) => { updated.push(id); };
  b.tabs.query = async () => Array.from({ length: tabsInWindow }, (_, i) => ({ id: i, windowId: 1, incognito: false }));
  b.permissions.contains = async () => granted;
  const tab = (id: number, url: string, incognito = false) => ({ id, windowId: 1, pendingUrl: url, incognito });
  try {
    await onOperaTabCreated(tab(1, 'chrome://startpageshared/'));
    expect(updated.length === 0, 'przekierowano mimo wylaczonej opcji');
    await storage.setLocal({ [KEYS.settings]: { operaNewTab: true } });
    await onOperaTabCreated(tab(2, 'chrome://startpageshared/'));
    expect(updated.join() === '2', 'nie przekierowano Speed Dialu');
    await onOperaTabCreated(tab(2, 'chrome://startpageshared/'));
    expect(updated.join() === '2', 'ta sama karta przekierowana drugi raz');
    await onOperaTabCreated(tab(3, 'https://startpage.com/'));
    await onOperaTabCreated(tab(4, 'chrome://startpageshared/', true));
    tabsInWindow = 1; await onOperaTabCreated(tab(5, 'chrome://startpageshared/')); tabsInWindow = 2;
    granted = false; await onOperaTabCreated(tab(6, 'chrome://startpageshared/'));
    expect(updated.join() === '2', `przekierowano obca strone, okno prywatne, pierwsza karte albo bez zgody: ${updated}`);
  } finally {
    Object.assign(b.tabs, { update: real.update, query: real.query });
    b.permissions.contains = real.contains;
  }
});

function arrangeOrderTest(device: FakeDevice, titles: string[]): void {
  for (const [index, title] of titles.entries()) {
    device.bookmarks.move(device.bookmarks.find(title)!.id,
      { parentId: tb(device), index });
  }
}

async function orderTestPair(label: string, count = 8): Promise<[FakeDevice, FakeDevice, string[]]> {
  const titles = Array.from({ length: count }, (_, i) => `${label} ${i}`);
  const a = await newBrowser(`${label} A`, 'chromium', label, device => {
    titles.forEach((title, i) => add(device, title, `https://order-safe.example/${label}/${i}`));
  });
  const b = await newBrowser(`${label} B`, 'gecko', label);
  await converge(a, b);
  return [a, b, titles];
}

await scenario('kolejnosc: lokalny ruch podczas pull zostaje przy zdalnej edycji tytulu', async () => {
  const [a, b, titles] = await orderTestPair('Order merge', 5);
  use(b);
  b.bookmarks.update(b.bookmarks.find(titles[0])!.id, { title: 'Order merge zmieniony tytul' });
  await sync(b);

  use(a);
  const desired = [titles[4], ...titles.slice(0, 4)];
  const realFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!injected && response.ok && url.includes('/api/v1/changes?')) {
      injected = true;
      arrangeOrderTest(a, desired);
    }
    return response;
  };
  try {
    await sync(a);
    same(a.bookmarks.titles(tb(a)),
      desired.map(title => title === titles[0] ? 'Order merge zmieniony tytul' : title),
      'lokalna kolejnosc po pull');
  } finally { globalThis.fetch = realFetch; }

  await converge(a, b);
  same(a.bookmarks.titles(tb(a)), b.bookmarks.titles(tb(b)), 'kolejnosc po scaleniu');
});

await scenario('kolejnosc: konflikt zachowuje uklad do odzyskania przez istniejacy przycisk', async () => {
  const engine = await import('../src/engine.js');
  const { conflictId } = await import('../src/conflict-id.js');
  const [a, b, titles] = await orderTestPair('Order conflict', 5);
  const remote = [titles[1], titles[0], ...titles.slice(2)];
  const local = [titles[4], ...titles.slice(0, 4)];

  use(b);
  arrangeOrderTest(b, remote);
  await sync(b);
  use(a);

  const realFetch = globalThis.fetch;
  let injected = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!injected && response.ok && url.includes('/api/v1/changes?')) {
      injected = true;
      arrangeOrderTest(a, local);
    }
    return response;
  };
  try {
    await sync(a);
    same(a.bookmarks.titles(tb(a)), remote, 'wersja serwera po konflikcie kolejnosci');
  } finally { globalThis.fetch = realFetch; }

  await converge(a, b);
  use(a);
  const note = (await conflictNotes()).find(item => item.reason === 'order-changed' && item.rejectedPlacement?.order);
  expect(note?.rejectedPlacement?.order, 'brak zapisanej kolejnosci');
  expect(note.rejectedPlacement.nodeId === 'root:toolbar', 'konflikt nie wskazuje korzenia paska');

  const status = await engine.restoreConflict(conflictId(note));
  expect(status.connection === 'ok' && !status.lastError, 'nie udalo sie odzyskac kolejnosci');
  await converge(a, b);
  same(a.bookmarks.titles(tb(a)), local, 'odzyskana kolejnosc w A');
  same(b.bookmarks.titles(tb(b)), local, 'odzyskana kolejnosc w B');

  use(a);
  const session = await getLocal<any>(KEYS.server, null);
  const head = (await api.hello(session)).head;
  await engine.restoreConflict(conflictId(note));
  expect((await api.hello(session)).head === head, 'powtorne odzyskanie wykonalo druga operacje');
});

await scenario('kolejnosc: przerwanie po dwoch ruchach wznawia dziennik bez odeslania polowy ukladu', async () => {
  const [a, b, titles] = await orderTestPair('Order partial');
  const desired = [...titles].reverse();
  use(b);
  arrangeOrderTest(b, desired);
  await sync(b);

  use(a);
  a.bookmarks.crashAfter = 2;
  const partial = await syncOnce();
  expect(partial.pushed === 0, 'przy odbieraniu wyslano czesciowy uklad');
  const state = await getLocal<any>('engineState', null);
  expect(state.pendingFolders.includes('root:toolbar') &&
    state.orderWork['root:toolbar']?.writing, 'brak trwalego zapisu niedokonczonego ruchu');
  expect(JSON.stringify(a.bookmarks.titles(tb(a))) !== JSON.stringify(desired),
    'test nie przerwal przestawiania w polowie');

  await converge(a, b);
  same(a.bookmarks.titles(tb(a)), desired, 'A po wznowieniu');
  same(b.bookmarks.titles(tb(b)), desired, 'B po wznowieniu');
  use(a);
  expect(!(await getLocal<any>('engineState', null)).orderWork['root:toolbar'],
    'zakonczony dziennik nie zostal usuniety');
  expect(!(await conflictNotes()).some(note => note.reason === 'order-changed'),
    'wlasne czesciowe ruchy uznano za konflikt');
});

await scenario('kolejnosc: wykonany ruch z utracona odpowiedzia jest rozliczany przez after', async () => {
  const [a, b, titles] = await orderTestPair('Order lost');
  const desired = [...titles].reverse();
  use(b);
  arrangeOrderTest(b, desired);
  await sync(b);

  use(a);
  a.bookmarks.loseNextMoveReply = true;
  await syncOnce();
  const state = await getLocal<any>('engineState', null);
  const write = state.orderWork['root:toolbar']?.writing;
  expect(write, 'utrata odpowiedzi usunela zapis zamiaru');
  same(a.bookmarks.getChildren(tb(a)).map(node => node.id), write.after,
    'wykonany ruch nie odpowiada zapisanemu after');

  await converge(a, b);
  same(a.bookmarks.titles(tb(a)), desired, 'kolejnosc po utracie odpowiedzi');
  expect(a.bookmarks.bookmarkCount() === titles.length, 'po wznowieniu zmienila sie liczba wpisow');
  use(a);
  expect(!(await conflictNotes()).some(note => note.reason === 'order-changed'),
    'ruch z utracona odpowiedzia uznano za edycje uzytkownika');
});

await scenario('kolejnosc: pozniejsza edycja po przerwaniu nie jest cofana do starego celu', async () => {
  const [a, b, titles] = await orderTestPair('Order later');
  use(b);
  arrangeOrderTest(b, [...titles].reverse());
  await sync(b);

  use(a);
  a.bookmarks.crashAfter = 2;
  await syncOnce();
  const wanted = [titles[0], titles[7], titles[2], titles[6], titles[1], titles[5], titles[3], titles[4]];
  arrangeOrderTest(a, wanted);

  await converge(a, b);
  same(a.bookmarks.titles(tb(a)), wanted, 'pozniejszy lokalny uklad w A');
  same(b.bookmarks.titles(tb(b)), wanted, 'pozniejszy lokalny uklad w B');
});

await scenario('tresc: edycja po zapisie notatki zatrzymuje nadpisanie starej migawki', async () => {
  const a = await newBrowser('Note race A', 'chromium', 'Edycja po notatce', d => {
    add(d, 'Note race baza', 'https://note-race.example/');
  });
  const b = await newBrowser('Note race B', 'gecko', 'Edycja po notatce');
  await converge(a, b);

  use(b);
  b.bookmarks.update(b.bookmarks.find('Note race baza')!.id, { title: 'Note race serwer' });
  await sync(b);

  use(a);
  const id = a.bookmarks.find('Note race baza')!.id;
  const realFetch = globalThis.fetch;
  let firstEdit = false;
  let secondEdit = false;

  a.local.afterSet = items => {
    const state = items.engineState as { conflicts?: { reason: string }[] } | undefined;
    if (!secondEdit && state?.conflicts?.some(note => note.reason === 'content-changed')) {
      secondEdit = true;
      a.local.afterSet = undefined;
      a.bookmarks.update(id, { title: 'Note race po zapisie' });
    }
  };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!firstEdit && response.ok && url.includes('/api/v1/changes?')) {
      firstEdit = true;
      a.bookmarks.update(id, { title: 'Note race pierwsza lokalna' });
    }
    return response;
  };

  try {
    await sync(a);
    expect(secondEdit && a.bookmarks.get(id)[0].title === 'Note race po zapisie',
      'po zapisie notatki nadpisano nowsza edycje stara migawka');
  } finally {
    a.local.afterSet = undefined;
    globalThis.fetch = realFetch;
  }

  await converge(a, b);
  use(a);
  expect((await conflictNotes()).some(note => note.rejectedContent?.fields.some(field =>
    field.local === 'Note race po zapisie')),
    'nowsza odrzucona wartosc nie zostala zachowana przed ponownym zastosowaniem serwera');
});

await scenario('kolejnosc: edycja po zapisie konfliktu nie zostaje nadpisana starym planem', async () => {
  const [a, b, titles] = await orderTestPair('Order note', 5);
  use(b);
  arrangeOrderTest(b, [titles[1], titles[0], ...titles.slice(2)]);
  await sync(b);
  use(a);

  const first = [titles[4], ...titles.slice(0, 4)];
  const latest = [titles[2], titles[4], titles[0], titles[3], titles[1]];
  const realFetch = globalThis.fetch;
  let injected = false;
  let editedAfterNote = false;

  a.local.afterSet = items => {
    const state = items.engineState as { conflicts?: { reason: string }[] } | undefined;
    if (!editedAfterNote && state?.conflicts?.some(note => note.reason === 'order-changed')) {
      editedAfterNote = true;
      a.local.afterSet = undefined;
      arrangeOrderTest(a, latest);
    }
  };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const response = await realFetch(input, init);
    if (!injected && response.ok && url.includes('/api/v1/changes?')) {
      injected = true;
      arrangeOrderTest(a, first);
    }
    return response;
  };
  try {
    await sync(a);
    expect(editedAfterNote, 'test nie wykonal edycji po notatce');
    same(a.bookmarks.titles(tb(a)), latest, 'nowsza kolejnosc po zapisie notatki');
  } finally {
    a.local.afterSet = undefined;
    globalThis.fetch = realFetch;
  }

  await converge(a, b);
  same(b.bookmarks.titles(tb(b)), latest, 'nowszy uklad po synchronizacji');
});

await scenario('strona startowa: konfiguracja profilu trafia do cache, offline zostaje, rozlaczenie czysci', async () => {
  const sp = await import('../src/startpage-cache.js');
  const storage = await import('../src/storage.js');
  const a = await newBrowser('Start A', 'chromium', 'Strona startowa', d => {
    use(d);
    const f = d.bookmarks.create({ parentId: tb(d), title: 'Ulubione' });
    add(d, 'Ulubiona', 'https://ulubiona.example/', f.id);
  });
  await converge(a);
  use(a);
  const localFolder = a.bookmarks.find('Ulubione')!.id;
  const state = await getLocal<any>('engineState', null);
  const folderId = state.mapping.l2s[localFolder];
  expect(folderId, 'brak mapowania folderu');

  const pid = await profile('Strona startowa');
  const current = await admin(`profiles/${pid}/startpage`);
  const put = await fetch(`${baseUrl}/admin/api/profiles/${pid}/startpage`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-FrogSync': '1', Cookie: cookie },
    body: JSON.stringify({ settingsVersion: current.settingsVersion, generation: current.generation,
      configuration: { version: 2, configured: true, template: 'glass',
        blocks: [{ id: 's1', type: 'folder', folderId, title: 'Moje' }],
        engines: [{ id: 'ceneo', name: 'Ceneo', url: 'https://www.ceneo.pl/;szukaj-%s', color: '#ff7a00', suggest: 'none' }] } }),
  });
  expect(put.ok, `zapis konfiguracji w panelu: HTTP ${put.status}`);

  await sp.refreshStartPage(true);
  const cache = await getLocal<any>(sp.STARTPAGE_CACHE, null);
  const map = await getLocal<{ folders: Record<string, string> }>(
    sp.STARTPAGE_MAP, { folders: {} });
  expect(cache?.snapshot.configuration.version === 2 &&
    cache.snapshot.configuration.blocks[0]?.title === 'Moje', 'blok nie trafil do cache v2');
  expect(cache.snapshot.configuration.engines[0]?.id === 'ceneo', 'katalog wyszukiwarek profilu nie trafil do cache');
  expect(map.folders[folderId] === localFolder, 'mapa folderu nie wskazuje lokalnego folderu');
  const etag = cache.etag;

  // Bez zmian na serwerze: 304, cache zostaje, ETag ten sam
  await sp.refreshStartPage(true);
  expect((await getLocal<any>(sp.STARTPAGE_CACHE, null)).etag === etag, 'ETag zmienil sie bez zmiany konfiguracji');

  // Offline: ostatnie poprawne dane zostaja
  const session = await getLocal<any>(KEYS.server, null);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/api/v1/startpage')) throw new TypeError('offline');
    return realFetch(input, init);
  };
  try { await sp.refreshStartPage(true); }
  finally { globalThis.fetch = realFetch; }
  expect((await sp.readStartPage()).cache?.snapshot.configuration.blocks.length === 1,
    'offline skasowal cache');

  // Inny profil (np. ponowne parowanie): stary cache nie pasuje do klucza
  await storage.setLocal({ [KEYS.server]: { ...session, profile: { ...session.profile, id: 'inny' } } });
  expect((await getLocal<any>(sp.STARTPAGE_CACHE, null)).key !== sp.cacheKey((await getLocal<any>(KEYS.server, null))),
    'cache starego profilu pasuje do nowej sesji');
  await storage.setLocal({ [KEYS.server]: session });

  await sp.clearStartPage();
  expect(!(await getLocal<any>(sp.STARTPAGE_CACHE, null)), 'rozlaczenie nie wyczyscilo cache');
});

await scenario('strona startowa v2: migracja starego cache i ochrona zakresu', async () => {
  const sp = await import('../src/startpage-cache.js');
  const a = new FakeDevice('Cache v1', 'chromium'); use(a);
  const session = {
    url: 'https://cache.example', token: 't', deviceId: 'd', deviceName: 'd',
    profile: { id: 'p', name: 'p' }, generation: 'g',
  };
  const folderId = '11111111-1111-1111-1111-111111111111';
  await a.local.set({
    [KEYS.server]: session,
    [sp.STARTPAGE_CACHE]: {
      key: session.url + '|p|g', etag: 'old', fetchedAt: Date.now(),
      snapshot: {
        profileId: 'p', generation: 'g', settingsVersion: 7, logoVersion: 0,
        configuration: {
          version: 1,
          sections: [{
            id: 's', folderId, title: 'Stara', available: true, folderTitle: 'Folder',
          }],
          engines: [],
        },
      },
    },
  });
  const view = await sp.readStartPage();
  expect(view.cache?.snapshot.configuration.version === 2 &&
    view.cache.snapshot.configuration.blocks[0].type === 'folder',
    'nie odczytano v1 jako v2');
  await a.local.set({ [KEYS.server]: { ...session, generation: 'new' } });
  expect(!(await sp.readStartPage()).cache, 'stary cache widoczny w nowej generacji');
});

await scenario('strona startowa v2: topSites tylko po lokalnej zgodzie, bez zapisu i sieci', async () => {
  const { localTopSites } = await import('../src/startpage-edit.js');
  const a = new FakeDevice('Top sites', 'chromium'); use(a);
  a.topSiteRows = [
    { title: 'Prywatna lista', url: 'https://private-top.example/' },
    { title: 'Duplikat', url: 'https://private-top.example/' },
    { title: 'Zly schemat', url: 'javascript:alert(1)' },
  ];
  expect((await localTopSites(false)).length === 0 && Number(a.topSitesCalls) === 0,
    'odczyt przy wylaczonej opcji');
  expect((await localTopSites(true)).length === 0 && Number(a.topSitesCalls) === 0,
    'odczyt bez zgody');
  a.topSitesGranted = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('topSites nie moze wywolywac sieci'); };
  try {
    expect((await localTopSites(true)).length === 1 && Number(a.topSitesCalls) === 1,
      'filtr lub deduplikacja topSites');
    a.incognito = true;
    expect((await localTopSites(true)).length === 0 && Number(a.topSitesCalls) === 1,
      'topSites w oknie prywatnym');
    expect(!JSON.stringify(await a.local.get(null)).includes('private-top.example'),
      'topSites zapisano w storage');
  } finally { globalThis.fetch = realFetch; }
});

await scenario('nowa karta: fokus tylko przy starcie i bez zmiany wpisanego tekstu po cache', async () => {
  const a = new FakeDevice('Newtab DOM', 'chromium'); use(a);
  await a.local.set({ [KEYS.settings]: { startPage: true, focusSearch: true } });
  const g = globalThis as any;
  const old = Object.fromEntries(
    ['document', 'window', 'HTMLButtonElement', 'setInterval', 'location'].map(k => [k, g[k]]));
  const browser = g.browser;
  const oldChanged = browser.storage.onChanged;
  let storageListener: ((changes: any, area: string) => void) | undefined;
  let focusCalls = 0;

  class Node {
    children: any[] = [];
    handlers: Record<string, ((event: any) => void)[]> = {};
    attributes = new Map<string, string>();
    style = { setProperty() {} };
    dataset = {};
    hidden = false;
    value = '';
    textContent = '';
    open = false;
    classList = { add() {}, remove() {}, toggle() {} };
    constructor(public tagName: string, public id = '') {}
    append(...values: any[]) { this.children.push(...values); }
    replaceChildren(...values: any[]) { this.children = values; }
    get childElementCount() { return this.children.length; }
    setAttribute(k: string, v: string) { this.attributes.set(k, v); }
    getAttribute(k: string) { return this.attributes.get(k) ?? null; }
    removeAttribute(k: string) { this.attributes.delete(k); }
    addEventListener(k: string, fn: (event: any) => void) {
      (this.handlers[k] ??= []).push(fn);
    }
    focus() {
      if (this.id === 'search') focusCalls++;
      doc.activeElement = this;
    }
    querySelector(selector: string): any {
      for (const child of this.children)
        if (child?.tagName?.toLowerCase() === selector) return child;
      return null;
    }
  }
  class Button extends Node { constructor() { super('BUTTON'); } }
  const nodes = new Map<string, Node>();
  const doc: any = {
    body: new Node('BODY'),
    documentElement: new Node('HTML'),
    visibilityState: 'visible',
    activeElement: null,
    handlers: {} as Record<string, ((e: any) => void)[]>,
    getElementById(id: string) {
      if (!nodes.has(id)) nodes.set(id, new Node(id === 'search' ? 'INPUT' : 'DIV', id));
      return nodes.get(id);
    },
    createElement(tag: string) {
      return tag === 'button' ? new Button() : new Node(tag.toUpperCase());
    },
    createTextNode(text: string) { return { textContent: text }; },
    addEventListener(k: string, fn: (e: any) => void) {
      (this.handlers[k] ??= []).push(fn);
    },
  };
  doc.activeElement = doc.body;
  try {
    g.document = doc;
    g.window = { addEventListener() {} };
    g.HTMLButtonElement = Button;
    g.location = { search: '', href: '' };
    g.setInterval = () => 0;
    browser.storage.onChanged = {
      addListener(fn: typeof storageListener) { storageListener = fn; },
    };
    await import('../src/newtab.js');
    await new Promise(r => setTimeout(r, 30));
    expect(focusCalls === 1, 'nie ustawiono jednorazowego fokusu');

    doc.getElementById('search').value = 'nie kasuj tekstu';
    doc.handlers.keydown.forEach((fn: (e: any) => void) => fn({}));
    storageListener?.({ [KEYS.settings]: { newValue: {} } }, 'local');
    await new Promise(r => setTimeout(r, 30));
    expect(focusCalls === 1 &&
      doc.getElementById('search').value === 'nie kasuj tekstu',
      'odswiezenie ponowilo fokus albo skasowalo wpisany tekst');
  } finally {
    browser.storage.onChanged = oldChanged;
    for (const [k, value] of Object.entries(old)) {
      if (value === undefined) delete g[k];
      else g[k] = value;
    }
  }
});


await scenario('stan ustalony: kolejne przebiegi niczego nie wysylaja ani nie pobieraja', async () => {
  const [a, b] = pair('A1', 'B1');
  await converge(a, b);
  for (const d of [a, b]) {
    const s = await sync(d);
    expect(s.pushed === 0, `${d.name} wyslal ${s.pushed} operacji bez zmian`);
  }
  // "Tajna" jest celowo wykluczona filtrem w A, wiec w B jej nie ma
  same(a.bookmarks.titles(tb(a)).filter(t => t !== 'Tajna'), b.bookmarks.titles('1'), 'paski po ustaleniu');
});

await scenario('odwolanie dostepu w panelu: wtyczka przestaje i mowi dlaczego', async () => {
  const b = pair('B1')[0];
  const state = await admin('state');
  const device = state.data.devices.find((d: any) => d.name === 'B1');
  await admin(`devices/${device.id}/revoke`, {});
  use(b);
  const status = await syncOnce();
  expect(status.connection === 'revoked', `oczekiwano revoked, jest ${status.connection}`);
  expect((await loadStatus()).connection === 'revoked', 'stan odwolania nie zapisal sie');
});

// ============================================================
// Pierwsze polaczenie nowej przegladarki (zakladki producenta)
// ============================================================

await scenario('nowa przegladarka w trybie "zastap": zero zakladek producenta na serwerze', async () => {
  const a = await newBrowser('A5', 'gecko', 'P5', d => {
    use(d);
    const praca = d.bookmarks.create({ parentId: d.bookmarks.toolbar, title: 'Praca' });
    d.bookmarks.create({ parentId: praca.id, title: 'Jira', url: 'https://jira.firma.pl/' });
    d.bookmarks.create({ parentId: d.bookmarks.toolbar, title: 'Poczta', url: 'https://poczta.pl/' });
  });
  const before = (await admin('state')).data.profiles.find((p: any) => p.name === 'P5').bookmarks;

  // Swieza "Opera" z zakladkami producenta i czesciowo pasujacym folderem
  const b = await newBrowser('B5', 'chromium', 'P5', d => {
    use(d);
    d.bookmarks.create({ parentId: '1', title: 'Poczta', url: 'https://poczta.pl/' });          // pasuje
    d.bookmarks.create({ parentId: '1', title: 'Opera Store', url: 'https://addons.opera.com/' }); // spam
    const praca = d.bookmarks.create({ parentId: '1', title: 'Praca' });                           // pasuje po nazwie
    d.bookmarks.create({ parentId: praca.id, title: 'Reklama w folderze', url: 'https://reklama.pl/' }); // nadmiarowe dziecko
    d.bookmarks.create({ parentId: '2', title: 'Spam w innych', url: 'https://spam.pl/' });
  }, 'replace');
  await converge(a, b);

  const after = (await admin('state')).data.profiles.find((p: any) => p.name === 'P5').bookmarks;
  expect(after === before, `na serwer trafilo ${after - before} zakladek producenta`);
  for (const spam of ['Opera Store', 'Reklama w folderze', 'Spam w innych']) {
    expect(!a.bookmarks.find(spam), `"${spam}" trafilo do drugiej przegladarki`);
    expect(b.bookmarks.find(spam), `"${spam}" zniknelo z nowej przegladarki zamiast trafic do kwarantanny`);
  }
  expect(b.bookmarks.findAll(n => n.url === 'https://poczta.pl/').length === 1, 'Poczta zdublowana');
  use(b);
  const notice = await getLocal<{ count: number } | null>('quarantineNotice', null);
  expect(notice?.count === 3, `okienko nie dostalo informacji o 3 odlozonych zakladkach (${JSON.stringify(notice)})`);

  // Pochodzenie odtworzone w kwarantannie
  const quarantine = b.bookmarks.find(QUARANTINE_TITLE)!;
  expect(quarantine && quarantine.parentId === '2', 'brak folderu kwarantanny w "Inne zakladki"');
  const pasek = b.bookmarks.findAll(n => n.parentId === quarantine.id && n.title === 'Pasek zakładek')[0];
  expect(pasek, 'brak odtworzonej sciezki "Pasek zakladek" w kwarantannie');
  const pracaQ = b.bookmarks.findAll(n => n.parentId === pasek.id && n.title === 'Praca')[0];
  expect(pracaQ && b.bookmarks.find('Reklama w folderze')!.parentId === pracaQ.id, 'nadmiarowe dziecko bez sciezki Pasek/Praca');

  // Pasek nowej przegladarki = dokladnie kolekcja z serwera
  same(b.bookmarks.titles('1'), a.bookmarks.titles(tb(a)), 'pasek po zastapieniu');
});

await scenario('wyciagniecie z kwarantanny dodaje wpis raz, usuniecie kwarantanny niczego nie wysyla', async () => {
  const [a, b] = pair('A5', 'B5');
  use(b);
  b.bookmarks.move(b.bookmarks.find('Opera Store')!.id, { parentId: '1', index: 0 });
  await converge(b, a);
  expect(a.bookmarks.findAll(n => n.title === 'Opera Store').length === 1, 'wyciagniety wpis nie dotarl albo sie zdublowal');

  const before = (await admin('state')).data.profiles.find((p: any) => p.name === 'P5').bookmarks;
  use(b); b.bookmarks.removeTree(b.bookmarks.find(QUARANTINE_TITLE)!.id);
  const s = await sync(b);
  expect(s.pushed === 0, `usuniecie kwarantanny wyslalo ${s.pushed} operacji`);
  const after = (await admin('state')).data.profiles.find((p: any) => p.name === 'P5').bookmarks;
  expect(after === before, 'usuniecie kwarantanny zmienilo serwer');
});

await scenario('pusty profil: zakladki przegladarki staja sie baza mimo trybu "zastap"', async () => {
  const a = await newBrowser('A6', 'chromium', 'P6', d => {
    use(d);
    d.bookmarks.create({ parentId: '1', title: 'Moja', url: 'https://moja.pl/' });
  }, 'replace');
  const p = (await admin('state')).data.profiles.find((x: any) => x.name === 'P6');
  expect(p.bookmarks === 1, `pusty profil powinien przyjac 1 zakladke, ma ${p.bookmarks}`);
  expect(!a.bookmarks.find(QUARANTINE_TITLE), 'przy pustym profilu nie moze powstac kwarantanna');
});

await scenario('ubicie wtyczki w polowie pierwszego polaczenia: bez duplikatow i bez spamu na serwerze', async () => {
  const a = await newBrowser('A7', 'gecko', 'P7', d => {
    use(d);
    for (let i = 0; i < 12; i++) d.bookmarks.create({ parentId: d.bookmarks.toolbar, title: `Wspolna ${i}`, url: `https://w.pl/${i}` });
  });
  const before = (await admin('state')).data.profiles.find((p: any) => p.name === 'P7').bookmarks;

  const b = new FakeDevice('B7', 'chromium');
  created.push(b);
  use(b);
  for (let i = 0; i < 6; i++) b.bookmarks.create({ parentId: '1', title: `Producent ${i}`, url: `https://prod.pl/${i}` });
  const { code } = await admin(`profiles/${await profile('P7')}/pairing`, { deviceName: 'B7' });
  const preview = await api.preview(baseUrl, code);

  // Kilka zmian i "przegladarka ubija wtyczke" — raz w kwarantannie, raz przy tworzeniu
  b.bookmarks.crashAfter = 4;
  const first = await pairWith(baseUrl, code, 'B7', 'replace', preview.hasContent);
  expect(first.connection !== 'ok' || first.lastError, 'symulowane ubicie nie przerwalo pierwszego polaczenia');
  b.bookmarks.crashAfter = 9;
  use(b); await syncOnce();
  for (let i = 0; i < 4; i++) { use(b); await syncOnce(); }
  await converge(a, b);

  const after = (await admin('state')).data.profiles.find((p: any) => p.name === 'P7').bookmarks;
  expect(after === before, `po przerwaniach na serwer trafilo ${after - before} zakladek producenta`);
  for (let i = 0; i < 12; i++)
    expect(b.bookmarks.findAll(n => n.url === `https://w.pl/${i}`).length === 1, `"Wspolna ${i}" w B ${b.bookmarks.findAll(n => n.url === `https://w.pl/${i}`).length} razy`);
  for (let i = 0; i < 6; i++)
    expect(b.bookmarks.findAll(n => n.url === `https://prod.pl/${i}`).length === 1, `"Producent ${i}" zgubiony albo zdublowany`);
});

// ============================================================
// Znaleziska z przegladu Codexa
// ============================================================

await scenario('zdalne usuniecie folderu nie zabiera lokalnej, niesynchronizowanej zawartosci', async () => {
  const [a, b] = pair('A5', 'B5');
  use(a);
  const config = await loadFilterConfig();
  config.manualExclusions.push({ id: 'y', type: 'urlPattern', value: 'https://lokalne.local/*', label: 'lokalne' });
  await saveFilterConfig(config);
  const f = a.bookmarks.create({ parentId: tb(a), title: 'Do usuniecia' }).id;
  a.bookmarks.create({ parentId: f, title: 'Wspolna w folderze', url: 'https://wspolna.pl/' });
  a.bookmarks.create({ parentId: f, title: 'Tylko lokalna', url: 'https://lokalne.local/x' });
  await converge(a, b);

  use(b); b.bookmarks.removeTree(b.bookmarks.find('Do usuniecia')!.id);
  await converge(b, a);

  expect(!a.bookmarks.find('Do usuniecia'), 'folder nie zostal usuniety w A');
  expect(!a.bookmarks.find('Wspolna w folderze'), 'wspolna zakladka nie zostala usunieta w A');
  const kept = a.bookmarks.find('Tylko lokalna');
  expect(kept, 'lokalna, wykluczona zakladka zginela razem z folderem');
  expect(kept!.parentId === tb(a), 'lokalna zakladka nie trafila do rodzica usunietego folderu');
});

await scenario('nieudane przestawienie nie wraca na serwer jako zmiana uzytkownika', async () => {
  const [a, b] = pair('A5', 'B5');
  add(a, 'K1', 'https://k1.pl/');
  add(a, 'K2', 'https://k2.pl/');
  add(a, 'K3', 'https://k3.pl/');
  await converge(a, b);

  use(a);
  a.bookmarks.move(a.bookmarks.find('K3')!.id, { parentId: tb(a), index: 0 });
  await sync(a);

  b.bookmarks.failNextMoves = 1000;          // B nie potrafi przestawic
  use(b); await syncOnce();
  use(b); await syncOnce();                   // gdyby diff ruszyl, odeslalby stara kolejnosc
  b.bookmarks.failNextMoves = 0;
  await converge(b, a);

  const order = a.bookmarks.titles(tb(a)).filter(t => /^K\d$/.test(t));
  same(order, ['K3', 'K1', 'K2'], 'kolejnosc w A (zmiana uzytkownika A zostala nadpisana?)');
  same(b.bookmarks.titles('1').filter(t => /^K\d$/.test(t)), order, 'kolejnosc w B');
});

await scenario('ubicie wtyczki tuz po utworzeniu zakladek: zadna sie nie dubluje', async () => {
  const [a, b] = pair('A5', 'B5');
  for (let i = 0; i < 6; i++) add(a, `Seria ${i}`, `https://seria.pl/${i}`);
  await sync(a);
  b.bookmarks.crashAfter = 3;
  use(b); await syncOnce();
  await converge(b, a);
  for (let i = 0; i < 6; i++) {
    expect(b.bookmarks.findAll(n => n.url === `https://seria.pl/${i}`).length === 1, `Seria ${i} w B nie jest dokladnie raz`);
    expect(a.bookmarks.findAll(n => n.url === `https://seria.pl/${i}`).length === 1, `Seria ${i} w A nie jest dokladnie raz`);
  }
});

await scenario('masowe usuniecie w tej przegladarce czeka na potwierdzenie przed wyslaniem', async () => {
  const a = await newBrowser('A8', 'gecko', 'P8', d => {
    use(d);
    for (let i = 0; i < 70; i++) d.bookmarks.create({ parentId: d.bookmarks.toolbar, title: `Lok ${i}`, url: `https://lok.pl/${i}` });
  });
  const b = await newBrowser('B8', 'chromium', 'P8');
  await converge(a, b);

  use(a); for (const n of a.bookmarks.findAll(n => n.title.startsWith('Lok '))) a.bookmarks.removeTree(n.id);
  add(a, 'Nowa w trakcie', 'https://nowa.pl/');
  const held = await sync(a);
  expect((held.blockedLocalDeletions ?? 0) >= 70, `lokalny hamulec nie zadzialal (${held.blockedLocalDeletions})`);
  await converge(b);
  expect(b.bookmarks.bookmarkCount() >= 70, 'usuniecie wyszlo mimo hamulca');
  expect(b.bookmarks.find('Nowa w trakcie'), 'hamulec zablokowal tez zwykle zmiany');

  use(a); await confirmDeletions('local');
  await converge(a, b);
  const status = await sync(b);
  if (status.blockedDeletions) { use(b); await confirmDeletions('remote'); }
  await converge(a, b);
  expect(!b.bookmarks.find('Lok 0'), 'po potwierdzeniu usuniecie nie dotarlo');
});

await scenario('wlasny folder "Menu zakladek" w Chromium nie jest przejmowany jako menu', async () => {
  const a = await newBrowser('A9', 'gecko', 'P9', d => {
    use(d); d.bookmarks.create({ parentId: 'menu________', title: 'Z menu FF', url: 'https://menu-ff.pl/' });
  });
  const b = await newBrowser('B9', 'chromium', 'P9', d => {
    use(d);
    const own = d.bookmarks.create({ parentId: '2', title: 'Menu zakładek' });
    d.bookmarks.create({ parentId: own.id, title: 'Prywatna', url: 'https://prywatna.pl/' });
  }, 'merge');
  await converge(a, b);
  expect(a.bookmarks.find('Prywatna')?.parentId !== 'menu________', 'zawartosc wlasnego folderu trafila do menu Firefoksa');
  const menuInB = b.bookmarks.find('Z menu FF')!;
  expect(b.bookmarks.find('Prywatna')!.parentId !== menuInB.parentId, 'wlasny folder zostal uzyty jako menu');
});

await scenario('zakladki firmowe (zarzadzane) zostaja nietkniete i nie wychodza na serwer', async () => {
  const a = await newBrowser('A10', 'chromium', 'P10', d => {
    use(d);
    d.bookmarks.addManaged('Firmowe', ['https://intranet.firma.pl/']);
    d.bookmarks.create({ parentId: '1', title: 'Zwykla', url: 'https://zwykla.pl/' });
  });
  const b = await newBrowser('B10', 'gecko', 'P10');
  await converge(a, b);
  expect(!b.bookmarks.find('https://intranet.firma.pl/'), 'zakladka firmowa wyszla na serwer');
  expect(a.bookmarks.find('https://intranet.firma.pl/'), 'zakladka firmowa zniknela');
  expect(b.bookmarks.find('Zwykla'), 'zwykla zakladka nie dotarla');
});

await scenario('przejscie z wersji 0.1.0: stary stan jest przenoszony, nic sie nie dubluje', async () => {
  const [a, b] = pair('A5', 'B5');
  await converge(a, b);
  const before = (await admin('state')).data.profiles.find((p: any) => p.name === 'P5').bookmarks;
  // Stan tak, jak zapisywala go wersja 0.1.0 — osobne klucze zamiast engineState
  use(a);
  const storage = await import('../src/storage.js');
  const st = await getLocal<any>('engineState', null);
  await storage.setLocal({ [KEYS.mapping]: st.mapping, [KEYS.known]: st.known, [KEYS.cursor]: st.cursor, [KEYS.outbox]: [] });
  await a.local.remove('engineState');
  await converge(a, b);
  const after = (await admin('state')).data.profiles.find((p: any) => p.name === 'P5').bookmarks;
  expect(after === before, `po przejsciu przybylo ${after - before} zakladek na serwerze`);
  expect(a.bookmarks.findAll(n => n.url === 'https://poczta.pl/').length === 1, 'Poczta zdublowana w A');
  expect(await getLocal(KEYS.mapping, null) === null, 'stare klucze nie zostaly sprzatniete');
});

const restoreEngine = await import('../src/engine.js');
const { emptyRestoreTree } = await import('../src/core/restore.js');
type RestoreNodeForTest = import('../src/core/restore.js').RestoreNode;
type RestoreTreeForTest = import('../src/core/restore.js').RestoreTree;
type SessionForRestoreTest = import('../src/types.js').ServerSession;

const restoreBookmark = (title: string, url: string): RestoreNodeForTest =>
  ({ kind: 'bookmark', title, url });

function restoreTreeFromToolbar(nodes: RestoreNodeForTest[]): RestoreTreeForTest {
  const tree = emptyRestoreTree();
  tree['root:toolbar'] = nodes;
  return tree;
}

function comparableRestoreNode(node: RestoreNodeForTest): unknown {
  if (node.kind === 'folder') return ['folder', node.title, node.children.map(comparableRestoreNode)];
  if (node.kind === 'bookmark') return ['bookmark', node.title, node.url];
  return ['separator'];
}

function compareRestoreToolbar(device: FakeDevice, desired: RestoreNodeForTest[]): void {
  function walk(parentId: string): unknown[] {
    return device.bookmarks.getChildren(parentId).map(node => {
      if (node.type === 'separator') return ['separator'];
      if (node.url !== undefined) return ['bookmark', node.title, node.url];
      return ['folder', node.title, walk(node.id)];
    });
  }

  const actual = JSON.stringify(walk(tb(device)));
  const expected = JSON.stringify(desired.map(comparableRestoreNode));
  expect(actual === expected, `${device.name}: zawartosc lub kolejnosc paska rozni sie od kopii`);
}

async function currentRestoreSession(device: FakeDevice): Promise<SessionForRestoreTest> {
  use(device);
  const session = await getLocal<SessionForRestoreTest | null>(KEYS.server, null);
  expect(session, `${device.name}: brak sesji`);
  return session;
}

await scenario('przywracanie: 200 zakladek, 60 usuniec, 20 ruchow, zachowane ID i zgoda w changes', async () => {
  const url = (i: number) => `https://restore.example/${i}`;
  const title = (i: number) => `Odtwarzana ${i}`;
  const duplicateUrl = 'https://restore.example/szw';
  const trashUrl = 'https://restore.example/kosz-tylko-w-pliku';
  const localTrashUrl = 'https://restore.example/kosz-lokalny';

  const a = await newBrowser('Restore A', 'chromium', 'Przywracanie 200', device => {
    for (let i = 0; i < 198; i++) add(device, title(i), url(i));
    const szw = device.bookmarks.create({ parentId: tb(device), title: 'SZW' });
    add(device, 'SZW duplikat', duplicateUrl, szw.id);
    add(device, 'SZW duplikat', duplicateUrl, szw.id);
    const trash = device.bookmarks.create({ parentId: device.bookmarks.other, title: 'Kosz' });
    add(device, 'Tylko w lokalnym Koszu', localTrashUrl, trash.id);
  });
  const b = await newBrowser('Restore B', 'gecko', 'Przywracanie 200');
  await converge(a, b);

  const session = await currentRestoreSession(a);
  const before = await api.hello(session);
  const previousIds = new Map(Array.from({ length: 138 }, (_, i) => [i, a.bookmarks.find(title(i))!.id]));
  const duplicateIds = a.bookmarks.findAll(n => n.url === duplicateUrl).map(n => n.id);
  const localTrashId = a.bookmarks.find('Tylko w lokalnym Koszu')!.id;

  // Rotacja dwudziestu pierwszych wpisow zachowuje LIS pozostalych 118.
  const order = [...Array.from({ length: 118 }, (_, i) => i + 20), ...Array.from({ length: 20 }, (_, i) => i)];
  const desired = order.map(i => restoreBookmark(i < 3 ? `Nowy tytul ${i}` : title(i), url(i)));
  desired.push(
    { kind: 'folder', title: 'SZW', children: [
      restoreBookmark('SZW duplikat', duplicateUrl),
      restoreBookmark('SZW duplikat', duplicateUrl),
    ] },
    restoreBookmark('Nowa 1', 'https://restore.example/nowa-1'),
    restoreBookmark('Nowa 2', 'https://restore.example/nowa-2'),
  );
  const tree = restoreTreeFromToolbar(desired);
  tree['root:unsorted'].push({
    kind: 'folder', title: 'Kosz',
    children: [restoreBookmark('Tylko w eksporcie', trashUrl)],
  });

  use(a);
  const preview = await restoreEngine.previewRestore(tree);
  expect(preview.counts.remove === 60 && preview.counts.move === 20 &&
    preview.counts.update === 3 && preview.counts.create === 2,
    `niepoprawne podsumowanie: ${JSON.stringify(preview.counts)}`);
  const applied = await restoreEngine.runRestore(tree, preview.summaryId);
  expect(applied.connection === 'ok' && !applied.lastError && !applied.blockedLocalDeletions,
    `przywracanie w A nie doszlo do konca: ${JSON.stringify(applied)}`);
  compareRestoreToolbar(a, desired);
  for (const [i, id] of previousIds) {
    expect(a.bookmarks.find(i < 3 ? `Nowy tytul ${i}` : title(i))?.id === id, `zmieniono ID zakladki ${i}`);
  }
  same(a.bookmarks.findAll(n => n.url === duplicateUrl).map(n => n.id), duplicateIds, 'ID duplikatow SZW');
  expect(a.bookmarks.find('Tylko w lokalnym Koszu')?.id === localTrashId, 'lokalny Kosz zostal zmieniony');

  const page = await api.changes(session, before.head);
  const tombstones = page.nodes.filter(n => n.deleted);
  expect(!page.more && tombstones.length === 60 && tombstones.every(n => n.approved === true),
    'serwer nie zapisal zgody na wszystkich 60 tombstone');
  expect(!page.nodes.some(n => n.url === trashUrl || n.url === localTrashUrl), 'zawartosc Kosza wyszla na serwer');

  const received = await sync(b);
  expect(!received.blockedDeletions, 'druga przegladarka zapytala o zatwierdzone usuniecia');
  compareRestoreToolbar(b, desired);
  expect(b.bookmarks.bookmarkCount() === 142, 'druga przegladarka ma zla liczbe zakladek');
});

await scenario('przywracanie: utracona odpowiedz po create, wznowienie bez duplikatu', async () => {
  const a = await newBrowser('Restore crash A', 'chromium', 'Przywracanie przerwane', d => {
    add(d, 'Zostaje', 'https://restore-crash.example/zostaje');
    add(d, 'Do usuniecia', 'https://restore-crash.example/usun');
  });
  const b = await newBrowser('Restore crash B', 'gecko', 'Przywracanie przerwane');
  await converge(a, b);

  const desired = [
    restoreBookmark('Nowa po wznowieniu', 'https://restore-crash.example/nowa'),
    restoreBookmark('Zostaje', 'https://restore-crash.example/zostaje'),
  ];
  const tree = restoreTreeFromToolbar(desired);
  use(a);
  const preview = await restoreEngine.previewRestore(tree);
  const session = await currentRestoreSession(a);
  const before = await api.hello(session);
  a.bookmarks.loseNextBookmarkCreateReply = true;

  const interrupted = await restoreEngine.runRestore(tree, preview.summaryId);
  expect(interrupted.connection === 'error' && interrupted.consecutiveFailures === 1,
    'przerwanie nie zostalo pokazane jako blad');
  expect(await getLocal('restoreJob', null), 'po przerwaniu brak trwalego zadania');
  const created = a.bookmarks.findAll(n => n.url === 'https://restore-crash.example/nowa');
  expect(created.length === 1, 'atrapa nie zapisala nowego wpisu przed utrata odpowiedzi');
  expect((await api.hello(session)).head === before.head, 'niepelny plan wyszedl na serwer');

  // Ponowny przebieg nie uzywa poprzedniej instancji zadania w pamieci.
  await converge(a, b);
  compareRestoreToolbar(a, desired);
  compareRestoreToolbar(b, desired);
  expect(a.bookmarks.find('Nowa po wznowieniu')?.id === created[0].id,
    'wznowienie nie zaadoptowalo wpisu z utraconej odpowiedzi');
  use(a);
  expect(await getLocal('restoreJob', null) === null, 'ukonczone zadanie zostalo w storage');
});

await scenario('przywracanie ponad progiem zdalnego hamulca: tylko zatwierdzone usuniecia przechodza', async () => {
  const a = await newBrowser('Restore brake A', 'chromium', 'Przywracanie hamulec', d => {
    for (let i = 0; i < 130; i++) add(d, `Hamulec ${i}`, `https://restore-brake.example/${i}`);
  });
  const b = await newBrowser('Restore brake B', 'gecko', 'Przywracanie hamulec');
  await converge(a, b);

  const desired = Array.from({ length: 70 }, (_, i) =>
    restoreBookmark(`Hamulec ${i}`, `https://restore-brake.example/${i}`));
  const tree = restoreTreeFromToolbar(desired);
  use(a);
  const preview = await restoreEngine.previewRestore(tree);
  const restored = await restoreEngine.runRestore(tree, preview.summaryId);
  expect(restored.connection === 'ok' && !restored.blockedLocalDeletions, 'import zatrzymal lokalny hamulec');

  // 60 > max(50, 30% z 130), wiec ten test rozroznia znacznik od zwyklego usuniecia.
  const auto = await sync(b);
  expect(!auto.blockedDeletions && b.bookmarks.bookmarkCount() === 70,
    'zatwierdzone kasowania nie przeszly bez potwierdzenia w B');

  use(a);
  for (let i = 0; i < 60; i++) a.bookmarks.removeTree(a.bookmarks.find(`Hamulec ${i}`)!.id);
  const held = await sync(a);
  expect(held.blockedLocalDeletions === 60, 'zwykle kasowania ominely lokalny hamulec');
  use(a);
  const confirmed = await confirmDeletions('local');
  expect(confirmed.connection === 'ok', 'potwierdzenie lokalne nie wyslalo operacji');
  const remote = await sync(b);
  expect(remote.blockedDeletions === 60 && b.bookmarks.bookmarkCount() === 70,
    'zwykle kasowania ominely zdalny hamulec');
});

await scenario('migracja 0.1.0 zachowuje lokalne usuniecia i przestawienia przy pustej generacji', async () => {
  const a = await newBrowser('Restore legacy A', 'chromium', 'Przywracanie migracja', d => {
    for (let i = 0; i < 12; i++) add(d, `Legacy ${i}`, `https://restore-legacy.example/${i}`);
  });
  const b = await newBrowser('Restore legacy B', 'gecko', 'Przywracanie migracja');
  await converge(a, b);

  const session = await currentRestoreSession(a);
  const state = await getLocal<{ known: unknown; mapping: unknown; cursor: number } | null>('engineState', null);
  expect(state && state.cursor > 0, 'brak stanu wyjsciowego migracji');
  use(a);
  await a.local.set({
    [KEYS.server]: { ...session, generation: '' },
    [KEYS.known]: state.known, [KEYS.mapping]: state.mapping,
    [KEYS.cursor]: state.cursor, [KEYS.outbox]: [],
  });
  await a.local.remove('engineState');

  a.bookmarks.removeTree(a.bookmarks.find('Legacy 2')!.id);
  a.bookmarks.removeTree(a.bookmarks.find('Legacy 4')!.id);
  a.bookmarks.move(a.bookmarks.find('Legacy 9')!.id, { parentId: tb(a), index: 0 });
  a.bookmarks.move(a.bookmarks.find('Legacy 10')!.id, { parentId: tb(a), index: 1 });
  const expected = a.bookmarks.titles(tb(a));

  await converge(a, b);
  same(a.bookmarks.titles(tb(a)), expected, 'Opera po migracji');
  same(b.bookmarks.titles(tb(b)), expected, 'druga przegladarka po migracji');
  use(a);
  expect((await restoreEngine.listRestorePoints()).some(point => point.reason === 'migration'),
    'brak punktu sprzed migracji');
});

await scenario('punkt przywracania: podglad, cofniecie do identycznego drzewa i eksport HTML', async () => {
  const a = new FakeDevice('Restore undo bez parowania', 'chromium');
  use(a);
  const original = [
    restoreBookmark('Pierwsza', 'https://restore-undo.example/pierwsza'),
    restoreBookmark('Druga', 'https://restore-undo.example/druga'),
    { kind: 'folder', title: 'SZW', children: [
      restoreBookmark('Powtorzenie', 'https://restore-undo.example/szw'),
      restoreBookmark('Powtorzenie', 'https://restore-undo.example/szw'),
    ] },
  ] satisfies RestoreNodeForTest[];
  add(a, 'Pierwsza', 'https://restore-undo.example/pierwsza');
  add(a, 'Druga', 'https://restore-undo.example/druga');
  const folder = a.bookmarks.create({ parentId: tb(a), title: 'SZW' });
  add(a, 'Powtorzenie', 'https://restore-undo.example/szw', folder.id);
  add(a, 'Powtorzenie', 'https://restore-undo.example/szw', folder.id);

  const replacement = [restoreBookmark('Inna', 'https://restore-undo.example/inna')];
  const tree = restoreTreeFromToolbar(replacement);
  const preview = await restoreEngine.previewRestore(tree);
  const applied = await restoreEngine.runRestore(tree, preview.summaryId);
  expect(applied.connection === 'unpaired' && !applied.lastError, 'lokalne przywracanie wymaga parowania');
  compareRestoreToolbar(a, replacement);

  const point = (await restoreEngine.listRestorePoints()).find(item => item.reason === 'html');
  expect(point, 'brak punktu sprzed przywracania');
  const html = await restoreEngine.exportPointHtml(point.id);
  expect(html.startsWith('<!DOCTYPE NETSCAPE-Bookmark-file-1>') &&
    html.includes('https://restore-undo.example/pierwsza') &&
    !html.includes('https://restore-undo.example/inna'), 'HTML nie zawiera wlasciwego punktu');

  const undo = await restoreEngine.previewUndo(point.id);
  const reverted = await restoreEngine.undoToPoint(point.id, undo.summaryId);
  expect(reverted.connection === 'unpaired' && !reverted.lastError, 'cofniecie punktu nie powiodlo sie');
  compareRestoreToolbar(a, original);
  expect((await restoreEngine.listRestorePoints()).some(item => item.reason === 'undo'),
    'cofniecie nie zapisalo stanu sprzed operacji');
});

await scenario('przywracanie w Operze (usuniecie = przeniesienie do Kosza) usuwa tez w drugiej przegladarce', async () => {
  const url = (i: number) => `https://opera-kosz.example/${i}`;
  const a = await newBrowser('Opera K', 'chromium', 'Opera Kosz', d => {
    for (let i = 0; i < 20; i++) add(d, `Opera ${i}`, url(i));
  });
  a.bookmarks.operaTrash = true;
  const b = await newBrowser('Edge K', 'chromium', 'Opera Kosz');
  await converge(a, b);
  const desired = Array.from({ length: 12 }, (_, i) => restoreBookmark(`Opera ${i}`, url(i)));
  use(a);
  const preview = await restoreEngine.previewRestore(restoreTreeFromToolbar(desired));
  expect(preview.counts.remove === 8, `podsumowanie: ${JSON.stringify(preview.counts)}`);
  const st = await restoreEngine.runRestore(restoreTreeFromToolbar(desired), preview.summaryId);
  expect(st.connection === 'ok' && !st.lastError, `przywracanie: ${JSON.stringify(st)}`);
  await converge(a, b);
  compareRestoreToolbar(a, desired);
  compareRestoreToolbar(b, desired);
});

await scenario('serwer przywrocony z kopii: stara kolejka nie zmienia odtworzonej bazy', async () => {
  const [a, b] = pair('A5', 'B5');
  await converge(a, b);
  const { file } = await admin('backup', {});
  add(a, 'Po kopii', 'https://po-kopii.pl/');
  await sync(a);
  await admin('restore', { name: file });

  // B ma niewyslana zmiane sprzed odtworzenia — nie moze jej narzucic odtworzonej bazie bez uzgodnienia
  add(b, 'Z B po odtworzeniu', 'https://z-b.pl/');
  await converge(b, a);
  expect(b.bookmarks.find('Z B po odtworzeniu') && a.bookmarks.find('Z B po odtworzeniu'), 'zmiana z B zginela po odtworzeniu');
  expect(a.bookmarks.findAll(n => n.url === 'https://po-kopii.pl/').length <= 1, 'zdublowana zakladka po odtworzeniu');
  // "Tylko lokalna" jest wykluczona filtrem w A (scenariusz wyzej) — z definicji nie ma jej w B
  same(a.bookmarks.titles(tb(a)).filter(t => t !== 'Tylko lokalna'), b.bookmarks.titles('1'), 'paski po odtworzeniu');
});

// ============================================================

function devices(): FakeDevice[] { return created; }
function pair(...names: string[]): FakeDevice[] { return names.map(n => created.find(d => d.name === n)!); }

console.log('');
if (failures.length) { console.error(`${failures.length} scenariuszy nie przeszlo, ${passed} przeszlo.`); process.exit(1); }
console.log(`OK — ${passed} scenariuszy end-to-end przeszlo.`);
process.exit(0);

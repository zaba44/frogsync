// ============================================================
// Build rozszerzenia.
//
// v1 trzymala popup.html, options.html i _locales w TRZECH katalogach naraz
// (extension/, extension/chrome/, extension/firefox/) i kopiowala je skryptem.
// Kazda edycja wymagala pamietania, ktora kopia jest zrodlem.
//
// Tutaj zrodlo jest jedno, manifesty sa generowane z jednego obiektu,
// a katalogi docelowe sa w calosci odtwarzane przy kazdym buildzie.
//
//   node build.mjs             -> build/chrome, build/firefox
//   node build.mjs --zip       -> dodatkowo paczki w dist/
//   node build.mjs --watch     -> przebudowa przy zmianie zrodel
//   node build.mjs --test-core
// ============================================================

import { build, context } from 'esbuild';
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const ROOT = dirname(fileURLToPath(import.meta.url));

const args    = process.argv.slice(2);
const doZip   = args.includes('--zip');
const doWatch = args.includes('--watch');

// Jedno zrodlo wersji dla manifestow i wydania.
const { version: VERSION } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (typeof VERSION !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(VERSION)) {
  throw new Error('package.json: wersja musi miec format X.Y.Z bez przyrostkow.');
}
if (VERSION.split('.').some(part => Number(part) > 65535) || VERSION === '0.0.0') {
  throw new Error('package.json: wersja nie miesci sie w zakresie manifestu rozszerzenia.');
}

// Lokalny build nie wymaga tagu. Build na tagu musi byc z nim zgodny.
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${VERSION}`) {
  throw new Error(`Tag ${process.env.GITHUB_REF_NAME} nie odpowiada wersji v${VERSION}.`);
}

// Klucz publiczny przypinajacy ID rozszerzenia w przegladarkach Chromium.
// Bez niego Chrome liczy ID ze sciezki katalogu, a przeniesienie folderu
// oznaczaloby nowe rozszerzenie, czysty storage i parowanie od nowa.
// Wynikowe ID: pjgjhknpldlhialgflagbkkpfangbhfl. Klucz prywatny (tylko do pakowania .crx) lezy
// w chrome-key.pem i nie jest wersjonowany. Przed wysylka do Chrome Web Store
// pole `key` nalezy usunac — sklep nadaje wlasne ID.
const CHROME_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2oT3h2TvCt4CJZqZYK76cviFokOnXrAUGS8bvtZrdfYQ' +
  '5z6odY4Uj9/VNrwS64k8QJKmmBbP+bwjzUogfVmUasTruN1kPwpu5Egukqagb1z1VPuibNW/UYUMOUKyHWtcVmWI' +
  '9NzJ3k/rH3wzX2A+jEenIUSzHsyMieDmNAwC4SS48wjx6NaEmqCGaBOWu3F3u9qq+UXOfoWVBMpK0zeFQBVJ3g+G' +
  'Eq5G9AMuM3U7Td6mdJUSXtOVv3zAZa4PH9aLWQPgWHOyQUArujYkXjXbCiVl+P5hmyRP3qUO6Xf43yOU1XLxHnzc' +
  'cADW/AH/qdNEOtfQyIRbB6WeCtuekc7ArwIDAQAB';

const ENTRY_POINTS = ['src/background.ts', 'src/popup.ts', 'src/options.ts'];
const STATIC_FILES = ['ui/popup.html', 'ui/options.html', 'ui/style.css'];

// ============================================================
// Manifesty
// ============================================================

function manifestFor(target) {
  const icons = existsSync(join(ROOT, 'icons', 'icon128.png'))
    ? { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' }
    : undefined;

  const shared = {
    manifest_version: 3,
    name: 'FrogSync',
    version: VERSION,
    description: 'Synchronizacja zakładek między przeglądarkami przez własny serwer.',
    permissions: ['bookmarks', 'storage', 'alarms'],
    // Adres serwera kazdy ma inny, wiec zgoda na polaczenie jest prosba
    // w chwili parowania — wylacznie dla tego jednego adresu, a nie dla
    // wszystkich stron, jak bylby to staly wpis host_permissions.
    optional_host_permissions: ['https://*/*'],
    options_ui: { page: 'options.html', open_in_tab: true },
    action: { default_popup: 'popup.html', ...(icons ? { default_icon: icons } : {}) },
    ...(icons ? { icons } : {}),
  };

  if (target === 'chrome') {
    return {
      ...shared,
      key: CHROME_KEY,
      background: { service_worker: 'background.js' },
      // Ponizej tej wersji Chrome nie zwracal obietnic ze wszystkich uzywanych API
      minimum_chrome_version: '116',
    };
  }

  return {
    ...shared,
    background: { scripts: ['background.js'] },
    browser_specific_settings: {
      gecko: {
        id: 'frogsync@frogsync.local',
        update_url: 'https://zaba44.github.io/frogsync/updates.json',
        strict_min_version: '128.0',
        data_collection_permissions: { required: ['none'], optional: [] },
      },
    },
  };
}

// ============================================================
// Build
// ============================================================

const esbuildOptions = {
  entryPoints: ENTRY_POINTS.map(p => join(ROOT, p)),
  outdir: join(ROOT, '.bundle'),
  bundle: true,
  format: 'iife',
  target: ['chrome116', 'firefox115'],
  logLevel: 'info',
  legalComments: 'none',
};

async function runBuild() {
  rmSync(join(ROOT, '.bundle'), { recursive: true, force: true });
  await build(esbuildOptions);

  for (const target of ['chrome', 'firefox']) {
    const outDir = join(ROOT, 'build', target);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    for (const name of ['background.js', 'popup.js', 'options.js']) {
      cpSync(join(ROOT, '.bundle', name), join(outDir, name));
    }

    for (const file of STATIC_FILES) {
      cpSync(join(ROOT, file), join(outDir, file.split('/').pop()));
    }

    const iconsDir = join(ROOT, 'icons');
    if (existsSync(join(iconsDir, 'icon128.png'))) cpSync(iconsDir, join(outDir, 'icons'), { recursive: true });

    writeFileSync(
      join(outDir, 'manifest.json'),
      JSON.stringify(manifestFor(target), null, 2) + '\n',
    );

    console.log(`  ${target.padEnd(8)} ${describeDir(outDir)}`);
  }

  if (doZip) packAll();
}

function describeDir(dir) {
  let bytes = 0, files = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else { bytes += info.size; files++; }
    }
  };
  walk(dir);
  return `${files} plików, ${(bytes / 1024).toFixed(0)} kB`;
}

// ============================================================
// Paczki
// ============================================================

function packAll() {
  const distDir = join(ROOT, 'dist');
  mkdirSync(distDir, { recursive: true });

  pack(join(ROOT, 'build', 'chrome'),  join(distDir, 'chrome-extension.zip'));
  // XPI to zwykly ZIP; Mozilla podpisuje go przy wysylce.
  pack(join(ROOT, 'build', 'firefox'), join(distDir, 'firefox-extension.xpi'));

  // Chrome Web Store odrzuca pole "key" i nadaje wtyczce wlasne ID,
  // wiec paczka do sklepu to ta sama zawartosc bez klucza.
  const storeDir = join(ROOT, 'build', 'chrome-store');
  rmSync(storeDir, { recursive: true, force: true });
  cpSync(join(ROOT, 'build', 'chrome'), storeDir, { recursive: true });
  const storeManifest = JSON.parse(readFileSync(join(storeDir, 'manifest.json'), 'utf8'));
  delete storeManifest.key;
  writeFileSync(join(storeDir, 'manifest.json'), JSON.stringify(storeManifest, null, 2));
  pack(storeDir, join(distDir, 'chrome-store.zip'));

  for (const name of ['chrome-extension.zip', 'chrome-store.zip', 'firefox-extension.xpi']) {
    const file = join(distDir, name);
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
    console.log(`  ${name.padEnd(24)} ${(statSync(file).size / 1024).toFixed(0)} kB  sha256:${hash}`);
  }
}

// Wlasny zapis ZIP zamiast Compress-Archive z PowerShella:
//   - Compress-Archive odmawia zapisu do pliku z rozszerzeniem .xpi,
//   - potrafi zapisywac sciezki z backslashami, a specyfikacja ZIP wymaga
//     ukosnikow zwyklych; przegladarka nie znalazlaby wtedy icons/icon16.png.
function pack(sourceDir, outFile) {
  rmSync(outFile, { force: true });

  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const name = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) walk(full, name);
      else files.push({ name, data: readFileSync(full) });
    }
  };
  walk(sourceDir, '');

  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8');
    const deflated = deflateRawSync(file.data, { level: 9 });
    const crc = crc32(file.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);          // wersja wymagana
    localHeader.writeUInt16LE(0, 6);           // flagi
    localHeader.writeUInt16LE(8, 8);           // deflate
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(deflated.length, 18);
    localHeader.writeUInt32LE(file.data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);          // extra

    locals.push(localHeader, nameBytes, deflated);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);        // wersja tworzacego
    centralHeader.writeUInt16LE(20, 6);        // wersja wymagana
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(deflated.length, 20);
    centralHeader.writeUInt32LE(file.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(0, 38);        // atrybuty zewnetrzne
    centralHeader.writeUInt32LE(offset, 42);

    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + deflated.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, Buffer.concat([...locals, centralBuffer, end]));
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// ============================================================
// Test wektorow klucza URL
// ============================================================

async function bundleNode(entry, outName) {
  const out = join(ROOT, '.bundle', outName);
  await build({
    entryPoints: [join(ROOT, entry)],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node18',
    external: ['node:*'],
    logLevel: 'warning',
  });
  return out;
}

async function testCore() {
  execFileSync(process.execPath, [await bundleNode('tools/core.test.ts', 'core.test.mjs')], { stdio: 'inherit' });
}

// ============================================================

async function buildE2e() {
  return bundleNode('tools/e2e.ts', 'e2e.mjs');
}

if (args.includes('--test-core')) {
  await testCore();
} else if (args.includes('--build-e2e')) {
  console.log(await buildE2e());
} else if (doWatch) {
  const ctx = await context(esbuildOptions);
  await ctx.watch();
  await runBuild();
  console.log('Obserwuję zmiany. Ctrl+C kończy.');
} else {
  console.log('Buduję rozszerzenie…');
  await runBuild();
  console.log('Gotowe.');
}

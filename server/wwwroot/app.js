// Panel FrogSync. Zwykly JavaScript bez bibliotek poza generatorem kodu QR.
'use strict';

const $ = (sel) => document.querySelector(sel);
const views = ['setup', 'login', 'main'];
let setupCode = '';
let state = null;

// ============================================================
// Komunikacja z serwerem
// ============================================================

class ConnectionError extends Error {}

async function api(path, body, extraHeaders = {}) {
  const options = { method: body === undefined ? 'GET' : 'POST', headers: { ...extraHeaders }, credentials: 'same-origin' };
  if (body !== undefined) {
    options.headers['Content-Type'] = body instanceof Blob ? 'application/octet-stream' : 'application/json';
    // Naglowek, ktorego formularz z obcej strony nie potrafi dolaczyc — ochrona przed CSRF
    options.headers['X-FrogSync'] = '1';
    options.body = body instanceof Blob ? body : JSON.stringify(body);
  }
  let response;
  try { response = await fetch('admin/api/' + path, options); }
  catch (e) {
    if (!(e instanceof TypeError)) throw e;
    throw new ConnectionError('Brak połączenia z serwerem. Odśwież stronę. Po zmianie certyfikatu przeglądarka może wymagać jego ponownego zaakceptowania.');
  }
  let data = {};
  try { data = await response.json(); } catch (e) { /* pusta odpowiedz */ }
  if (response.status === 401 && path !== 'login') { show('login'); throw new Error(data.message || 'Zaloguj się ponownie.'); }
  if (!response.ok) throw new Error(data.message || ('Błąd ' + response.status));
  return data;
}

function show(view) {
  for (const v of views) $('#view-' + v).hidden = v !== view;
  $('#logout').hidden = view !== 'main';
}

function notice(text, kind) {
  const el = $('#notice');
  el.textContent = text;
  el.className = 'notice ' + (kind || 'error');
  el.hidden = !text;
  if (text && kind === 'ok') setTimeout(() => { if (el.textContent === text) el.hidden = true; }, 4000);
}

async function guarded(action) {
  notice('');
  $('#retry-connection').hidden = true;
  try { await action(); } catch (e) {
    notice(e.message);
    $('#retry-connection').hidden = !(e instanceof ConnectionError);
  }
}

// ============================================================
// Start
// ============================================================

$('#retry-connection').addEventListener('click', () => guarded(boot));

async function boot() {
  const status = await api('status');
  if (!status.configured) show('setup');
  else if (!status.signedIn) show('login');
  else { show('main'); await refresh(); }
}

// ============================================================
// Pierwsza konfiguracja
// ============================================================

$('#setup-start').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const f = e.target;
    if (f.password.value !== f.password2.value) throw new Error('Hasła się różnią.');
    setupCode = f.setupCode.value.trim();
    const result = await api('setup/start', { setupCode, password: f.password.value });

    const qr = qrcode(0, 'M');
    qr.addData(result.uri);
    qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    $('#secret').textContent = result.secret.replace(/(.{4})/g, '$1 ').trim();

    f.hidden = true;
    $('#setup-finish').hidden = false;
    $('#setup-finish').totp.focus();
  });
});

$('#setup-finish').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    await api('setup/finish', { setupCode, totp: e.target.totp.value.trim() });
    show('main');
    notice('Konfiguracja zakończona. Dodaj pierwszy profil.', 'ok');
    await refresh();
  });
});

// ============================================================
// Logowanie
// ============================================================

$('#login').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    await api('login', { password: e.target.password.value, totp: e.target.totp.value.trim() });
    e.target.reset();
    show('main');
    await refresh();
  });
});

$('#logout').addEventListener('click', () => {
  if (!spCanLeave()) return;
  const editor = spEditor;
  if (editor) {
    editor.busy = true;
    spUpdate();
  }
  guarded(async () => {
    try {
      await api('logout', {});
      spClear();
      show('login');
    } finally {
      if (editor) editor.busy = false;
      spUpdate();
    }
  });
});

// ============================================================
// Panel
// ============================================================

async function refresh() {
  state = await api('state');
  renderProfiles();
  spRenderProfileButtons();
  renderDevices();
  renderBackups();
  renderAudit();
  renderCertificate(await api('certificate'));
}

function renderCertificate(c) {
  const box = $('#cert-info');
  box.className = 'cert-info' + (c.selfSigned ? ' self' : '');
  const days = Math.round((c.notAfter - Date.now()) / 86400000);
  box.replaceChildren(
    el('div', {}, el('strong', {}, c.selfSigned ? 'Samopodpisany — wtyczka mu nie zaufa' : 'Własny certyfikat')),
    el('div', {}, 'Nazwy: ', c.names.join(', ') || '—'),
    el('div', {}, 'Wystawca: ', c.issuer),
    el('div', {}, `Ważny do: ${new Date(c.notAfter).toLocaleDateString('pl-PL')} (${days} dni)`),
    el('div', { class: 'mono muted' }, 'SHA-256: ' + c.fingerprint));
  $('#cert-reset').hidden = c.source !== 'uploaded';
}

function readFile(file, asText) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(asText ? reader.result : String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Nie udało się odczytać pliku.'));
    if (asText) reader.readAsText(file); else reader.readAsDataURL(file);
  });
}

function certificateUploaded(info) {
  renderCertificate(info);
  notice('Certyfikat wgrany. Odśwież stronę — przeglądarka połączy się już z nowym certyfikatem.', 'ok');
}

$('#cert-pfx').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const f = e.target;
    const info = await api('certificate', { pfxBase64: await readFile(f.file.files[0], false), password: f.password.value });
    f.reset();
    certificateUploaded(info);
  });
});

$('#cert-pem').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const f = e.target;
    const info = await api('certificate', { certPem: await readFile(f.cert.files[0], true), keyPem: await readFile(f.key.files[0], true) });
    f.reset();
    certificateUploaded(info);
  });
});

$('#cert-reset').addEventListener('click', () => {
  if (!confirm('Wrócić do certyfikatu samopodpisanego? Wtyczki stracą połączenie, dopóki nie wgrasz nowego certyfikatu.')) return;
  guarded(async () => renderCertificate(await api('certificate/reset', {})));
});

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function when(ms) {
  if (!ms) return '—';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 90) return 'przed chwilą';
  if (seconds < 3600) return Math.round(seconds / 60) + ' min temu';
  if (seconds < 86400) return Math.round(seconds / 3600) + ' godz. temu';
  return new Date(ms).toLocaleString('pl-PL');
}

function profileName(id) {
  return state.data.profiles.find((p) => p.id === id)?.name || '?';
}

function renderProfiles() {
  const box = $('#profiles');
  box.replaceChildren();
  if (state.data.profiles.length === 0) {
    box.append(el('div', { class: 'empty' }, 'Brak profili. Dodaj pierwszy powyżej.'));
    return;
  }
  for (const p of state.data.profiles) {
    const devices = state.data.devices.filter((d) => d.profileId === p.id && !d.revokedAt).length;
    box.append(el('div', { class: 'row' },
      el('div', {},
        el('strong', {}, p.name), ' ',
        el('span', { class: 'muted small' }, `${p.bookmarks} zakładek · ${devices} urządzeń`)),
      el('div', { class: 'actions' },
        el('button', { class: 'primary', onclick: () => pair(p) }, 'Sparuj przeglądarkę'),
        el('button', { onclick: () => renameProfile(p) }, 'Zmień nazwę'))));
  }
}

function renderDevices() {
  const body = $('#devices');
  body.replaceChildren();
  if (state.data.devices.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: '6', class: 'empty' }, 'Brak sparowanych przeglądarek.')));
    return;
  }
  for (const d of state.data.devices) {
    const revoked = !!d.revokedAt;
    const behind = revoked ? '—' : d.behind === 0
      ? el('span', { class: 'badge' }, 'na bieżąco')
      : el('span', { class: 'badge bad' }, String(d.behind));
    body.append(el('tr', { class: revoked ? 'revoked' : '' },
      el('td', {}, d.name),
      el('td', {}, profileName(d.profileId)),
      el('td', { class: 'muted' },
        el('div', {}, d.browser || '—'),
        el('div', {
          class: d.extensionVersionStatus === 'incompatible' ? 'badge bad' : 'muted small',
        }, 'FrogSync ' + (d.extensionVersion || '—') + ' · ' + ({
          current: 'aktualna',
          update: 'do aktualizacji',
          incompatible: 'niezgodna',
          unknown: 'wersja niezgłoszona',
        }[d.extensionVersionStatus] || 'wersja niezgłoszona'))),
      el('td', { class: 'muted', title: d.lastIp || '' }, when(d.lastSeenAt)),
      el('td', {}, behind),
      el('td', {}, revoked ? el('span', { class: 'muted small' }, 'odwołane') : el('div', { class: 'actions' },
        el('button', { onclick: () => renameDevice(d) }, 'Nazwa'),
        el('button', { class: 'danger', onclick: () => revoke(d) }, 'Odwołaj')))));
  }
}

function renderBackups() {
  const info = state.backups;
  $('#backup-warning').hidden = !info.warning;
  $('#backup-warning').textContent = info.warning || '';
  const box = $('#backups');
  box.replaceChildren();
  if (info.files.length === 0) { box.append(el('div', { class: 'empty' }, 'Jeszcze nie ma kopii.')); return; }
  for (const f of info.files.slice(0, 10)) {
    box.append(el('div', { class: 'row' },
      el('div', {}, el('code', {}, f.name), ' ', el('span', { class: 'muted small' }, `${f.sizeKb} kB · ${when(f.at)}`)),
      el('div', {}, el('a', { href: backupUrl(f.name), download: f.name }, 'Pobierz'), ' ',
        el('button', { class: 'danger', onclick: () => restore(f) }, 'Przywróć'))));
  }
}

const AUDIT_NAMES = {
  'startpage-settings': 'zmiana ustawień strony startowej',
  'startpage-logo': 'zapis logo profilu',
  'startpage-logo-deleted': 'usunięcie logo profilu',
  'startpage-background': 'zapis tła strony startowej',
  'startpage-background-deleted': 'usunięcie tła strony startowej',
  'admin-created': 'utworzono administratora', 'admin-login': 'logowanie', 'admin-login-failed': 'nieudane logowanie',
  'admin-logout': 'wylogowanie', 'admin-password-changed': 'zmiana hasła', 'admin-reset': 'reset administratora',
  'profile-created': 'nowy profil', 'profile-renamed': 'zmiana nazwy profilu',
  'pairing-code-created': 'kod parowania', 'device-paired': 'sparowano urządzenie', 'pairing-failed': 'zły kod parowania',
  'device-revoked': 'odwołano urządzenie', 'device-renamed': 'zmiana nazwy urządzenia', 'backup-manual': 'kopia ręczna',
  'backup-restored': 'przywrócono kopię', 'certificate-uploaded': 'wgrano certyfikat', 'certificate-reset': 'certyfikat samopodpisany',
};

function renderAudit() {
  const body = $('#audit');
  body.replaceChildren();
  for (const a of state.audit) {
    body.append(el('tr', {},
      el('td', { class: 'muted' }, new Date(a.at).toLocaleString('pl-PL')),
      el('td', {}, AUDIT_NAMES[a.kind] || a.kind),
      el('td', {}, a.actor || '—'),
      el('td', { class: 'muted' }, a.ip || '—'),
      el('td', { class: 'muted small' }, a.detail || '')));
  }
}

// ============================================================
// Akcje
// ============================================================

$('#new-profile').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    await api('profiles', { name: e.target.name.value.trim() });
    e.target.reset();
    notice('Profil dodany.', 'ok');
    await refresh();
  });
});

let pairingTimer = null;

function pair(profile) {
  const deviceName = prompt('Nazwa przeglądarki, którą parujesz (np. „Biuro — Firefox”):');
  if (!deviceName) return;
  guarded(async () => {
    const result = await api(`profiles/${profile.id}/pairing`, { deviceName: deviceName.trim() });
    $('#pairing-device').textContent = deviceName.trim();
    $('#pairing-code').textContent = result.code.slice(0, 3) + ' ' + result.code.slice(3);
    const tick = () => {
      const left = Math.max(0, Math.round((result.expiresAt - Date.now()) / 1000));
      $('#pairing-left').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      if (left === 0) { clearInterval(pairingTimer); $('#pairing-code').textContent = 'wygasł'; }
    };
    clearInterval(pairingTimer);
    tick();
    pairingTimer = setInterval(tick, 1000);
    $('#pairing-dialog').showModal();
  });
}

$('#pairing-dialog').addEventListener('close', () => { clearInterval(pairingTimer); guarded(refresh); });

function renameProfile(profile) {
  const name = prompt('Nowa nazwa profilu:', profile.name);
  if (!name || name.trim() === profile.name) return;
  guarded(async () => { await api(`profiles/${profile.id}/rename`, { name: name.trim() }); await refresh(); });
}

function renameDevice(device) {
  const name = prompt('Nowa nazwa urządzenia:', device.name);
  if (!name || name.trim() === device.name) return;
  guarded(async () => { await api(`devices/${device.id}/rename`, { name: name.trim() }); await refresh(); });
}

function revoke(device) {
  if (!confirm(`Odwołać dostęp dla „${device.name}”?\n\nPrzeglądarka natychmiast przestanie się synchronizować. Ponowne podłączenie wymaga nowego kodu parowania.`)) return;
  guarded(async () => { await api(`devices/${device.id}/revoke`, {}); notice('Dostęp odwołany.', 'ok'); await refresh(); });
}

function restore(file) {
  if (!confirm(`Przywrócić stan z kopii ${file.name}?

Obecny stan zostanie najpierw zapisany jako osobna kopia, więc można się z tego wycofać. Wszystkie przeglądarki uzgodnią swoje zakładki ze stanem z kopii przy najbliższej synchronizacji.`)) return;
  guarded(async () => {
    const r = await api('restore', { name: file.name });
    notice('Przywrócono. Stan sprzed przywrócenia zapisano jako ' + r.safetyBackup + '.', 'ok');
    show('login');
  });
}

function backupUrl(name) { return 'admin/api/backups/' + encodeURIComponent(name); }

$('#backup-now').addEventListener('click', (e) => guarded(async () => {
  e.target.disabled = true;
  try { const r = await api('backup', {}); el('a', { href: backupUrl(r.file), download: r.file }).click(); notice('Kopia gotowa: ' + r.file, 'ok'); await refresh(); }
  finally { e.target.disabled = false; }
}));

for (const [selector, path] of [['#setup-restore', 'setup/restore'], ['#restore-upload', 'restore/upload']]) {
  $(selector).addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const file = form.elements.file.files[0];
    if (!file || !confirm('Przywrócić serwer z pliku ' + file.name + '?')) return;
    const submit = form.querySelector('button');
    guarded(async () => {
      submit.disabled = true;
      try {
        const code = form.elements.setupCode;
        const result = await api(path, file, code ? { 'X-Setup-Code': code.value.trim() } : {});
        form.reset();
        show('login');
        notice('Przywrócono serwer. Zaloguj się danymi z kopii. Kopia poprzedniego stanu: ' + result.safetyBackup, 'ok');
      } finally { submit.disabled = false; }
    });
  });
}

$('#password').addEventListener('submit', (e) => {
  e.preventDefault();
  guarded(async () => {
    const f = e.target;
    await api('password', { current: f.current.value, next: f.next.value, totp: f.totp.value.trim() });
    f.reset();
    show('login');
    notice('Hasło zmienione. Zaloguj się nowym hasłem.', 'ok');
  });
});

// ============================================================
// Motyw
// ============================================================

// ============================================================
// Strona startowa profilu
// ============================================================

const SP_BUILTINS = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=%s', color: '#1A73E8', suggest: 'google' },
  { id: 'allegro', name: 'Allegro', url: 'https://allegro.pl/listing?string=%s', color: '#FF5A00', suggest: 'none' },
  { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/results?search_query=%s', color: '#E62117', suggest: 'none' },
  { id: 'maps', name: 'Mapy', url: 'https://www.google.com/maps/search/%s', color: '#34A853', suggest: 'none' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s', color: '#008373', suggest: 'none' },
  { id: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', color: '#DE5833', suggest: 'none' },
  { id: 'wikipedia', name: 'Wikipedia', url: 'https://pl.wikipedia.org/w/index.php?search=%s', color: '#54595D', suggest: 'none' },
];

let spEditor = null;
let spOpening = false;

class SpHttpError extends Error {
  constructor(status, data) {
    super(data.message || ('Błąd HTTP ' + status));
    this.status = status;
    this.data = data;
  }
}

async function spRequest(path, { method = 'GET', body, type, image = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = {};
    if (method !== 'GET') headers['X-FrogSync'] = '1';
    if (body !== undefined)
      headers['Content-Type'] = type || 'application/json';
    const response = await fetch('admin/api/' + path, {
      method, headers, credentials: 'same-origin', cache: 'no-store',
      signal: controller.signal,
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    });
    const generation = response.headers.get('X-FrogSync-Generation');
    if (image && (response.ok || (response.status === 404 && generation))) {
      return {
        generation,
        version: Number(response.headers.get(image === 'background'
          ? 'X-FrogSync-Background-Version' : 'X-FrogSync-Logo-Version')),
        blob: response.status === 404 ? null : await response.blob(),
      };
    }
    if (!response.ok) {
      let data = {};
      try { data = await response.json(); } catch { /* Komunikat awaryjny ponizej. */ }
      if (response.status === 401) {
        show('login');
        notice('Sesja wygasła. Zaloguj się ponownie; formularz strony startowej pozostaje zachowany.');
      }
      throw new SpHttpError(response.status, data);
    }
    try { return await response.json(); }
    catch (error) {
      if (error instanceof SyntaxError)
        throw new Error('Serwer zwrócił niepoprawną odpowiedź. Formularz został zachowany.');
      throw error;
    }
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError')
      throw new ConnectionError('Brak odpowiedzi serwera. Formularz i wybrany plik pozostały zachowane. Spróbuj ponownie.');
    throw error;
  } finally { clearTimeout(timer); }
}

function spPath(editor) {
  return 'profiles/' + encodeURIComponent(editor.profileId);
}

function spCheckSnapshot(value, profileId) {
  if (!value || value.profileId !== profileId || typeof value.generation !== 'string' ||
      !value.generation || !Number.isSafeInteger(value.settingsVersion) || value.settingsVersion < 0 ||
      !Number.isSafeInteger(value.logoVersion) || value.logoVersion < 0 ||
      !Number.isSafeInteger(value.backgroundVersion) || value.backgroundVersion < 0 ||
      value.configuration?.version !== 2 || typeof value.configuration.configured !== 'boolean' ||
      !Object.hasOwn(SP_V2_TEMPLATES, value.configuration.template) ||
      !Array.isArray(value.configuration.blocks) || !Array.isArray(value.configuration.engines))
    throw new Error('Niepoprawna konfiguracja v2. Formularz nie został zmieniony.');
  return value;
}

function spDocument(snapshot) {
  const config = snapshot.configuration;
  return {
    version: 2, configured: config.configured, template: config.template,
    blocks: config.blocks.map(b => {
      const block = { id: b.id, type: b.type, title: b.title ?? null };
      if (b.type === 'folder') block.folderId = b.folderId;
      if (b.type === 'custom') block.tiles = b.tiles.map(t => ({
        id: t.id, title: t.title, url: t.url, color: t.color ?? null,
      }));
      return block;
    }),
    engines: config.engines.map(e => ({
      id: e.id, name: e.name, url: e.url, color: e.color, suggest: e.suggest,
    })),
  };
}

function spSettingsDirty(editor) {
  return JSON.stringify(editor.draft) !== JSON.stringify(spDocument(editor.base));
}

function spHasDraft() {
  return !!spEditor && (spSettingsDirty(spEditor) ||
    Object.values(spEditor.assets).some(asset => asset.action !== 'keep'));
}

function spMessage(text, kind = 'error') {
  const box = $('#sp-message');
  box.textContent = text;
  box.className = 'notice ' + kind;
  box.hidden = !text;
}

function spRenderProfileButtons() {
  const rows = $('#profiles').querySelectorAll('.row');
  state.data.profiles.forEach((profile, i) => {
    const button = spButton('Strona startowa', () => spOpen(profile), 'sp-profile-open');
    rows[i]?.querySelector('.actions')?.append(button);
    if (spEditor?.profileId === profile.id) spEditor.profileName = profile.name;
  });
  spUpdate();
}

function spButton(text, action, className = '') {
  return el('button', { type: 'button', class: className, onclick: action }, text);
}

function spCanLeave() {
  if (spOpening || spEditor?.busy) {
    spMessage('Poczekaj na zakończenie bieżącej operacji.');
    return false;
  }
  return !spHasDraft() || confirm('Odrzucić niezapisany układ i wybrane zmiany logo oraz tła?');
}

function spClear() {
  spEditor = null;
  $('#startpage-editor').hidden = true;
  $('#sp-sections').replaceChildren();
  $('#sp-engines').replaceChildren();
  $('#sp-server-version').replaceChildren();
  for (const name of ['logo', 'background']) {
    $('#sp-' + name + '-file').value = '';
    $('#sp-' + name + '-preview').removeAttribute('src');
    $('#sp-' + name + '-preview').hidden = true;
  }
  $('#sp-template-background').removeAttribute('src');
  $('#sp-template-background').hidden = true;
  $('#sp-conflict').hidden = true;
  $('#sp-profile-name').textContent = '';
  $('#sp-versions').textContent = '';
  spMessage('');
  spUpdate();
}

async function spOpen(profile) {
  if (spOpening || spEditor?.busy) return;
  if (spEditor?.profileId === profile.id) {
    $('#startpage-editor').scrollIntoView({ block: 'start' });
    return;
  }
  if (!spCanLeave()) return;
  spOpening = true;
  $('#startpage-editor').hidden = false;
  spMessage('Wczytywanie profilu…', 'ok');
  spUpdate();
  try {
    const prefix = 'profiles/' + encodeURIComponent(profile.id);
    const [snapshot, folders] = await Promise.all([
      spRequest(prefix + '/startpage'), spRequest(prefix + '/folders'),
    ]);
    spCheckSnapshot(snapshot, profile.id);
    const editor = {
      profileId: profile.id, profileName: profile.name,
      base: snapshot, draft: spDocument(snapshot),
      folders: [], foldersGeneration: '', folderLabels: new Map(),
      busy: false, conflict: null,
      assets: { logo: spNewAsset(snapshot), background: spNewAsset(snapshot) },
    };
    spSetFolders(editor, folders);
    if (folders.generation !== snapshot.generation)
      throw new Error('Stan serwera zmienił się podczas odczytu. Otwórz profil ponownie.');
    spEditor = editor;
    for (const name of ['logo', 'background']) $('#sp-' + name + '-file').value = '';
    spRenderSections(editor);
    spRenderEngines(editor);
    for (const name of ['logo', 'background']) spRenderAsset(editor, name);
    spRenderConflict(editor);
    spMessage('');
    for (const name of ['logo', 'background']) void spLoadAsset(editor, name);
  } catch (error) {
    spMessage(error.message);
  } finally {
    spOpening = false;
    spUpdate();
    if (!$('#view-main').hidden)
      $('#startpage-editor').scrollIntoView({ block: 'start' });
  }
}

function spSetFolders(editor, value) {
  if (!value || value.profileId !== editor.profileId ||
      typeof value.generation !== 'string' || !Array.isArray(value.folders))
    throw new Error('Niepoprawna lista folderów. Formularz został zachowany.');
  editor.folders = value.folders;
  editor.foldersGeneration = value.generation;
  const children = new Map();
  const sort = (a, b) => a.order < b.order ? -1 : a.order > b.order ? 1 :
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  for (const folder of value.folders) {
    if (!children.has(folder.parentId)) children.set(folder.parentId, []);
    children.get(folder.parentId).push(folder);
  }
  for (const list of children.values()) list.sort(sort);
  const seen = new Set();
  const labels = new Map();
  const roots = value.folders.filter(f => f.kind === 'root').sort(sort);
  const rootNames = {
    'root:toolbar': 'Pasek zakładek', 'root:menu': 'Menu zakładek',
    'root:unsorted': 'Pozostałe zakładki', 'root:mobile': 'Zakładki mobilne',
  };
  for (const seed of [...roots, ...value.folders]) {
    const stack = [{ folder: seed, trail: [], depth: 0 }];
    while (stack.length) {
      const { folder, trail, depth } = stack.pop();
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      const name = rootNames[folder.id] || folder.title || '(bez nazwy)';
      const parts = [...trail, name].slice(-5);
      if (folder.kind === 'folder')
        labels.set(folder.id, (depth >= 5 ? '… / ' : '') + parts.join(' / '));
      const nested = children.get(folder.id) || [];
      for (let i = nested.length - 1; i >= 0; i--)
        stack.push({ folder: nested[i], trail: parts, depth: depth + 1 });
    }
  }
  editor.folderLabels = labels;
}

function spField(title, input) {
  return el('label', {}, el('span', {}, title), input);
}

function spInput(value, attrs, change) {
  const input = el('input', attrs);
  input.value = value ?? '';
  input.addEventListener('input', () => { change(input.value); spUpdate(); });
  return input;
}

function spMove(list, index, delta) {
  const target = index + delta;
  if (target >= 0 && target < list.length)
    [list[index], list[target]] = [list[target], list[index]];
}

function spRowActions(list, index, render) {
  const up = spButton('W górę', () => { spMove(list, index, -1); render(); spUpdate(); });
  const down = spButton('W dół', () => { spMove(list, index, 1); render(); spUpdate(); });
  up.disabled = index === 0;
  down.disabled = index === list.length - 1;
  return el('div', { class: 'sp-row-actions' }, up, down,
    spButton('Usuń', () => { list.splice(index, 1); render(); spUpdate(); }, 'danger'));
}

function spRenderSections(editor) {
  spRenderBlocks(editor);
  spRenderTemplate(editor);
}

function spRenderEngines(editor) {
  const box = $('#sp-engines');
  box.replaceChildren();
  editor.draft.engines.forEach((engine, index) => {
    const suggest = el('select', {});
    suggest.append(el('option', { value: 'none' }, 'Bez sugestii sieciowych'),
      el('option', { value: 'google' }, 'Sugestie Google'));
    suggest.value = engine.suggest;
    suggest.addEventListener('change', () => { engine.suggest = suggest.value; spUpdate(); });
    box.append(el('div', { class: 'sp-row' },
      el('div', { class: 'sp-engine-fields' },
        spField('Nazwa', spInput(engine.name, { required: '', maxlength: '100' },
          value => { engine.name = value; })),
        spField('Adres HTTPS — dokładnie jeden %s',
          spInput(engine.url, { required: '', maxlength: '2048', spellcheck: 'false' },
            value => { engine.url = value; })),
        spField('Kolor', spInput(engine.color, { type: 'color' },
          value => { engine.color = value; })),
        spField('Podpowiedzi', suggest)),
      spRowActions(editor.draft.engines, index, () => spRenderEngines(editor))));
  });
  $('#sp-default-engines').hidden = editor.draft.engines.length !== 0;
}

function spRenderConflict(editor) {
  const conflict = editor.conflict;
  $('#sp-conflict').hidden = !conflict;
  const box = $('#sp-server-version');
  box.replaceChildren();
  if (!conflict) return;
  const current = conflict.current, config = current.configuration;
  $('#sp-conflict-kind').textContent = {
    settings: 'Konflikt układu strony startowej.', logo: 'Konflikt logo.', background: 'Konflikt tła.',
  }[conflict.kind];
  box.append(el('p', { class: 'small muted' },
    'Ustawienia: ' + current.settingsVersion + '; logo: ' + current.logoVersion +
    '; tło: ' + current.backgroundVersion + '.'),
    el('p', {}, 'Szablon: ' + SP_V2_TEMPLATES[config.template]));
  const blocks = el('ol', {});
  config.blocks.forEach(b => {
    const caption = b.type === 'folder'
      ? (b.title || b.folderTitle || b.folderId) + (b.available ? '' : ' — folder niedostępny')
      : b.title || (b.type === 'top' ? 'Najczęściej odwiedzane' : 'Własne kafelki');
    const row = el('li', {}, caption);
    if (b.type === 'custom') {
      const tiles = el('ul', {});
      b.tiles.forEach(t => tiles.append(el('li', {}, t.title + ': ' + t.url +
        (t.color ? ' · ' + t.color : ''))));
      row.append(tiles);
    }
    blocks.append(row);
  });
  box.append(config.blocks.length ? blocks : el('p', {}, config.configured
    ? 'Pusty układ — sama wyszukiwarka.' : 'Profil nieskonfigurowany — pasek zakładek.'));
  const engines = el('ul', {});
  config.engines.forEach(e => engines.append(el('li', {}, e.name + ': ' + e.url)));
  box.append(el('strong', {}, 'Wyszukiwarki'),
    config.engines.length ? engines : el('p', {}, 'Katalog wbudowany.'));
  if (conflict.kind !== 'settings') {
    box.append(el('a', {
      href: 'admin/api/' + spPath(editor) + '/startpage/' + conflict.kind,
      target: '_blank', rel: 'noopener',
    }, 'Otwórz bieżący obraz z serwera'));
  }
}

function spUpdate() {
  const editor = spEditor;
  const locked = spOpening || !!editor?.busy;
  for (const button of document.querySelectorAll('.sp-profile-open')) button.disabled = locked;
  $('#sp-close').disabled = locked;
  for (const id of ['#sp-settings-fields', '#sp-logo-fields', '#sp-background-fields'])
    $(id).disabled = locked || !editor;
  for (const id of ['#sp-compare', '#sp-rebase', '#sp-load-server'])
    $(id).disabled = locked || !editor?.conflict;
  if (!editor) return;
  if (editor.draft.blocks.length || editor.draft.engines.length || editor.draft.template !== 'classic')
    editor.draft.configured = true;
  const dirty = spSettingsDirty(editor);
  $('#sp-profile-name').textContent = editor.profileName;
  $('#sp-versions').textContent = 'Ustawienia: ' + editor.base.settingsVersion +
    ' · logo: ' + editor.assets.logo.base.logoVersion +
    ' · tło: ' + editor.assets.background.base.backgroundVersion;
  $('#sp-dirty').textContent = dirty ? 'Układ ma niezapisane zmiany.' :
    editor.base.configuration.configured ? 'Układ zapisany.' : 'Profil nie ma jeszcze zapisanego układu.';
  $('#sp-save-settings').disabled = locked || !!editor.conflict ||
    (!dirty && editor.base.configuration.configured);
  const full = editor.draft.blocks.length >= 64;
  $('#sp-add-section').disabled = locked || full;
  $('#sp-add-custom').disabled = locked || full;
  $('#sp-add-top').disabled = locked || full || editor.draft.blocks.some(b => b.type === 'top');
  $('#sp-add-engine').disabled = locked || editor.draft.engines.length >= 32;
  $('#sp-refresh-folders').disabled = locked || !!editor.conflict;
  for (const name of ['logo', 'background']) {
    const asset = editor.assets[name];
    $('#sp-save-' + name).disabled = locked || !!editor.conflict || asset.action === 'keep';
    $('#sp-cancel-' + name).disabled = locked || asset.action === 'keep';
    $('#sp-refresh-' + name).disabled = locked || !!editor.conflict;
  }
}

async function spRefreshAudit() {
  try {
    const latest = await api('state');
    if (state) state.audit = latest.audit;
    if (!$('#view-main').hidden) renderAudit();
  } catch { /* Zapis juz sie udal; blad odczytu dziennika nie zmienia jego wyniku. */ }
}

async function spWork(editor, kind, action) {
  if (!editor || spEditor !== editor || spOpening || editor.busy) return;
  editor.busy = true;
  spMessage('');
  spUpdate();
  try {
    await action();
    void spRefreshAudit();
  }
  catch (error) {
    if (spEditor !== editor) return;
    if (error instanceof SpHttpError && error.status === 409 &&
        error.data.error === 'STARTPAGE_CHANGED') {
      try {
        const current = spCheckSnapshot(error.data.current, editor.profileId);
        editor.conflict = { kind, current };
        spRenderConflict(editor);
      } catch (invalid) { spMessage(invalid.message); return; }
    }
    spMessage(error.message + ' Formularz i wybrany plik pozostają zachowane.');
  } finally {
    editor.busy = false;
    if (spEditor === editor) spUpdate();
  }
}

function spValidatedDocument(editor) {
  if (editor.foldersGeneration !== editor.base.generation)
    throw new Error('Odśwież foldery: lista pochodzi z innej generacji bazy.');
  const document = JSON.parse(JSON.stringify(editor.draft));
  spValidateBlocks(editor, document);
  for (const engine of document.engines) {
    engine.name = engine.name.trim();
    engine.url = engine.url.trim();
    if (!engine.name || engine.name.length > 100 ||
        !/^#[0-9a-f]{6}$/i.test(engine.color) ||
        !['google', 'none'].includes(engine.suggest))
      throw new Error('Sprawdź nazwę, kolor i podpowiedzi wyszukiwarki.');
    if ((engine.url.match(/%s/g) || []).length !== 1 ||
        engine.url.length > 2048 || /\s/.test(engine.url))
      throw new Error('Adres wyszukiwarki musi zawierać dokładnie jeden %s i nie może zawierać spacji.');
    let url, other;
    try {
      url = new URL(engine.url.replace('%s', 'FrogSync'));
      other = new URL(engine.url.replace('%s', 'AnotherQuery'));
    } catch { throw new Error('Niepoprawny adres wyszukiwarki.'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
        url.host !== other.host)
      throw new Error('Wymagany HTTPS bez hasła; %s musi być za nazwą hosta.');
  }
  return document;
}

$('#sp-settings-form').addEventListener('submit', event => {
  event.preventDefault();
  const editor = spEditor;
  if (!editor || editor.conflict) return;
  void spWork(editor, 'settings', async () => {
    const body = {
      generation: editor.base.generation,
      settingsVersion: editor.base.settingsVersion,
      configuration: spValidatedDocument(editor),
    };
    if (new TextEncoder().encode(JSON.stringify(body)).length > 64 * 1024)
      throw new Error('Konfiguracja przekracza 64 KB.');
    const saved = spCheckSnapshot(await spRequest(spPath(editor) + '/startpage',
      { method: 'PUT', body }), editor.profileId);
    editor.base = saved;
    editor.draft = spDocument(saved);
    spRenderSections(editor);
    spRenderEngines(editor);
    spMessage('Układ zapisany. Logo i tło zapisujesz osobno.', 'ok');
  });
});

$('#sp-add-section').addEventListener('click', () => spAddBlock('folder'));
$('#sp-add-custom').addEventListener('click', () => spAddBlock('custom'));
$('#sp-add-top').addEventListener('click', () => spAddBlock('top'));
$('#sp-template').addEventListener('change', event => {
  if (!spEditor) return;
  spEditor.draft.template = event.target.value;
  spEditor.draft.configured = true;
  spRenderTemplate(spEditor);
  spUpdate();
});

$('#sp-add-engine').addEventListener('click', () => {
  const editor = spEditor;
  if (!editor || editor.draft.engines.length >= 32) return;
  editor.draft.engines.push({
    id: 'custom-' + crypto.randomUUID(), name: '', url: '', color: '#2F9E5B', suggest: 'none',
  });
  spRenderEngines(editor);
  spUpdate();
});

$('#sp-builtins').addEventListener('click', () => {
  const editor = spEditor;
  if (!editor) return;
  if (editor.draft.engines.length &&
      !confirm('Zastąpić listę w formularzu katalogiem wbudowanym? Zmiana wymaga później zapisania.')) return;
  editor.draft.engines = SP_BUILTINS.map(engine => ({ ...engine }));
  spRenderEngines(editor);
  spUpdate();
});

$('#sp-refresh-folders').addEventListener('click', () => {
  const editor = spEditor;
  void spWork(editor, 'settings', async () => {
    const [current, folders] = await Promise.all([
      spRequest(spPath(editor) + '/startpage'), spRequest(spPath(editor) + '/folders'),
    ]);
    spCheckSnapshot(current, editor.profileId);
    if (current.generation !== folders.generation)
      throw new Error('Stan serwera zmienił się w trakcie odczytu. Spróbuj ponownie.');
    spSetFolders(editor, folders);
    if (current.generation !== editor.base.generation ||
        current.settingsVersion !== editor.base.settingsVersion)
      editor.conflict = { kind: 'settings', current };
    spRenderSections(editor);
    spRenderConflict(editor);
    spMessage(editor.conflict ? 'Formularz zachowany. Porównaj go z wersją serwera.' : 'Lista folderów odświeżona.', editor.conflict ? 'error' : 'ok');
  });
});

spWireAsset('logo');
spWireAsset('background');

$('#sp-compare').addEventListener('click', () => {
  const editor = spEditor;
  if (!editor?.conflict) return;
  const kind = editor.conflict.kind;
  void spWork(editor, kind, async () => {
    const current = spCheckSnapshot(
      await spRequest(spPath(editor) + '/startpage'), editor.profileId);
    editor.conflict = { kind, current };
    spRenderConflict(editor);
    spMessage('Pobrano wersję do porównania. Formularz i plik pozostały zachowane.', 'ok');
  });
});

async function spResolveConflict(loadServer) {
  const editor = spEditor;
  if (!editor?.conflict || editor.busy) return;
  const { kind, current } = editor.conflict;
  const question = loadServer
    ? 'Wczytać pokazaną wersję serwera i odrzucić lokalną zmianę w tej części? Pozostałe formularze pozostaną zachowane.'
    : 'Zachować formularz i użyć pokazanej wersji jako podstawy? Kolejny zapis zastąpi ją Twoimi danymi. Teraz nic nie zostanie wysłane.';
  if (!confirm(question)) return;
  await spWork(editor, kind, async () => {
    if (kind === 'settings') {
      const folders = await spRequest(spPath(editor) + '/folders');
      if (folders.generation !== current.generation)
        throw new Error('Generacja zmieniła się ponownie. Wybierz Porównaj ponownie.');
      spSetFolders(editor, folders);
      editor.base = current;
      if (loadServer) editor.draft = spDocument(current);
      spRenderSections(editor);
      spRenderEngines(editor);
    } else {
      const asset = editor.assets[kind];
      // Odczyt przed odrzuceniem pliku: awaria sieci zachowuje cala zmiane.
      const source = loadServer ? await spReadAsset(editor, kind, current) : null;
      asset.base = current;
      if (loadServer) {
        asset.read++;
        asset.serverPreview = source;
        asset.known = true;
        asset.message = '';
        spCancelAsset(editor, kind);
      } else {
        void spLoadAsset(editor, kind);
      }
    }
    editor.conflict = null;
    spRenderConflict(editor);
    spMessage(loadServer ? 'Wczytano pokazaną wersję serwera.' :
      'Zmiany zachowane. Aby je wysłać, kliknij odpowiedni przycisk zapisu.', 'ok');
  });
}

$('#sp-rebase').addEventListener('click', () => { void spResolveConflict(false); });
$('#sp-load-server').addEventListener('click', () => { void spResolveConflict(true); });

$('#sp-close').addEventListener('click', () => {
  if (spCanLeave()) spClear();
});

window.addEventListener('beforeunload', event => {
  if (spHasDraft() || spEditor?.busy) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function applyThemeButtons() {
  const current = document.documentElement.dataset.theme || 'auto';
  for (const b of document.querySelectorAll('[data-theme-choice]'))
    b.setAttribute('aria-checked', String(b.dataset.themeChoice === current));
}

for (const button of document.querySelectorAll('[data-theme-choice]')) {
  button.addEventListener('click', () => {
    const choice = button.dataset.themeChoice;
    if (choice === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
    try {
      if (choice === 'auto') localStorage.removeItem('frogsync-theme');
      else localStorage.setItem('frogsync-theme', choice);
    } catch (e) { /* tryb prywatny */ }
    applyThemeButtons();
  });
}

applyThemeButtons();
guarded(boot);

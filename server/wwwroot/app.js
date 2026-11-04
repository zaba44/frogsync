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

$('#logout').addEventListener('click', () => guarded(async () => { await api('logout', {}); show('login'); }));

// ============================================================
// Panel
// ============================================================

async function refresh() {
  state = await api('state');
  renderProfiles();
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
      el('td', { class: 'muted' }, d.browser || '—'),
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

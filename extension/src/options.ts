import { wx, isGecko } from './wx.js';
import { BUILTIN_RULES, type FilterConfig } from './filters.js';
import { parseBookmarkHtml, type BookmarkHtmlSource } from './bookmark-html.js';
import { isOpera } from './opera-newtab.js';
import { BUILTIN_ENGINES, DEFAULT_ENGINE, GOOGLE_SUGGEST_ORIGIN, MAX_PINNED, engineById, normalizePinned } from './core/search.js';
import type { RestorePlan, RestoreTree } from './core/restore.js';
import type { RestorePointSummary, RestoreReason } from './restore-points.js';
import type { Message, ServerSession, Settings, SyncStatus } from './types.js';

const $ = (id: string) => document.getElementById(id)!;

async function send<T>(message: Message): Promise<T> {
  const reply: unknown = await wx.runtime.sendMessage(message);
  if (reply && typeof reply === 'object' && 'error' in reply && typeof reply.error === 'string') {
    throw new Error(reply.error);
  }
  return reply as T;
}

const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);

function show(text: string, kind: 'error' | 'ok' | 'info' = 'error'): void {
  const box = $('message');
  box.replaceChildren();
  if (!text) return;
  const div = document.createElement('div');
  div.className = `banner ${kind === 'ok' ? 'info' : kind === 'error' ? 'error' : 'warn'}`;
  const p = document.createElement('p');
  p.textContent = text;
  div.append(p);
  box.append(div);
}

function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  return url.replace(/\/+$/, '');
}

async function probe(url: string): Promise<string | null> {
  try {
    const r = await fetch(url + '/healthz', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (r.status === 403) return 'Serwer odrzucił połączenie z tego adresu. Sprawdź sieć lokalną lub VPN.';
    if (!r.ok) return `Pod tym adresem odpowiada coś innego niż FrogSync (HTTP ${r.status}).`;
    return null;
  } catch {
    return 'Nie mogę połączyć się z serwerem. Sprawdź adres, sieć domową lub VPN. ' +
      `Jeśli ${url} otwiera się w przeglądarce, sprawdź, czy przeglądarka ufa certyfikatowi serwera.`;
  }
}

let preview: { url: string; code: string; hasContent: boolean } | null = null;

function resetPreview(): void {
  preview = null;
  $('mode-choice').hidden = true;
  $('pair-button').textContent = 'Dalej';
}

$('server-url').addEventListener('input', resetPreview);
$('pair-code').addEventListener('input', resetPreview);

function explainPairError(error: string): string {
  if (/PROFILE_CHANGED/.test(error)) return 'Zawartość profilu się zmieniła. Ponownie sprawdź kod i wybierz tryb.';
  if (/INVALID_CODE|bledny|wygasl/i.test(error)) return 'Kod jest błędny lub wygasł. Wygeneruj nowy w panelu.';
  if (/LOCKED|Zbyt wiele/i.test(error)) return 'Zbyt wiele prób. Odczekaj kilka minut i spróbuj ponownie.';
  return error;
}

$('pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('pair-button') as HTMLButtonElement;
  const url = normalizeUrl(($('server-url') as HTMLInputElement).value);
  const code = ($('pair-code') as HTMLInputElement).value.replace(/\D/g, '');
  if (code.length !== 6) { show('Kod parowania ma sześć cyfr.'); return; }

  button.disabled = true;
  try {
    if (!preview || preview.url !== url || preview.code !== code) {
      // Firefox nie dopasowuje wzorca z portem (https://host:18443/*) do zapytan, choc go przyjmuje
      // i pokazuje jako nadany — prosimy wiec o host bez portu, ktory obejmuje kazdy port
      const target = new URL(url);
      const origin = isGecko() ? `${target.protocol}//${target.hostname}/*` : `${target.origin}/*`;
      const granted = await wx.permissions.request({ origins: [origin] });
      if (!granted) { show('Kliknij „Dalej” i zezwól dodatkowi na połączenie z serwerem.'); return; }

      const problem = await probe(url);
      if (problem) { show(problem); return; }

      show('Sprawdzam kod…', 'info');
      const result = await send<{ hasContent: boolean; bookmarks: number; profileName: string }>({
        type: 'PREVIEW', url, code,
      });
      preview = { url, code, hasContent: result.hasContent };
      if (result.hasContent) {
        $('mode-intro').textContent = `Profil „${result.profileName}” zawiera ${result.bookmarks} zakładek. Co zrobić z zakładkami tej przeglądarki?`;
        $('mode-choice').hidden = false;
        button.textContent = 'Połącz';
        show('');
        return;
      }
    }

    const mode = !preview.hasContent ||
      document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value === 'merge'
      ? 'merge' : 'replace';

    show('Łączę i synchronizuję…', 'info');
    const status = await send<SyncStatus>({ type: 'PAIR', url, code, mode, expectContent: preview.hasContent });
    resetPreview();
    if (status.connection !== 'ok' || status.lastError) {
      show(status.lastError ?? 'Pierwsza synchronizacja nie została zakończona.');
    } else {
      show(mode === 'replace'
        ? 'Połączono. Wcześniejsze niedopasowane zakładki znajdziesz w „Inne zakładki → Zakładki sprzed FrogSync”.'
        : 'Połączono i zakończono pierwszą synchronizację.', 'ok');
    }
    await refresh();
    await refreshPoints();
  } catch (err) {
    const message = errorText(err);
    if (/PROFILE_CHANGED/.test(message)) resetPreview();
    show(explainPairError(message));
  } finally {
    button.disabled = false;
  }
});

$('unpair').addEventListener('click', async () => {
  if (!confirm('Rozłączyć tę przeglądarkę od serwera?\n\nZakładki zostaną w przeglądarce i na serwerze.')) return;
  try {
    await send({ type: 'UNPAIR' });
    await refresh();
    show('Rozłączono.', 'ok');
  } catch (err) {
    show(errorText(err));
  }
});

$('sync-now').addEventListener('click', async () => {
  try {
    const status = await send<SyncStatus>({ type: 'SYNC_NOW' });
    const ok = status.connection === 'ok' && !status.lastError;
    show(ok ? 'Zsynchronizowano.' : status.lastError ?? 'Synchronizacja nie została zakończona.', ok ? 'ok' : 'error');
    await refreshPoints();
  } catch (err) {
    show(errorText(err));
  }
});

// ============================================================
// Przywracanie i punkty
// ============================================================

type RestorePreview = { summaryId: string; counts: RestorePlan['counts'] };
type RestoreChoice =
  | { kind: 'file'; tree: RestoreTree; label: string }
  | { kind: 'point'; id: string; label: string };

const REASON: Record<RestoreReason, string> = {
  migration: 'Aktualizacja wtyczki',
  reset: 'Odtworzenie kopii serwera',
  bootstrap: 'Pierwsza synchronizacja',
  html: 'Przywrócenie z eksportu',
  undo: 'Cofnięcie do punktu',
  'remote-delete': 'Masowe usunięcie z innej przeglądarki',
  'local-delete': 'Wysłanie masowego usunięcia',
};

const dialog = $('restore-dialog') as HTMLDialogElement;
const restoreFile = $('restore-file') as HTMLInputElement;
const restoreSource = $('restore-source') as HTMLSelectElement;
const restoreConfirm = $('restore-confirm') as HTMLButtonElement;
const restoreResume = $('restore-resume') as HTMLButtonElement;
let restoreBusy = false;
let pendingRestore: { choice: RestoreChoice; summaryId: string } | null = null;

function restoreMessage(message: string): void {
  $('restore-message').textContent = message;
}

function setRestoreBusy(busy: boolean): void {
  restoreBusy = busy;
  for (const id of ['restore-file', 'restore-source', 'restore-preview', 'restore-confirm', 'restore-resume']) {
    ($(id) as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled = busy;
  }
  for (const button of $('restore-points').querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = busy;
  }
}

function dateLabel(at: number): string {
  return new Date(at).toLocaleString('pl-PL');
}

async function previewChoice(choice: RestoreChoice): Promise<void> {
  const result = choice.kind === 'file'
    ? await send<RestorePreview>({ type: 'PREVIEW_RESTORE', tree: choice.tree })
    : await send<RestorePreview>({ type: 'PREVIEW_UNDO', id: choice.id });

  const { remove, move, update, create } = result.counts;
  if (remove + move + update + create === 0) {
    restoreMessage('Zakładki są już zgodne z wybraną kopią.');
    return;
  }

  pendingRestore = { choice, summaryId: result.summaryId };
  $('restore-summary').textContent = `Usunę ${remove}, przestawię ${move}, zmienię ${update}, dodam ${create}.`;
  $('restore-origin').textContent = choice.label;
  ($('restore-details') as HTMLDetailsElement).open = false;
  dialog.showModal();
}

$('restore-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (restoreBusy || dialog.open) return;
  const file = restoreFile.files?.[0];
  if (!file) return;

  setRestoreBusy(true);
  restoreMessage('Czytam plik i przygotowuję podsumowanie…');
  try {
    const source = restoreSource.value as BookmarkHtmlSource;
    const tree = parseBookmarkHtml(await file.text(), source);
    restoreMessage('');
    await previewChoice({ kind: 'file', tree, label: `Plik: ${file.name}` });
  } catch (err) {
    restoreMessage(errorText(err));
  } finally {
    setRestoreBusy(false);
  }
});

$('restore-cancel').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { pendingRestore = null; });

function reportRestoreStatus(status: SyncStatus): boolean {
  if (status.lastError || (status.connection !== 'ok' && status.connection !== 'unpaired')) {
    restoreResume.hidden = false;
    restoreMessage((status.lastError ?? 'Przywracanie lub synchronizacja nie zostały zakończone.') +
      ' Sprawdź komunikat, a potem użyj przycisku wznowienia.');
    return false;
  }
  if (status.pendingOps || status.blockedDeletions || status.blockedLocalDeletions) {
    restoreResume.hidden = false;
    restoreMessage('Zakładki zmieniono lokalnie. Synchronizacja ma jeszcze zaległości lub oczekuje na decyzję w popupie.');
    return false;
  }
  restoreResume.hidden = true;
  restoreMessage(status.connection === 'unpaired'
    ? 'Przywrócono zakładki w tej przeglądarce.'
    : 'Zakończono przywracanie. Inne przeglądarki pobiorą zmiany podczas synchronizacji.');
  return true;
}

restoreConfirm.addEventListener('click', async () => {
  if (!pendingRestore || restoreBusy) return;
  const { choice, summaryId } = pendingRestore;
  dialog.close();
  setRestoreBusy(true);
  restoreMessage('Przywracam zakładki…');
  try {
    const status = choice.kind === 'file'
      ? await send<SyncStatus>({ type: 'RUN_RESTORE', tree: choice.tree, summaryId })
      : await send<SyncStatus>({ type: 'UNDO_TO_POINT', id: choice.id, summaryId });
    if (reportRestoreStatus(status) && choice.kind === 'file') restoreFile.value = '';
  } catch (err) {
    restoreMessage(errorText(err));
    restoreResume.hidden = false;
  } finally {
    try { await refreshPoints(); } finally { setRestoreBusy(false); }
  }
});

restoreResume.addEventListener('click', async () => {
  if (restoreBusy) return;
  setRestoreBusy(true);
  try {
    reportRestoreStatus(await send<SyncStatus>({ type: 'SYNC_NOW' }));
  } catch (err) {
    restoreMessage(errorText(err));
  } finally {
    try { await refreshPoints(); } finally { setRestoreBusy(false); }
  }
});

async function exportPoint(point: RestorePointSummary): Promise<void> {
  const { html } = await send<{ html: string }>({ type: 'EXPORT_POINT_HTML', id: point.id });
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `frogsync-zakladki-${new Date(point.at).toISOString().replace(/[:.]/g, '-')}.html`;
  document.body.append(link);
  try { link.click(); } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

async function refreshPoints(): Promise<void> {
  const list = $('restore-points');
  try {
    const points = await send<RestorePointSummary[]>({ type: 'LIST_RESTORE_POINTS' });
    list.replaceChildren();
    if (!points.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = 'Nie ma jeszcze punktów przywracania.';
      list.append(empty);
    }

    for (const point of points) {
      const row = document.createElement('div');
      row.className = 'list-item';
      const caption = document.createElement('div');
      const reason = document.createElement('strong');
      reason.textContent = REASON[point.reason];
      const time = document.createElement('div');
      time.className = 'muted';
      time.textContent = dateLabel(point.at);
      caption.append(reason, time);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.textContent = 'Cofnij do tego stanu';
      const download = document.createElement('button');
      download.type = 'button';
      download.textContent = 'Pobierz HTML';
      undo.disabled = download.disabled = restoreBusy;

      undo.addEventListener('click', async () => {
        if (restoreBusy || dialog.open) return;
        setRestoreBusy(true);
        restoreMessage('Przygotowuję podsumowanie…');
        try {
          restoreMessage('');
          await previewChoice({
            kind: 'point', id: point.id, label: `${REASON[point.reason]} — ${dateLabel(point.at)}`,
          });
        } catch (err) {
          restoreMessage(errorText(err));
        } finally {
          setRestoreBusy(false);
        }
      });

      download.addEventListener('click', async () => {
        download.disabled = true;
        try { await exportPoint(point); }
        catch (err) { restoreMessage(errorText(err)); }
        finally { download.disabled = restoreBusy; }
      });

      actions.append(undo, download);
      row.append(caption, actions);
      list.append(row);
    }
  } catch (err) {
    list.textContent = `Nie można odczytać punktów przywracania: ${errorText(err)}`;
  }
}

// ============================================================
// Ustawienia i filtry
// ============================================================

let filters: FilterConfig;

async function saveFilters(config: FilterConfig): Promise<void> {
  try {
    filters = await send<FilterConfig>({ type: 'SAVE_FILTERS', config });
  } catch (err) {
    show(errorText(err));
  }
  renderFilters();
}

function renderFilters(): void {
  const box = $('builtin-rules');
  box.replaceChildren();
  for (const rule of BUILTIN_RULES) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = filters.builtinEnabled[rule.id] !== false;
    input.addEventListener('change', () => void saveFilters({
      ...filters, builtinEnabled: { ...filters.builtinEnabled, [rule.id]: input.checked },
    }));
    const text = document.createElement('span');
    text.textContent = `${rule.label} `;
    const source = document.createElement('span');
    source.className = 'desc';
    source.textContent = rule.source;
    text.append(source);
    label.append(input, text);
    box.append(label);
  }

  const list = $('manual-list');
  list.replaceChildren();
  if (filters.manualExclusions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = 'Brak własnych wykluczeń';
    list.append(empty);
  }
  for (const exclusion of filters.manualExclusions) {
    const row = document.createElement('div');
    row.className = 'list-item';
    const value = document.createElement('span');
    value.className = 'mono';
    value.textContent = exclusion.value;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'linkish';
    remove.textContent = 'usuń';
    remove.addEventListener('click', () => void saveFilters({
      ...filters, manualExclusions: filters.manualExclusions.filter(x => x.id !== exclusion.id),
    }));
    row.append(value, remove);
    list.append(row);
  }
}

$('manual-add').addEventListener('click', async () => {
  const input = $('manual-value') as HTMLInputElement;
  const value = input.value.trim();
  if (!value || !filters) return;
  const id = crypto.randomUUID();
  await saveFilters({
    ...filters,
    manualExclusions: [...filters.manualExclusions, {
      id, type: value.includes('*') ? 'urlPattern' : 'url', value, label: value,
    }],
  });
  if (filters.manualExclusions.some(entry => entry.id === id)) input.value = '';
});

async function refresh(): Promise<void> {
  const data = await send<{ status: SyncStatus; server: ServerSession | null }>({ type: 'GET_STATUS' });
  $('pair-card').hidden = !!data.server;
  $('paired-card').hidden = !data.server;
  if (data.server) {
    $('paired-url').textContent = data.server.url;
    $('paired-profile').textContent = data.server.profile.name;
    $('paired-device').textContent = data.server.deviceName;
  }
}

// ============================================================
// Strona startowa
// ============================================================

let startSettings: Settings;

async function saveStart(patch: Partial<Settings>): Promise<void> {
  startSettings = { ...startSettings, ...patch };
  try { await send({ type: 'SAVE_SETTINGS', settings: patch }); }
  catch (err) { show(errorText(err)); }
}

function renderEngineList(): void {
  const list = $('engine-list');
  list.replaceChildren();
  const pinned = normalizePinned(startSettings.pinnedEngines);
  $('pin-count').textContent = String(pinned.length);
  $('pin-max').textContent = String(MAX_PINNED);

  // Przypiete najpierw, w swojej kolejnosci; reszta katalogu pod nimi
  const ordered = [...pinned, ...BUILTIN_ENGINES.map(e => e.id).filter(id => !pinned.includes(id))];
  for (const id of ordered) {
    const engine = engineById(id)!;
    const isPinned = pinned.includes(id);
    const row = document.createElement('div');
    row.className = 'list-item engine-row';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = isPinned;
    box.disabled = !isPinned && pinned.length >= MAX_PINNED;
    box.title = box.disabled ? `Przypięto już ${MAX_PINNED} — odepnij inną wyszukiwarkę` : '';
    box.addEventListener('change', () => {
      const next = box.checked ? [...pinned, id] : pinned.filter(x => x !== id);
      void saveStart({ pinnedEngines: normalizePinned(next) }).then(renderEngineList);
    });

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = engine.color;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = engine.name;
    row.append(box, swatch, name);

    if (isPinned) {
      const at = pinned.indexOf(id);
      const move = (step: number) => {
        const next = [...pinned];
        [next[at], next[at + step]] = [next[at + step], next[at]];
        void saveStart({ pinnedEngines: next }).then(renderEngineList);
      };
      for (const [label, step, aria] of [['▲', -1, 'Wyżej'], ['▼', 1, 'Niżej']] as const) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'linkish';
        b.textContent = label;
        b.setAttribute('aria-label', `${aria}: ${engine.name}`);
        b.disabled = at + step < 0 || at + step >= pinned.length;
        b.addEventListener('click', () => move(step));
        row.append(b);
      }
    }
    list.append(row);
  }
}

function initStartPage(settings: Settings): void {
  startSettings = settings;

  const startPage = $('start-page') as HTMLInputElement;
  startPage.checked = settings.startPage;
  startPage.addEventListener('change', () => void saveStart({ startPage: startPage.checked }));

  // Opera: przelacznik tylko tam, z opcjonalna zgoda "tabs"
  const operaBox = $('opera-box') as HTMLElement;
  operaBox.hidden = !isOpera();
  const opera = $('opera-newtab') as HTMLInputElement;
  opera.checked = settings.operaNewTab;
  opera.addEventListener('change', async () => {
    if (opera.checked) {
      // Zgoda musi wyjsc z klikniecia — inaczej przegladarka odrzuci prosbe bez okna
      const granted = await wx.permissions.request({ permissions: ['tabs'] });
      if (!granted) { opera.checked = false; show('Bez zgody na odczyt kart FrogSync nie rozpozna nowej karty Opery.'); return; }
      await saveStart({ operaNewTab: true });
    } else {
      await saveStart({ operaNewTab: false });
      try { await wx.permissions.remove({ permissions: ['tabs'] }); } catch { /* zgody moglo juz nie byc */ }
    }
  });

  const startUrl = $('start-url') as HTMLInputElement;
  startUrl.value = wx.runtime.getURL('newtab.html?view=start');
  $('copy-start-url').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(startUrl.value); show('Adres skopiowany. Wklej go w ustawieniach przeglądarki jako stronę startową.', 'ok'); }
    catch { startUrl.select(); show('Zaznaczyłem adres — skopiuj go klawiszami Ctrl+C.', 'info'); }
  });

  const select = $('default-engine') as HTMLSelectElement;
  for (const e of BUILTIN_ENGINES) select.append(new Option(e.name, e.id));
  select.value = engineById(settings.defaultEngine) ? settings.defaultEngine : DEFAULT_ENGINE;
  select.addEventListener('change', () => void saveStart({ defaultEngine: select.value }));

  const enterAddress = $('enter-address') as HTMLInputElement;
  enterAddress.checked = settings.enterOpensAddress;
  enterAddress.addEventListener('change', () => void saveStart({ enterOpensAddress: enterAddress.checked }));

  const marks = $('search-bookmarks') as HTMLInputElement;
  marks.checked = settings.searchBookmarks;
  marks.addEventListener('change', () => void saveStart({ searchBookmarks: marks.checked }));

  const google = $('google-suggest') as HTMLInputElement;
  google.checked = settings.googleSuggest;
  google.addEventListener('change', async () => {
    if (google.checked) {
      const granted = await wx.permissions.request({ origins: [GOOGLE_SUGGEST_ORIGIN] });
      if (!granted) { google.checked = false; show('Bez zgody na połączenie z Google podpowiedzi nie zadziałają.'); return; }
      await saveStart({ googleSuggest: true });
    } else {
      await saveStart({ googleSuggest: false });
      try { await wx.permissions.remove({ origins: [GOOGLE_SUGGEST_ORIGIN] }); } catch { /* juz cofnieta */ }
    }
  });

  renderEngineList();
}

async function init(): Promise<void> {
  $('version').textContent = `wersja ${wx.runtime.getManifest().version}`;
  await refreshPoints();
  const settings = await send<Settings>({ type: 'GET_SETTINGS' });
  const auto = $('auto-sync') as HTMLInputElement;
  const poll = $('poll') as HTMLInputElement;
  auto.checked = settings.autoSync;
  poll.value = String(settings.pollMinutes);
  initStartPage(settings);

  auto.addEventListener('change', () => {
    void send({ type: 'SAVE_SETTINGS', settings: { autoSync: auto.checked } })
      .catch(err => show(errorText(err)));
  });
  poll.addEventListener('change', () => {
    const value = Math.max(1, Math.min(60, Math.round(Number(poll.value) || 1)));
    poll.value = String(value);
    void send({ type: 'SAVE_SETTINGS', settings: { pollMinutes: value } })
      .catch(err => show(errorText(err)));
  });

  filters = await send<FilterConfig>({ type: 'GET_FILTERS' });
  renderFilters();
  await refresh();
}

void init().catch(err => show(errorText(err)));

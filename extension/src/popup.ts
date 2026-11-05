import { wx } from './wx.js';
import { UPDATE_URL } from './extension-version.js';
import { conflictId } from './conflict-id.js';
import type { ConflictNote, ConnectionState, Message, ServerSession, SyncStatus } from './types.js';

// Popup tylko pokazuje stan i zleca — cala praca dzieje sie w tle.

const $ = (id: string) => document.getElementById(id)!;
const send = async <T>(m: Message) => await wx.runtime.sendMessage(m) as T;

const TEXT: Record<ConnectionState, [string, string, string]> = {
  ok:              ['Zsynchronizowane', '', 'ok'],
  outdated:        ['Wymagana aktualizacja', 'Serwer wymaga nowszej wersji wtyczki — zaktualizuj FrogSync. Twoje zakładki i oczekujące zmiany pozostają zachowane.', 'error'],
  error:           ['Synchronizacja nieudana', 'Sprawdź komunikat i spróbuj ponownie.', 'error'],
  unpaired:        ['Nie połączono z serwerem', 'Otwórz Ustawienia i wpisz adres serwera oraz kod parowania z panelu FrogSync.', 'idle'],
  offline:         ['Serwer nie odpowiada', 'Zmiany czekają w przeglądarce i wyjdą same, gdy serwer wróci. Sprawdź połączenie lub VPN.', 'error'],
  cert:            ['Przeglądarka nie ufa certyfikatowi serwera', 'Zainstaluj certyfikat swojego CA w systemie albo w przeglądarce.', 'error'],
  revoked:         ['Dostęp odwołany', 'To urządzenie zostało odłączone w panelu. W Ustawieniach połącz się nowym kodem parowania.', 'error'],
  'no-permission': ['Brak zgody na połączenie', 'W Ustawieniach kliknij „Połącz” jeszcze raz i zezwól przeglądarce na dostęp do serwera.', 'attention'],
};

function when(ms?: number): string {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'przed chwilą';
  if (s < 3600) return `${Math.floor(s / 60)} min temu`;
  return new Date(ms).toLocaleString('pl-PL');
}

function render(status: SyncStatus, server: ServerSession | null, conflicts: ConflictNote[]): void {
  const connection = status.connection === 'ok' && status.lastError ? 'error' : status.connection;
  const [text, hint, dot] = TEXT[connection] ?? [connection, '', 'idle'];
  $('state-text').textContent = text;
  const failures = status.consecutiveFailures ?? 0;
  $('state-hint').textContent = connection === 'error' && status.lastError
    ? status.lastError + (failures > 1 ? ` Nieudane próby z rzędu: ${failures}.` : '')
    : hint;
  $('dot').className = `dot ${dot}`;
  $('profile').textContent = [server ? `Profil: ${server.profile.name}` : '', `Wersja ${wx.runtime.getManifest().version}`]
    .filter(Boolean).join(' · ');

  $('local-count').textContent = String(status.localCount ?? 0);
  $('last-sync').textContent = when(status.lastSyncAt);
  $('pending').textContent = String(status.pendingOps ?? 0);

  const banners = $('banners');
  banners.replaceChildren();
  if (server && (status.connection === 'outdated' || status.updateAvailable)) {
    const box = document.createElement('div');
    box.className = status.connection === 'outdated' ? 'banner error' : 'hint';
    const text = document.createElement('span');
    text.textContent = status.connection === 'outdated'
      ? `Wymagana wersja: ${status.minExtensionVersion || 'zgodna z serwerem'}. `
      : `Dostępna nowa wersja${status.latestExtensionVersion ? ': ' + status.latestExtensionVersion : ''}. `;
    const link = document.createElement('a');
    link.href = UPDATE_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Pobierz aktualizację';
    box.append(text, link);
    banners.append(box);
  }
  const brakeBanner = (count: number, which: 'remote' | 'local', headline: string, detail: string, action: string) => {
    const box = document.createElement('div');
    box.className = 'banner warn';
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = headline;
    p.append(strong);
    const p2 = document.createElement('p');
    p2.className = 'muted';
    p2.textContent = detail;
    const button = document.createElement('button');
    button.className = 'danger';
    button.textContent = action;
    button.addEventListener('click', async () => { button.disabled = true; await send<SyncStatus>({ type: 'CONFIRM_DELETIONS', which }); await refresh(); });
    box.append(p, p2, button);
    banners.append(box);
  };
  if (status.blockedDeletions) {
    brakeBanner(status.blockedDeletions, 'remote',
      `Wstrzymano usunięcie ${status.blockedDeletions} zakładek.`,
      'Inna przeglądarka usunęła dużą część kolekcji. Nowe i zmienione zakładki już przyszły — usunięcia czekają na Twoją decyzję.',
      `Usuń te ${status.blockedDeletions} zakładek tutaj`);
  }
  if (status.blockedLocalDeletions) {
    brakeBanner(status.blockedLocalDeletions, 'local',
      `Usunięto tu ${status.blockedLocalDeletions} zakładek naraz.`,
      'Zanim to usunięcie trafi do pozostałych przeglądarek, potwierdź, że było zamierzone. Pozostałe zmiany synchronizują się normalnie.',
      `Usuń je też na innych komputerach`);
  }

  const card = $('conflicts-card') as HTMLElement;
  card.hidden = conflicts.length === 0;
  const list = $('conflicts');
  list.replaceChildren();
  for (const c of conflicts.slice(-5).reverse()) {
    const row = document.createElement('div');
    row.className = 'list-item';
    const body = document.createElement('div');
    const title = document.createElement('div');
    title.textContent = c.title;
    const outcome = document.createElement('div');
    outcome.className = 'muted';
    outcome.textContent = c.outcome;
    body.append(title, outcome);

    const canRestore = c.rejectedContent || c.rejectedPlacement || c.rejectedDeletion;
    if (canRestore && !c.restoredAt) {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = 'Przywróć moją wersję';
      restore.addEventListener('click', async () => {
        if (c.rejectedDeletion && !confirm('Ponowić zapisane usunięcie? Serwer ponownie sprawdzi konflikty.')) return;
        restore.disabled = true;
        try {
          const reply = await send<SyncStatus & { error?: string }>({
            type: 'RESTORE_CONFLICT', id: conflictId(c),
          });
          if (reply.error) throw new Error(reply.error);
          await refresh();
        } catch (err) {
          outcome.textContent = err instanceof Error ? err.message : String(err);
          restore.disabled = false;
        }
      });
      body.append(restore);
    } else if (c.restoredAt) {
      const restored = document.createElement('div');
      restored.className = 'muted';
      restored.textContent = 'Zapisano operację odzyskania.';
      body.append(restored);
    }
    if (c.restorePointId) {
      const point = document.createElement('div');
      point.className = 'muted';
      point.textContent = 'Kopię znajdziesz w Ustawieniach → Punkty przywracania.';
      body.append(point);
    }

    row.append(body);
    list.append(row);
  }
}

async function refresh(_?: unknown): Promise<void> {
  const data = await send<{ status: SyncStatus; server: ServerSession | null; conflicts: ConflictNote[] }>({ type: 'GET_STATUS' });
  render(data.status, data.server, data.conflicts);
}

$('sync-now').addEventListener('click', async (e) => {
  const button = e.currentTarget as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'Synchronizuję…';
  try { await send({ type: 'SYNC_NOW' }); await refresh(); }
  finally { button.disabled = false; button.textContent = 'Synchronizuj teraz'; }
});

$('open-options').addEventListener('click', () => void wx.runtime.openOptionsPage());
$('open-start').addEventListener('click', () => { void wx.tabs.create({ url: wx.runtime.getURL('newtab.html') }); window.close(); });
$('clear-conflicts').addEventListener('click', async () => { await send({ type: 'CLEAR_CONFLICTS' }); await refresh(); });

void refresh();

import { wx } from './wx.js';
import { getLocal, setLocal, KEYS } from './storage.js';
import { isHeld, APPLY_LOCK } from './locks.js';
import * as api from './api.js';
import {
  syncOnce, loadStatus, pairWith, unpair, confirmDeletions, conflictNotes, clearConflicts,
  previewRestore, runRestore, listRestorePoints, previewUndo, undoToPoint, exportPointHtml,
  restoreConflict,
} from './engine.js';
import { loadFilterConfig, saveFilterConfig, type FilterConfig } from './filters.js';
import { detectBrowser } from './identity.js';
import { registerOperaNewTab } from './opera-newtab.js';
import { DEFAULT_SETTINGS, type Message, type Settings, type SyncStatus } from './types.js';

// Alarm wznawia zapisane zadania po restarcie workera. Zdarzenia zakladek
// tylko przyspieszaja odczyt drzewa, nie stanowia dziennika synchronizacji.

registerOperaNewTab();

const SYNC_ALARM = 'frogsync-sync';
const DEBOUNCE_MS = 3000;
let debounce: ReturnType<typeof setTimeout> | null = null;

async function settings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await getLocal<Partial<Settings>>(KEYS.settings, {})) };
}

async function ensureAlarm(): Promise<void> {
  const s = await settings();
  const period = Math.max(1, Math.min(60, s.pollMinutes));
  const existing = await wx.alarms.get(SYNC_ALARM);
  if (!s.autoSync) { await wx.alarms.clear(SYNC_ALARM); return; }
  if (!existing || existing.periodInMinutes !== period) {
    await wx.alarms.clear(SYNC_ALARM);
    wx.alarms.create(SYNC_ALARM, { delayInMinutes: 0.1, periodInMinutes: period });
  }
}

async function withBadge(status: SyncStatus): Promise<SyncStatus> {
  await paintBadge(status);
  return status;
}

async function run(): Promise<SyncStatus> {
  return withBadge(await syncOnce());
}

async function paintBadge(status: SyncStatus): Promise<void> {
  try {
    const error = status.connection === 'error' || status.connection === 'outdated' || !!status.lastError;
    const blocked = !!(status.blockedDeletions || status.blockedLocalDeletions);
    const attention = error ? '×' : blocked ? '!' :
      status.connection === 'offline' || status.connection === 'cert' ? '×' :
      status.connection === 'revoked' || status.connection === 'unpaired' ? '?' :
      status.pendingOps > 0 ? '…' : '';

    await wx.action.setBadgeText({ text: attention });
    await wx.action.setBadgeBackgroundColor({
      color: error || blocked || status.connection !== 'ok' ? '#c8372d' : '#2f9e5b',
    });

    const titles: Record<SyncStatus['connection'], string> = {
      outdated: 'FrogSync — wymagana aktualizacja wtyczki',
      ok: 'FrogSync — zsynchronizowane',
      offline: 'FrogSync — serwer nie odpowiada',
      cert: 'FrogSync — przeglądarka nie ufa certyfikatowi serwera',
      revoked: 'FrogSync — dostęp odwołany w panelu',
      unpaired: 'FrogSync — niesparowane',
      'no-permission': 'FrogSync — brak zgody na połączenie',
      error: 'FrogSync — synchronizacja nieudana',
    };
    await wx.action.setTitle({
      title: error && status.lastError ? `FrogSync — ${status.lastError}` :
        blocked ? 'FrogSync — wstrzymano usunięcia, potwierdź w oknie dodatku' :
        titles[status.connection],
    });
  } catch { /* ikona nie moze zatrzymac synchronizacji */ }
}

function scheduleSoon(): void {
  void (async () => {
    if (await isHeld(APPLY_LOCK)) return;
    await setLocal({ [KEYS.pending]: Date.now() });
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; void run(); }, DEBOUNCE_MS);
  })();
}

wx.bookmarks.onCreated.addListener(scheduleSoon);
wx.bookmarks.onRemoved.addListener(scheduleSoon);
wx.bookmarks.onChanged.addListener(scheduleSoon);
wx.bookmarks.onMoved.addListener(scheduleSoon);
wx.bookmarks.onChildrenReordered?.addListener(scheduleSoon);
wx.bookmarks.onImportEnded?.addListener(scheduleSoon);
wx.alarms.onAlarm.addListener(alarm => { if (alarm.name === SYNC_ALARM) void run(); });

wx.runtime.onInstalled.addListener(() => { void (async () => {
  await ensureAlarm();
  const status = await loadStatus();
  await paintBadge(status);
  if (status.connection === 'unpaired' && !(await getLocal(KEYS.server, null))) {
    try { await wx.runtime.openOptionsPage(); } catch { /* bez znaczenia */ }
  }
})(); });

wx.runtime.onStartup.addListener(() => { void (async () => { await ensureAlarm(); await run(); })(); });
void (async () => { await ensureAlarm(); await paintBadge(await loadStatus()); })();

wx.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  void (async () => {
    try { sendResponse(await handle(raw as Message)); }
    catch (err) { sendResponse({ error: err instanceof Error ? err.message : String(err) }); }
  })();
  return true;
});

async function handle(message: Message): Promise<unknown> {
  switch (message.type) {
    case 'GET_STATUS':
      return {
        status: await loadStatus(),
        server: await getLocal(KEYS.server, null),
        conflicts: await conflictNotes(),
      };

    case 'SYNC_NOW':
      return run();

    case 'PREVIEW':
      return api.preview(message.url, message.code);

    case 'PAIR': {
      const browser = await detectBrowser();
      return withBadge(await pairWith(message.url, message.code, `${browser.name} ${browser.version.split('.')[0]}`.trim(),
        message.mode, message.expectContent));
    }

    case 'UNPAIR':
      await unpair();
      return withBadge(await loadStatus());

    case 'CONFIRM_DELETIONS':
      return withBadge(await confirmDeletions(message.which));

    case 'CLEAR_CONFLICTS':
      return clearConflicts();

    case 'RESTORE_CONFLICT':
      return withBadge(await restoreConflict(message.id));

    case 'GET_SETTINGS':
      return settings();

    case 'SAVE_SETTINGS': {
      const next = { ...(await settings()), ...message.settings };
      await setLocal({ [KEYS.settings]: next });
      await ensureAlarm();
      return next;
    }

    case 'GET_FILTERS':
      return loadFilterConfig();

    case 'SAVE_FILTERS':
      await saveFilterConfig(message.config as FilterConfig);
      return loadFilterConfig();

    case 'PREVIEW_RESTORE':
      return previewRestore(message.tree);

    case 'RUN_RESTORE':
      return withBadge(await runRestore(message.tree, message.summaryId));

    case 'LIST_RESTORE_POINTS':
      return listRestorePoints();

    case 'PREVIEW_UNDO':
      return previewUndo(message.id);

    case 'UNDO_TO_POINT':
      return withBadge(await undoToPoint(message.id, message.summaryId));

    case 'EXPORT_POINT_HTML':
      return { html: await exportPointHtml(message.id) };
  }
}

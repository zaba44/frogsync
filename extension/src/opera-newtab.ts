import { wx, type WxTab } from './wx.js';
import { getLocal, KEYS } from './storage.js';
import { DEFAULT_SETTINGS, type Settings } from './types.js';

// ============================================================
// Opera (takze Opera Air) ignoruje chrome_url_overrides.newtab — nowa karta
// to zawsze jej Speed Dial. Jedyna droga: rozpoznac swiezo utworzona karte
// ze Speed Dialem i od razu przestawic ja na strone FrogSync.
//
// Wlaczane osobnym przelacznikiem i wymaga opcjonalnej zgody "tabs" (bez niej
// przegladarka nie pokazuje adresu karty). Wylaczenie = prawdziwy Speed Dial.
// ============================================================

/** Dokladnie Speed Dial Opery — nigdy dopasowanie po fragmencie nazwy. */
const SPEED_DIAL = /^(chrome|opera):\/\/startpage(shared)?\/?$/i;

export function isOpera(): boolean {
  return typeof navigator !== 'undefined' && / OPR\//.test(navigator.userAgent);
}

/** Karty juz przestawione — kazda najwyzej raz, bez petli. */
const handled = new Set<number>();

/** Eksport dla testow; w tle wolane przez registerOperaNewTab(). */
export async function onOperaTabCreated(tab: WxTab): Promise<void> {
  if (tab.id === undefined || tab.incognito || handled.has(tab.id)) return;
  const url = tab.pendingUrl || tab.url || '';
  if (!SPEED_DIAL.test(url)) return;

  const settings = { ...DEFAULT_SETTINGS, ...(await getLocal<Partial<Settings>>(KEYS.settings, {})) };
  if (!settings.operaNewTab) return;
  if (!(await wx.permissions.contains({ permissions: ['tabs'] }))) return;

  // Jedyna karta okna to start przegladarki — zostaje jej strona startowa
  const inWindow = await wx.tabs.query({ windowId: tab.windowId });
  if (inWindow.length <= 1) return;

  handled.add(tab.id);
  // view=start: kafelki niezaleznie od przelacznika nowej karty (to i tak decyzja tego przelacznika)
  try { await wx.tabs.update(tab.id, { url: wx.runtime.getURL('newtab.html?view=start') }); }
  catch { /* karta mogla zostac juz zamknieta */ }
}

/** Rejestracja na najwyzszym poziomie tla — MV3 budzi worker tylko dla zarejestrowanych zdarzen. */
export function registerOperaNewTab(): void {
  wx.tabs.onCreated.addListener(tab => void onOperaTabCreated(tab));
}

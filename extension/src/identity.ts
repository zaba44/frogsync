// Tozsamosc urzadzenia nadaje serwer przy parowaniu — tutaj tylko rozpoznanie przegladarki.
import { wx, isGecko } from './wx.js';
export interface BrowserInfo { engine: 'chromium' | 'gecko'; name: string; version: string; }

// ============================================================
// Rozpoznanie przegladarki
//
// v1 zwracala doslownie dwie wartosci: 'Firefox' albo 'Chrome'. Opera, Edge,
// Brave i Vivaldi byly w tacce nie do odroznienia — cztery pozycje
// "KOMPUTER-Chrome". To bylo zrodlo objawu "nie pamieta niektorych przegladarek":
// uzytkownik nie potrafil powiedziec, ktory wpis to ktora przegladarka.
// ============================================================

const CHROMIUM_FORKS: { pattern: RegExp; name: string }[] = [
  // Kolejnosc ma znaczenie: forki musza byc sprawdzone przed samym Chrome,
  // bo wszystkie niosa w UA rowniez "Chrome/".
  { pattern: /Vivaldi\/([\d.]+)/,    name: 'Vivaldi' },
  { pattern: /OPR\/([\d.]+)/,        name: 'Opera' },
  { pattern: /Edg(?:A|iOS)?\/([\d.]+)/, name: 'Microsoft Edge' },
  { pattern: /YaBrowser\/([\d.]+)/,  name: 'Yandex Browser' },
  { pattern: /Whale\/([\d.]+)/,      name: 'Naver Whale' },
  { pattern: /Brave\/([\d.]+)/,      name: 'Brave' },
  { pattern: /Chrome\/([\d.]+)/,     name: 'Google Chrome' },
];

export async function detectBrowser(): Promise<BrowserInfo> {
  if (isGecko() && wx.runtime.getBrowserInfo) {
    try {
      const info = await wx.runtime.getBrowserInfo();
      return { engine: 'gecko', name: info.name || 'Firefox', version: info.version || '' };
    } catch {
      return { engine: 'gecko', name: 'Firefox', version: '' };
    }
  }

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

  // Brave celowo nie ujawnia sie w UA. Wystawia za to wlasne API.
  try {
    const brave = (navigator as unknown as { brave?: { isBrave?: () => Promise<boolean> } }).brave;
    if (brave?.isBrave && await brave.isBrave()) {
      return { engine: 'chromium', name: 'Brave', version: matchVersion(ua, /Chrome\/([\d.]+)/) };
    }
  } catch { /* brak API Brave */ }

  for (const fork of CHROMIUM_FORKS) {
    const match = fork.pattern.exec(ua);
    if (match) return { engine: 'chromium', name: fork.name, version: match[1] };
  }

  return { engine: 'chromium', name: 'Przeglądarka Chromium', version: '' };
}

function matchVersion(ua: string, pattern: RegExp): string {
  return pattern.exec(ua)?.[1] ?? '';
}

/** Etykieta proponowana przy parowaniu; uzytkownik moze ja nadpisac w opcjach. */
export async function suggestLabel(): Promise<string> {
  const browser = await detectBrowser();
  return browser.version
    ? `${browser.name} ${browser.version.split('.')[0]}`
    : browser.name;
}

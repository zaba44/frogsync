export const UPDATE_URL = 'https://github.com/zaba44/frogsync/releases/latest';

/** Ta sama postac numeru co manifest wydania i konfiguracja serwera. */
export function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 17 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
    value.split('.').every(part => Number(part) <= 65535);
}

export function compareVersions(a: string, b: string): number {
  if (!validVersion(a) || !validVersion(b)) throw new Error('Nieprawidłowy numer wersji FrogSync.');
  const aa = a.split('.').map(Number);
  const bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return 0;
}

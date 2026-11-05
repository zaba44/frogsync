import { wx } from './wx.js';
import { compareVersions, validVersion } from './extension-version.js';
import type { ChangesResponse, OpsResponse, PlannedOp, ServerSession } from './types.js';

export const PROTOCOL = 3;

export class Offline extends Error {}
export class Unauthorized extends Error {}
export class ResetRequired extends Error {
  constructor(public readonly generation: string) { super('RESET_REQUIRED'); }
}
export class ProfileChanged extends Error {
  constructor(public readonly hasContent: boolean) { super('PROFILE_CHANGED'); }
}
export class ServerError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export class Outdated extends ServerError {
  constructor(
    public readonly minimum = '',
    public readonly latest = '',
    message = 'Serwer wymaga nowszej wersji wtyczki — zaktualizuj FrogSync.',
  ) {
    super(409, 'OUTDATED_CLIENT', message);
  }
}

const TIMEOUT_MS = 30_000;

export function extensionVersion(): string {
  const version = wx.runtime.getManifest().version;
  if (!validVersion(version)) throw new Error('Manifest wtyczki ma nieprawidłowy numer wersji.');
  return version;
}

async function call<T>(base: string, path: string, init: RequestInit & { token?: string }): Promise<T> {
  const headers: Record<string, string> = { 'X-FrogSync-Version': extensionVersion() };
  if (init.token) headers['Authorization'] = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(base.replace(/\/+$/, '') + path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new Offline(err instanceof Error ? err.message : String(err));
  }

  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* pusta odpowiedz (204) */ }
  const body = (payload ?? {}) as {
    error?: string; message?: string; generation?: string; hasContent?: boolean;
    minExtensionVersion?: string; latestExtensionVersion?: string;
  };

  if (response.status === 401) throw new Unauthorized(body.message ?? 'Token odrzucony');
  if (response.status === 409 && body.error === 'RESET_REQUIRED') throw new ResetRequired(body.generation ?? '');
  if (response.status === 409 && body.error === 'PROFILE_CHANGED') throw new ProfileChanged(!!body.hasContent);
  if (response.status === 409 && body.error === 'OUTDATED_CLIENT') {
    throw new Outdated(body.minExtensionVersion ?? '', body.latestExtensionVersion ?? '',
      body.message ?? 'Serwer wymaga nowszej wersji wtyczki — zaktualizuj FrogSync.');
  }
  if (!response.ok) throw new ServerError(response.status, body.error ?? 'HTTP_' + response.status, body.message ?? `HTTP ${response.status}`);
  return payload as T;
}

export interface PairResponse {
  token: string;
  deviceId: string;
  profile: { id: string; name: string };
}

export interface HelloResponse {
  server: string;
  version: string;
  protocol?: number;
  minProtocol?: number;
  minExtensionVersion?: string;
  latestExtensionVersion?: string;
  device: { id: string; name: string };
  profile: { id: string; name: string };
  head: number;
  generation: string;
  roots: string[];
}

export interface PreviewResponse {
  hasContent: boolean;
  bookmarks: number;
  profileName: string;
  previewId?: string;
}

export function preview(url: string, code: string): Promise<PreviewResponse> {
  return call(url, '/api/v1/pair/preview', { method: 'POST', body: JSON.stringify({ code }) });
}

export function pair(url: string, code: string, browser: string, expectContent?: boolean): Promise<PairResponse> {
  return call(url, '/api/v1/pair', { method: 'POST', body: JSON.stringify({ code, browser, expectContent }) });
}

/** Pobranie bez walidacji sluzy tylko do trwalego zapisania nowego parowania. */
export function helloInfo(session: ServerSession): Promise<HelloResponse> {
  return call(session.url, '/api/v1/hello', { token: session.token });
}

export async function hello(session: ServerSession): Promise<HelloResponse> {
  const info = await helloInfo(session);
  const minimum = info.minExtensionVersion ?? '';
  const latest = info.latestExtensionVersion ?? '';
  if ((minimum && !validVersion(minimum)) || (latest && !validVersion(latest))) {
    throw new ServerError(502, 'INVALID_VERSION_POLICY', 'Serwer podał nieprawidłowe wymagania wersji.');
  }
  if ((minimum && compareVersions(extensionVersion(), minimum) < 0) || (info.minProtocol ?? 0) > PROTOCOL) {
    throw new Outdated(minimum, latest);
  }
  return info;
}

export function changes(session: ServerSession, after: number, limit = 1000): Promise<ChangesResponse> {
  const q = `?after=${after}&limit=${limit}&generation=${encodeURIComponent(session.generation)}`;
  return call(session.url, '/api/v1/changes' + q, { token: session.token });
}

export function sendOps(session: ServerSession, ops: PlannedOp[]): Promise<OpsResponse> {
  return call(session.url, '/api/v1/ops', {
    method: 'POST', token: session.token,
    body: JSON.stringify({ ops, generation: session.generation, protocol: PROTOCOL }),
  });
}

export function reportCursor(session: ServerSession, cursor: number): Promise<unknown> {
  return call(session.url, '/api/v1/cursor', { method: 'POST', token: session.token, body: JSON.stringify({ cursor }) });
}

// ---- strona startowa profilu (3.2) ----

export type {
  StartPageSnapshot, CustomBlock, CustomTile, StartBlock, StartTemplate,
} from './core/startpage.js';
import {
  parseStartPage, type StartPageSnapshot, type CustomBlock,
} from './core/startpage.js';

export class StartPageConflict extends Error {
  constructor(public readonly current: StartPageSnapshot) {
    super('Układ zmienił się na serwerze.');
  }
}
async function startRequest(
  session: ServerSession, path: string, etag?: string, body?: unknown,
): Promise<Response> {
  try {
    return await fetch(session.url.replace(/\/+$/, '') + '/api/v1/startpage' + path, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: {
        Authorization: 'Bearer ' + session.token,
        'X-FrogSync-Version': extensionVersion(),
        ...(etag ? { 'If-None-Match': etag } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw new Offline(error instanceof Error ? error.message : String(error));
  }
}
async function startJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 160000) throw new Error('Za duża konfiguracja strony startowej.');
  return JSON.parse(text);
}
async function startError(response: Response, payload?: unknown): Promise<never> {
  const body = (payload ?? await response.json().catch(() => ({}))) as {
    error?: string; message?: string; current?: unknown;
  };
  if (response.status === 401) throw new Unauthorized('Token odrzucony');
  if (response.status === 409 && body.error === 'STARTPAGE_CHANGED')
    throw new StartPageConflict(parseStartPage(body.current));
  throw new ServerError(
    response.status, body.error ?? 'HTTP_' + response.status,
    body.message ?? 'HTTP ' + response.status);
}
export async function startPage(
  session: ServerSession, etag?: string,
): Promise<{ etag: string; snapshot: StartPageSnapshot } | null> {
  const response = await startRequest(session, '', etag);
  if (response.status === 304) return null;
  if (!response.ok) return startError(response);
  return {
    etag: response.headers.get('ETag') ?? '',
    snapshot: parseStartPage(await startJson(response)),
  };
}
export interface StartPageImage {
  etag: string; type: string; bytes: ArrayBuffer; generation: string; version: number;
}
export async function startPageImage(
  session: ServerSession, name: 'logo' | 'background', etag?: string,
): Promise<StartPageImage | 'none' | null> {
  const response = await startRequest(session, '/' + name, etag);
  if (response.status === 304) return null;
  const generation = response.headers.get('X-FrogSync-Generation') ?? '';
  const version = Number(response.headers.get(
    name === 'logo' ? 'X-FrogSync-Logo-Version' : 'X-FrogSync-Background-Version'));
  if (response.status === 404 && generation === session.generation) return 'none';
  if (!response.ok) return startError(response);
  const type = (response.headers.get('Content-Type') ?? '').split(';')[0].trim();
  const maximum = name === 'logo' ? 512 * 1024 : 2 * 1024 * 1024;
  if (generation !== session.generation || !Number.isSafeInteger(version) || version < 0 ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(type) ||
      Number(response.headers.get('Content-Length')) > maximum)
    throw new Error('Niepoprawny obraz profilu.');
  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > maximum)
    throw new Error('Niepoprawny rozmiar obrazu.');
  return { etag: response.headers.get('ETag') ?? '', type, bytes, generation, version };
}
export function startPageLogo(session: ServerSession, etag?: string) {
  return startPageImage(session, 'logo', etag);
}
export async function saveStartPageCustom(
  session: ServerSession, settingsVersion: number, blocks: CustomBlock[],
): Promise<StartPageSnapshot> {
  const response = await startRequest(session, '/custom', undefined, {
    generation: session.generation, settingsVersion, blocks,
  });
  const payload = await startJson(response);
  if (!response.ok) return startError(response, payload);
  const snapshot = parseStartPage(payload);
  if (snapshot.profileId !== session.profile.id || snapshot.generation !== session.generation)
    throw new Error('Odpowiedź należy do innego profilu lub generacji.');
  return snapshot;
}

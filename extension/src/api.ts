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

export interface StartPageSectionView { id: string; folderId: string; title: string | null; available: boolean; folderTitle: string | null }
export interface StartPageEngineDef { id: string; name: string; url: string; color: string; suggest: 'google' | 'none' }
export interface StartPageSnapshot {
  profileId: string; generation: string; settingsVersion: number; logoVersion: number;
  configuration: { version: number; sections: StartPageSectionView[]; engines: StartPageEngineDef[] };
}

/** Warunkowy GET: null przy 304 (bez zmian od podanego ETag). Bledy jak w call(). */
async function conditional(session: ServerSession, path: string, etag?: string): Promise<{ response: Response } | null> {
  const headers: Record<string, string> = { 'X-FrogSync-Version': extensionVersion(), Authorization: `Bearer ${session.token}` };
  if (etag) headers['If-None-Match'] = etag;
  let response: Response;
  try {
    response = await fetch(session.url.replace(/\/+$/, '') + path,
      { headers, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Offline(err instanceof Error ? err.message : String(err));
  }
  if (response.status === 304) return null;
  if (response.status === 401) throw new Unauthorized('Token odrzucony');
  return { response };
}

export async function startPage(session: ServerSession, etag?: string): Promise<{ etag: string; snapshot: StartPageSnapshot } | null> {
  const r = await conditional(session, '/api/v1/startpage', etag);
  if (!r) return null;
  if (!r.response.ok) throw new ServerError(r.response.status, 'HTTP_' + r.response.status, `HTTP ${r.response.status}`);
  return { etag: r.response.headers.get('ETag') ?? '', snapshot: await r.response.json() as StartPageSnapshot };
}

/** Logo profilu; 'none' gdy profil go nie ma (404), null przy 304. */
export async function startPageLogo(session: ServerSession, etag?: string): Promise<{ etag: string; type: string; bytes: ArrayBuffer } | 'none' | null> {
  const r = await conditional(session, '/api/v1/startpage/logo', etag);
  if (!r) return null;
  if (r.response.status === 404) return 'none';
  if (!r.response.ok) throw new ServerError(r.response.status, 'HTTP_' + r.response.status, `HTTP ${r.response.status}`);
  return { etag: r.response.headers.get('ETag') ?? '', type: r.response.headers.get('Content-Type') ?? 'image/png', bytes: await r.response.arrayBuffer() };
}

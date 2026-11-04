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

const TIMEOUT_MS = 30_000;

async function call<T>(base: string, path: string, init: RequestInit & { token?: string }): Promise<T> {
  const headers: Record<string, string> = {};
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
    // Fetch nie rozroznia awarii sieci od problemu z certyfikatem.
    throw new Offline(err instanceof Error ? err.message : String(err));
  }

  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* pusta odpowiedz (204) */ }
  const body = (payload ?? {}) as { error?: string; message?: string; generation?: string; hasContent?: boolean };

  if (response.status === 401) throw new Unauthorized(body.message ?? 'Token odrzucony');
  if (response.status === 409 && body.error === 'RESET_REQUIRED') throw new ResetRequired(body.generation ?? '');
  if (response.status === 409 && body.error === 'PROFILE_CHANGED') throw new ProfileChanged(!!body.hasContent);
  if (response.status === 409 && body.error === 'OUTDATED_CLIENT') {
    throw new ServerError(409, 'OUTDATED_CLIENT',
      body.message ?? 'Zaktualizuj wtyczkę FrogSync i przeładuj ją na stronie rozszerzeń.');
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

/** Sprawdza kod i stan profilu bez zuzywania kodu. */
export function preview(url: string, code: string): Promise<PreviewResponse> {
  return call(url, '/api/v1/pair/preview', { method: 'POST', body: JSON.stringify({ code }) });
}

/** Inny stan profilu zwraca ProfileChanged bez zuzycia kodu. */
export function pair(url: string, code: string, browser: string, expectContent?: boolean): Promise<PairResponse> {
  return call(url, '/api/v1/pair', { method: 'POST', body: JSON.stringify({ code, browser, expectContent }) });
}

export async function hello(session: ServerSession): Promise<HelloResponse> {
  const info = await call<HelloResponse>(session.url, '/api/v1/hello', { token: session.token });
  if ((info.minProtocol ?? 0) > PROTOCOL) {
    throw new ServerError(409, 'OUTDATED_CLIENT', 'Zaktualizuj wtyczkę FrogSync i przeładuj ją na stronie rozszerzeń.');
  }
  return info;
}

export function changes(session: ServerSession, after: number, limit = 1000): Promise<ChangesResponse> {
  const q = `?after=${after}&limit=${limit}&generation=${encodeURIComponent(session.generation)}`;
  return call(session.url, '/api/v1/changes' + q, { token: session.token });
}

/** Serwer sprawdza generacje wewnatrz transakcji zapisu. */
export function sendOps(session: ServerSession, ops: PlannedOp[]): Promise<OpsResponse> {
  return call(session.url, '/api/v1/ops', {
    method: 'POST', token: session.token,
    body: JSON.stringify({ ops, generation: session.generation, protocol: PROTOCOL }),
  });
}

export function reportCursor(session: ServerSession, cursor: number): Promise<unknown> {
  return call(session.url, '/api/v1/cursor', { method: 'POST', token: session.token, body: JSON.stringify({ cursor }) });
}

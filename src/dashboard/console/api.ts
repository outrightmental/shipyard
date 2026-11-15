import type { Auth } from './auth.js';

/**
 * The console's calls to the platform: `/api/…` on its own origin, with the
 * operator's id token as the bearer on every one. API Gateway verifies the
 * token before the platform is called at all, so a token it no longer takes
 * is a 401 with nothing behind it: the console signs in again and comes back
 * to where it was.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** What to do about it, when the platform said. */
    readonly remedy: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class Api {
  constructor(
    private readonly base: string,
    private readonly auth: Auth,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  get<T>(path: string): Promise<T> { return this.call<T>('GET', path); }
  post<T>(path: string, body?: unknown): Promise<T> { return this.call<T>('POST', path, body); }
  put<T>(path: string, body?: unknown): Promise<T> { return this.call<T>('PUT', path, body); }
  patch<T>(path: string, body?: unknown): Promise<T> { return this.call<T>('PATCH', path, body); }
  delete<T>(path: string): Promise<T> { return this.call<T>('DELETE', path); }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.auth.idToken();
    if (!token) {
      void this.auth.signIn(location.hash);
      throw new ApiError(401, 'NOT_SIGNED_IN', 'signing in again…');
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new ApiError(0, 'NETWORK', `Shipyard could not be reached: ${(error as Error).message}`);
    }
    let json: Record<string, unknown> | null = null;
    try { json = await res.json() as Record<string, unknown>; } catch { /* no body */ }
    if (res.status === 401) {
      void this.auth.signIn(location.hash);
      throw new ApiError(401, 'NOT_SIGNED_IN', 'signing in again…');
    }
    if (!res.ok || json?.['ok'] === false) {
      throw new ApiError(
        res.status,
        typeof json?.['code'] === 'string' ? json['code'] : `HTTP_${res.status}`,
        typeof json?.['error'] === 'string' ? json['error'] : typeof json?.['message'] === 'string' ? json['message'] : `Shipyard answered ${res.status}`,
        typeof json?.['remedy'] === 'string' ? json['remedy'] : null,
      );
    }
    return (json ?? {}) as T;
  }
}

/** An error as a line for a person: what went wrong, and what to do about it when that is known. */
export function errorLine(error: unknown): string {
  if (error instanceof ApiError) return error.remedy ? `${error.message} — ${error.remedy}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

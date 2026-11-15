/**
 * The console's configuration.
 *
 * The static build reads `/config.json` from its own origin. Terraform writes
 * it beside the build at deploy time (infra/console.tf) from the user pool,
 * the app client and the hosts, so it is never bundled and a build is never
 * tied to a deploy:
 *
 *   { "apiBase": "/api",
 *     "wsUrl": "wss://ws.shipyard.outright.io",
 *     "cognito": { "domain": "https://auth.shipyard.outright.io", "clientId": "…",
 *                  "redirectUri": "https://shipyard.outright.io/", "region": "us-east-1" },
 *     "release": "<commit>" }
 *
 * `cognito.domain` is the console's own sign-in pages (console/auth/);
 * `region` is the user pool's, whose API refreshes and revokes the tokens.
 */
export interface CognitoConfig {
  domain: string;
  clientId: string;
  redirectUri: string | null;
  region: string;
}

export interface ConsoleConfig {
  apiBase: string;
  wsUrl: string;
  cognito: CognitoConfig;
  /** The commit this console was deployed with. */
  release: string | null;
}

const trimSlash = (value: unknown): string => String(value ?? '').replace(/\/+$/, '');

/** A config.json as the console keeps it, or a thrown error saying what it lacks. */
export function normalizeConfig(raw: unknown): ConsoleConfig {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const cognito = (typeof input['cognito'] === 'object' && input['cognito'] !== null ? input['cognito'] : {}) as Record<string, unknown>;
  if (!cognito['domain'] || !cognito['clientId'] || !cognito['region']) {
    throw new Error('config.json names no sign-in: the console was not deployed with one');
  }
  const wsUrl = trimSlash(input['wsUrl']);
  if (!wsUrl) throw new Error('config.json names no WebSocket URL');
  return {
    apiBase: trimSlash(input['apiBase'] ?? '/api') || '/api',
    wsUrl,
    cognito: {
      domain: trimSlash(cognito['domain']),
      clientId: String(cognito['clientId']),
      redirectUri: typeof cognito['redirectUri'] === 'string' ? cognito['redirectUri'] : null,
      region: String(cognito['region']),
    },
    release: typeof input['release'] === 'string' ? input['release'] : null,
  };
}

export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<ConsoleConfig> {
  const res = await fetchImpl('/config.json', { cache: 'no-store', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`config.json could not be read (${res.status})`);
  return normalizeConfig(await res.json());
}

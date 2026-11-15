import { createPublicKey, createVerify, type KeyObject } from "node:crypto";
import { PlatformError, type Operator } from "./platform.js";

/**
 * Cognito id tokens: who a console is.
 *
 * The HTTP API's JWT authorizer verifies them before the function is called
 * and hands it the claims. The WebSocket API has no such authorizer, so its
 * `$connect` verifies the token here, with the user pool's key set (RS256),
 * against the pool's issuer and the app client's audience. Nothing from npm:
 * node:crypto reads a JWK and verifies the signature.
 */

interface Jwk {
  kty: string;
  kid?: string;
  [key: string]: unknown;
}

const fromBase64Url = (text: string): Buffer => Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");

function malformed(): never {
  throw new PlatformError(401, "JWT_MALFORMED", "not a token");
}

export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Buffer;
  signed: string;
} {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) malformed();
  const [h, p, s] = parts as [string, string, string];
  try {
    return {
      header: JSON.parse(fromBase64Url(h).toString("utf8")) as Record<string, unknown>,
      payload: JSON.parse(fromBase64Url(p).toString("utf8")) as Record<string, unknown>,
      signature: fromBase64Url(s),
      signed: `${h}.${p}`,
    };
  } catch {
    return malformed();
  }
}

function indexKeys(jwks: { keys?: Jwk[] } | null): Map<string, KeyObject> {
  const index = new Map<string, KeyObject>();
  for (const jwk of jwks?.keys ?? []) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    index.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
  }
  return index;
}

export interface JwtVerifierOptions {
  /** https://cognito-idp.<region>.amazonaws.com/<pool id> */
  issuer: string;
  /** The app client's id: the `aud` of an id token. */
  audience: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** The key set, when known (tests); otherwise read from the issuer and kept. */
  jwks?: { keys: Jwk[] } | null;
  clockSkewMs?: number;
}

/** A verifier for one user pool and app client: the operator a valid token names, or a thrown 401. */
export function createJwtVerifier(options: JwtVerifierOptions): (token: string) => Promise<Operator> {
  const { issuer, audience } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const clockSkewMs = options.clockSkewMs ?? 60_000;
  let keys: Promise<Map<string, KeyObject>> | null = options.jwks ? Promise.resolve(indexKeys(options.jwks)) : null;

  async function keyFor(kid: string, refresh = false): Promise<KeyObject | null> {
    if (!keys || refresh) {
      const loading = fetchImpl(`${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) })
        .then(async (res) => {
          if (!res.ok) throw new PlatformError(503, "JWKS_UNAVAILABLE", `the user pool's keys could not be read (${res.status})`);
          return indexKeys(await res.json() as { keys?: Jwk[] });
        });
      keys = loading;
      // A failed read is not kept: the next token tries again.
      loading.catch(() => { if (keys === loading) keys = null; });
    }
    return (await keys).get(kid) ?? null;
  }

  return async function verify(token: string): Promise<Operator> {
    const { header, payload, signature, signed } = decodeJwt(token);
    if (header["alg"] !== "RS256") throw new PlatformError(401, "JWT_ALGORITHM", "unsupported token algorithm");
    const kid = typeof header["kid"] === "string" ? header["kid"] : "";
    let key = await keyFor(kid);
    // A key the pool rotated in since the set was read.
    if (!key && !options.jwks) key = await keyFor(kid, true);
    if (!key) throw new PlatformError(401, "JWT_KEY", "unknown signing key");
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signed);
    if (!verifier.verify(key, signature)) throw new PlatformError(401, "JWT_SIGNATURE", "bad token signature");

    const at = now();
    if (payload["iss"] !== issuer) throw new PlatformError(401, "JWT_ISSUER", "token from another issuer");
    if (payload["aud"] !== audience) throw new PlatformError(401, "JWT_AUDIENCE", "token for another client");
    // An id token says who someone is; an access token is for calling Cognito, and is not taken here.
    if (payload["token_use"] !== "id") throw new PlatformError(401, "JWT_USE", "not an id token");
    const exp = payload["exp"];
    if (typeof exp !== "number" || exp * 1000 + clockSkewMs < at) throw new PlatformError(401, "JWT_EXPIRED", "token expired");
    const sub = payload["sub"];
    if (typeof sub !== "string" || !sub) throw new PlatformError(401, "JWT_SUBJECT", "token names no one");
    return { sub, email: typeof payload["email"] === "string" ? payload["email"] : null };
  };
}

/** Who the HTTP API's authorizer says a request is from, or null. */
export function operatorFromClaims(claims: Record<string, unknown> | undefined | null): Operator | null {
  const sub = claims?.["sub"];
  if (typeof sub !== "string" || !sub) return null;
  return { sub, email: typeof claims?.["email"] === "string" ? claims["email"] as string : null };
}

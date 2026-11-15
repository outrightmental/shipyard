/**
 * Cognito's user pool API from the browser. The sign-in pages
 * (console/auth/) sign in with it, and the console (src/dashboard/console/auth.ts) refreshes
 * and revokes its tokens with it. Every action called here is one Cognito
 * takes without AWS credentials: the app client's id (public, no secret) is
 * all it asks for.
 */

export const cognitoEndpoint = region => `https://cognito-idp.${region}.amazonaws.com/`;

/** Cognito's error type without its namespace: `NotAuthorizedException`. */
const errorType = (json, res) => String(json?.__type ?? res.headers?.get?.('x-amzn-errortype') ?? '').split('#').pop().split(':')[0];

/**
 * One action (`InitiateAuth`, `RespondToAuthChallenge`, …) with its JSON body.
 * The answer's JSON, or a thrown error whose `code` is Cognito's error type
 * (`NETWORK` when Cognito could not be reached).
 */
export async function cognitoCall({ region, fetchImpl = globalThis.fetch }, action, body) {
  let res;
  try {
    res = await fetchImpl(cognitoEndpoint(region), {
      method:  'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AWSCognitoIdentityProviderService.${action}` },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    throw Object.assign(new Error(`Cognito could not be reached: ${err.message}`), { code: 'NETWORK' });
  }
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok) {
    throw Object.assign(new Error(json?.message ?? json?.Message ?? `Cognito answered ${res.status}`), { code: errorType(json, res) || `HTTP_${res.status}`, status: res.status });
  }
  return json ?? {};
}

/** An AuthenticationResult under the names the console keeps: `{ id_token, access_token, refresh_token, expires_in }`. */
export function tokensOf(result, { refreshToken = null } = {}) {
  if (!result?.IdToken) return null;
  return {
    id_token:      result.IdToken,
    access_token:  result.AccessToken ?? null,
    refresh_token: result.RefreshToken ?? refreshToken,
    expires_in:    Number(result.ExpiresIn) || 3600,
  };
}

/** Fresh tokens for a refresh token (Cognito answers no new refresh token, so the one given is kept). */
export async function refreshTokens({ region, clientId, fetchImpl }, refreshToken) {
  const answer = await cognitoCall({ region, fetchImpl }, 'InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: clientId, AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
  const tokens = tokensOf(answer.AuthenticationResult, { refreshToken });
  if (!tokens) throw Object.assign(new Error('Cognito answered no tokens'), { code: 'NO_TOKENS' });
  return tokens;
}

/** End a refresh token, and every token it gave, everywhere. */
export function revokeToken({ region, clientId, fetchImpl }, refreshToken) {
  return cognitoCall({ region, fetchImpl }, 'RevokeToken', { Token: refreshToken, ClientId: clientId });
}

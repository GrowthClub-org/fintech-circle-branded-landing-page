/* Susanne's one-time Google connection (OAuth 2.0 authorization code + PKCE)
   and fresh access tokens from the stored refresh token.

   Tokens never leave the Worker: the refresh token is encrypted into KV, the
   callback page only says whether it worked, and errors log Google's error
   code, never a response body that could carry a token. */

import { encrypt, decrypt, randomToken, sha256Base64url } from './crypto.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';
// openid + email let the callback check which account signed in.
export const SCOPES = ['openid', 'email', MEET_SCOPE];
const CONNECTION_KEY = 'google:connection';

export class GoogleAuthError extends Error {}

export function redirectUri(request) {
  return new URL('/oauth/google/callback', request.url).toString();
}

export async function startAuth(request, env) {
  const state = randomToken();
  const verifier = randomToken(48);
  await env.STATE.put('oauth:' + state, verifier, { expirationTtl: 600 });
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(request),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    login_hint: env.GOOGLE_ACCOUNT_EMAIL,
    state,
    code_challenge: await sha256Base64url(verifier),
    code_challenge_method: 'S256',
  });
  return Response.redirect(url.toString(), 302);
}

/* Returns { status, message } for the page shown to Susanne. */
export async function finishAuth(request, env) {
  const params = new URL(request.url).searchParams;
  if (params.get('error')) {
    console.warn('Google sign-in cancelled or refused:', params.get('error'));
    return { status: 400, message: 'Google did not grant access. Nothing was changed; you can start again.' };
  }
  const state = params.get('state');
  const code = params.get('code');
  const verifier = state && await env.STATE.get('oauth:' + state);
  if (!verifier || !code) {
    return { status: 400, message: 'This sign-in link has expired or was already used. Please start again.' };
  }
  await env.STATE.delete('oauth:' + state);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(request),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Google token exchange failed:', res.status, data.error, data.error_description || '');
    // Google's error code (e.g. "invalid_client") is not secret and says what to fix.
    const reason = /^[a-z_]+$/.test(String(data.error || '')) ? ` (Google error: ${data.error})` : '';
    return { status: 502, message: `Google sign-in could not be completed${reason}. Please start again.` };
  }

  // Received straight from Google's token endpoint over TLS, so the claims can
  // be read without checking the signature (OpenID Connect Core 3.1.3.7).
  const claims = decodeJwtPayload(data.id_token);
  const email = String(claims.email || '').toLowerCase();
  if (!claims.email_verified || email !== String(env.GOOGLE_ACCOUNT_EMAIL).toLowerCase()) {
    return { status: 403, message: `You signed in as ${email || 'an unknown account'}. Please sign in as ${env.GOOGLE_ACCOUNT_EMAIL}.` };
  }
  if (!String(data.scope || '').split(' ').includes(MEET_SCOPE)) {
    return { status: 400, message: 'Access to Google Meet information was not ticked. Please start again and allow it.' };
  }
  if (!data.refresh_token) {
    return { status: 502, message: 'Google did not return a long-lived token. Please start again.' };
  }

  const connection = {
    email,
    userId: 'users/' + claims.sub,
    refreshToken: data.refresh_token,
    connectedAt: new Date().toISOString(),
  };
  await env.STATE.put(CONNECTION_KEY, await encrypt(env.TOKEN_ENCRYPTION_KEY, JSON.stringify(connection)));
  accessCache = null;
  console.log('Google connected for', email);
  return { status: 200, message: `Connected. ${email} is linked, and you can close this page.` };
}

export async function loadConnection(env) {
  const stored = await env.STATE.get(CONNECTION_KEY);
  if (!stored) return null;
  return JSON.parse(await decrypt(env.TOKEN_ENCRYPTION_KEY, stored));
}

// Per isolate: an access token lasts an hour, so most runs reuse it.
let accessCache = null;

/* Returns { accessToken, userId }. userId ("users/…") is Susanne's Meet
   participant id, which the attendance check leaves out. */
export async function getAccess(env) {
  if (accessCache && accessCache.expiresAt > Date.now() + 60_000) return accessCache;
  const connection = await loadConnection(env);
  if (!connection) throw new GoogleAuthError('Google is not connected yet: Susanne needs to open /oauth/google/start');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: connection.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data.error === 'invalid_grant') {
    throw new GoogleAuthError('Google connection was revoked or expired: Susanne needs to open /oauth/google/start again');
  }
  if (!res.ok || !data.access_token) throw new Error(`Google token refresh failed: ${res.status} ${data.error || ''}`.trim());

  accessCache = {
    accessToken: data.access_token,
    userId: connection.userId,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  return accessCache;
}

export function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(part);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
  } catch {
    return {};
  }
}

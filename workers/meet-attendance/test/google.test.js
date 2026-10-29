import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt, sha256Base64url } from '../src/lib/crypto.js';
import { startAuth, finishAuth, decodeJwtPayload, MEET_SCOPE } from '../src/lib/google.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

function kv() {
  const store = new Map();
  return { store, get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, delete: async k => { store.delete(k); } };
}

const ENV = () => ({
  STATE: kv(), TOKEN_ENCRYPTION_KEY: KEY, GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_ACCOUNT_EMAIL: 'susanne.chishti@fintechcircle.com',
});

const idToken = claims => 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.sig';

test('crypto: round trip, and the stored value is not readable', async () => {
  const sealed = await encrypt(KEY, 'refresh-token-value');
  assert.ok(!sealed.includes('refresh-token-value'));
  assert.equal(await decrypt(KEY, sealed), 'refresh-token-value');
  await assert.rejects(decrypt(Buffer.alloc(32, 8).toString('base64'), sealed));
});

test('start: redirects to Google with PKCE, offline access and the callback URL', async () => {
  const env = ENV();
  const res = await startAuth(new Request('https://fintech-meet-attendance.boards.workers.dev/oauth/google/start'), env);
  assert.equal(res.status, 302);
  const url = new URL(res.headers.get('location'));
  const p = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(p.get('redirect_uri'), 'https://fintech-meet-attendance.boards.workers.dev/oauth/google/callback');
  assert.equal(p.get('scope'), `openid email ${MEET_SCOPE}`);
  assert.equal(p.get('access_type'), 'offline');
  assert.equal(p.get('code_challenge_method'), 'S256');
  const verifier = env.STATE.store.get('oauth:' + p.get('state'));
  assert.equal(p.get('code_challenge'), await sha256Base64url(verifier));
});

async function callback(env, tokenResponse, query = 'code=abc') {
  const start = await startAuth(new Request('https://w.example/oauth/google/start'), env);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(tokenResponse), { status: tokenResponse.error ? 400 : 200 });
  try {
    return await finishAuth(new Request(`https://w.example/oauth/google/callback?${query}&state=${state}`), env);
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('callback: stores the connection encrypted for the right account only', async () => {
  const env = ENV();
  const ok = await callback(env, { refresh_token: 'rt-1', access_token: 'at', scope: `openid ${MEET_SCOPE} email`,
    id_token: idToken({ email: 'Susanne.Chishti@fintechcircle.com', email_verified: true, sub: '111' }) });
  assert.equal(ok.status, 200);
  const sealed = env.STATE.store.get('google:connection');
  assert.ok(!sealed.includes('rt-1'));
  assert.deepEqual({ ...JSON.parse(await decrypt(KEY, sealed)), connectedAt: null },
    { email: 'susanne.chishti@fintechcircle.com', userId: 'users/111', refreshToken: 'rt-1', connectedAt: null });
  assert.equal([...env.STATE.store.keys()].filter(k => k.startsWith('oauth:')).length, 0);
});

test('callback: refuses another account, a missing Meet scope or a reused link', async () => {
  const wrong = ENV();
  const r1 = await callback(wrong, { refresh_token: 'rt', scope: MEET_SCOPE, id_token: idToken({ email: 'boards@fintechcircle.com', email_verified: true, sub: '2' }) });
  assert.equal(r1.status, 403);
  assert.equal(wrong.STATE.store.get('google:connection'), undefined);

  const noScope = ENV();
  const r2 = await callback(noScope, { refresh_token: 'rt', scope: 'openid email', id_token: idToken({ email: 'susanne.chishti@fintechcircle.com', email_verified: true, sub: '1' }) });
  assert.equal(r2.status, 400);
  assert.equal(noScope.STATE.store.get('google:connection'), undefined);

  const env = ENV();
  const reused = await finishAuth(new Request('https://w.example/oauth/google/callback?code=abc&state=nope'), env);
  assert.equal(reused.status, 400);
});

test('jwt: unreadable token gives no claims', () => {
  assert.deepEqual(decodeJwtPayload('garbage'), {});
  assert.equal(decodeJwtPayload(idToken({ sub: '9' })).sub, '9');
});

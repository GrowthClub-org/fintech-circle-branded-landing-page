/* AES-GCM encryption for what we keep in KV, keyed by the TOKEN_ENCRYPTION_KEY
   secret (32 random bytes, base64). Anyone who can read KV still cannot use
   the refresh token without the secret. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function importKey(secret) {
  const raw = base64ToBytes(secret || '');
  if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(secret), encoder.encode(text));
  return bytesToBase64(iv) + '.' + bytesToBase64(new Uint8Array(data));
}

export async function decrypt(secret, payload) {
  const [iv, data] = String(payload).split('.').map(base64ToBytes);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await importKey(secret), data);
  return decoder.decode(plain);
}

export function randomToken(bytes = 32) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Base64url(text) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

export function base64url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

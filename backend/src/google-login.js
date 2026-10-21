'use strict';

// Google OpenID Connect login. Only the authorization-code flow is used; tokens never
// enter the browser. Google subjects are linked only to an existing, verified-email
// account, and the caller still has to pass the phone verification step.
const crypto = require('crypto');

const transactions = new Map();
const keysCache = { keys: null, expires: 0 };
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';

function config() {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = String(process.env.GOOGLE_REDIRECT_URI || '').trim();
  if (!clientId || !clientSecret || !redirectUri) throw new Error('Google sign-in is not configured.');
  let url;
  try { url = new URL(redirectUri); } catch { throw new Error('Google redirect URI is invalid.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local && url.protocol === 'http:')) {
    throw new Error('Google redirect URI must use HTTPS (HTTP is allowed only for local development).');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/auth/google/callback') {
    throw new Error('Google redirect URI must be the exact /api/auth/google/callback URL.');
  }
  return { clientId, clientSecret, redirectUri, local };
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; }
  }
  return '';
}

function appendCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [...(Array.isArray(existing) ? existing : [existing]), value] : value);
}

function setCookie(res, name, value, age) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=${age}${secure}`);
}

function clearCookie(res, name) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendCookie(res, `${name}=; HttpOnly; Path=/api/auth; SameSite=Lax; Max-Age=0${secure}`);
}

function makeAuthorizationUrl(res) {
  const cfg = config();
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const now = Date.now();
  for (const [key, value] of transactions) if (value.expires < now) transactions.delete(key);
  if (transactions.size >= 5000) throw new Error('Google sign-in is busy. Try again shortly.');
  transactions.set(state, { nonce, verifier, expires: now + 10 * 60 * 1000 });
  setCookie(res, 'google_state', state, 600);
  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code',
    scope: 'openid email profile', state, nonce, code_challenge: challenge,
    code_challenge_method: 'S256', prompt: 'select_account'
  }).toString();
  return url.toString();
}

function requestJson(url, options, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Google sign-in provider timed out.')), 10000);
    fetch(url, { ...options, signal: AbortSignal.timeout(10000), redirect: 'error' }).then(async response => {
      clearTimeout(timer);
      const raw = await response.text();
      if (raw.length > limit) throw new Error('Google sign-in provider response was too large.');
      let body;
      try { body = JSON.parse(raw); } catch { throw new Error('Google sign-in provider returned an invalid response.'); }
      if (!response.ok) throw new Error('Google sign-in provider rejected the request.');
      resolve({ body, headers: response.headers });
    }).catch(error => { clearTimeout(timer); reject(error); });
  });
}

async function getGoogleKeys() {
  if (keysCache.keys && keysCache.expires > Date.now()) return keysCache.keys;
  const result = await requestJson(JWKS_ENDPOINT, { method: 'GET' });
  if (!result.body || !Array.isArray(result.body.keys) || result.body.keys.length > 16) throw new Error('Google signing keys are invalid.');
  const maxAge = Number((result.headers.get('cache-control') || '').match(/max-age=(\d+)/i)?.[1] || 300);
  keysCache.keys = result.body.keys;
  keysCache.expires = Date.now() + Math.min(maxAge, 3600) * 1000;
  return keysCache.keys;
}

async function verifyIdToken(token, expectedNonce, clientId) {
  if (typeof token !== 'string' || token.length > 16384) throw new Error('Google returned an invalid identity token.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Google returned an invalid identity token.');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw new Error('Google returned an invalid identity token.'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Google identity token algorithm is not accepted.');
  const jwk = (await getGoogleKeys()).find(key => key.kid === header.kid && key.kty === 'RSA' && key.use === 'sig');
  if (!jwk) { keysCache.expires = 0; throw new Error('Google identity signing key is unavailable. Try again.'); }
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  const now = Math.floor(Date.now() / 1000);
  if (!valid || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.aud !== clientId ||
      (claims.azp && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= now ||
      !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.nonce !== expectedNonce ||
      claims.email_verified !== true || typeof claims.email !== 'string' || typeof claims.sub !== 'string') {
    throw new Error('Google identity could not be verified. Please try again.');
  }
  return { email: claims.email.toLowerCase(), subject: claims.sub, firstName: claims.given_name, lastName: claims.family_name };
}

function takeTransaction(req) {
  const state = cookieValue(req, 'google_state');
  const queryState = String(req.query.state || '');
  const transaction = state && state === queryState ? transactions.get(state) : null;
  if (state) transactions.delete(state);
  return transaction && transaction.expires > Date.now() ? transaction : null;
}

async function complete(req) {
  const transaction = takeTransaction(req);
  if (!transaction) throw new Error('Google sign-in expired or could not be verified. Please try again.');
  const cfg = config();
  const code = String(req.query.code || '');
  if (!code || code.length > 4096) throw new Error('Google sign-in did not return a valid authorization code.');
  const body = new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri, grant_type: 'authorization_code', code_verifier: transaction.verifier });
  const result = await requestJson(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  return verifyIdToken(result.body.id_token, transaction.nonce, cfg.clientId);
}

module.exports = { config, makeAuthorizationUrl, complete, setCookie, clearCookie, cookieValue };

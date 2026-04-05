/**
 * Stateless OAuth 2.0 helpers for the Cloudflare Worker.
 * Tokens are HMAC-SHA256 signed with MCP_API_KEY — no KV or DB needed.
 */

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Crypto primitives
// ---------------------------------------------------------------------------

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

async function hmacVerify(secret: string, message: string, sig: string): Promise<boolean> {
  const expected = await hmacSign(secret, message);
  return constantTimeEqual(expected, sig);
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

function randomNonce(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(12)));
}

// ---------------------------------------------------------------------------
// Authorization codes  (valid AUTH_CODE_TTL_MS, encode PKCE challenge)
// Format: {ts}.{nonce}.{b64url(codeChallenge)}.{hmac}
// ---------------------------------------------------------------------------

export async function generateAuthCode(secret: string, codeChallenge: string): Promise<string> {
  const ts = Date.now().toString();
  const nonce = randomNonce();
  const cc = b64url(new TextEncoder().encode(codeChallenge));
  const payload = `${ts}.${nonce}.${cc}`;
  const sig = await hmacSign(secret, `code:${payload}`);
  return `${payload}.${sig}`;
}

export async function validateAuthCode(
  secret: string,
  code: string,
  codeVerifier: string,
): Promise<boolean> {
  try {
    const parts = code.split('.');
    if (parts.length !== 4) return false;
    const [ts, nonce, cc, sig] = parts;

    if (Date.now() - parseInt(ts, 10) > AUTH_CODE_TTL_MS) return false;

    const payload = `${ts}.${nonce}.${cc}`;
    if (!await hmacVerify(secret, `code:${payload}`, sig)) return false;

    // PKCE: SHA-256(code_verifier) must equal code_challenge
    const verifierHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(codeVerifier),
    );
    const computed = b64url(new Uint8Array(verifierHash));
    const expected = new TextDecoder().decode(b64urlDecode(cc));
    return constantTimeEqual(computed, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Access tokens  (valid ACCESS_TOKEN_TTL_MS)
// Format: {ts}.{nonce}.{hmac}
// ---------------------------------------------------------------------------

export async function generateAccessToken(secret: string): Promise<string> {
  const ts = Date.now().toString();
  const nonce = randomNonce();
  const payload = `${ts}.${nonce}`;
  const sig = await hmacSign(secret, `token:${payload}`);
  return `${payload}.${sig}`;
}

export async function validateAccessToken(secret: string, token: string): Promise<boolean> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [ts, nonce, sig] = parts;

    if (Date.now() - parseInt(ts, 10) > ACCESS_TOKEN_TTL_MS) return false;

    const payload = `${ts}.${nonce}`;
    return hmacVerify(secret, `token:${payload}`, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// OAuth server metadata (RFC 8414)
// ---------------------------------------------------------------------------

export function oauthMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
  };
}

// ---------------------------------------------------------------------------
// Authorization page HTML
// ---------------------------------------------------------------------------

export function authorizePage(params: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  clientId: string;
  error?: boolean;
}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BookStack MCP — Authorize</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #f3f4f6; font-family: system-ui, sans-serif;
    }
    .card {
      background: #fff; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,.1);
      padding: 2rem; width: 360px; max-width: 90vw;
    }
    h1 { font-size: 1.25rem; margin: 0 0 .5rem; color: #111; }
    p  { color: #555; font-size: .9rem; margin: 0 0 1.5rem; }
    .error { color: #dc2626; font-size: .85rem; margin-bottom: 1rem; }
    label { font-size: .85rem; font-weight: 600; color: #374151; }
    input[type=password] {
      display: block; width: 100%; margin: .4rem 0 1.25rem;
      padding: .6rem .75rem; border: 1px solid #d1d5db;
      border-radius: 6px; font-size: 1rem;
    }
    input[type=password]:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
    button {
      width: 100%; padding: .7rem;
      background: #2563eb; color: #fff; border: none;
      border-radius: 6px; font-size: 1rem; font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>BookStack MCP</h1>
    <p>Claude is requesting access to your BookStack instance. Enter your MCP access password to authorize.</p>
    ${params.error ? '<p class="error">Incorrect password — try again.</p>' : ''}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="redirect_uri"    value="${esc(params.redirectUri)}" />
      <input type="hidden" name="state"           value="${esc(params.state)}" />
      <input type="hidden" name="code_challenge"  value="${esc(params.codeChallenge)}" />
      <input type="hidden" name="client_id"       value="${esc(params.clientId)}" />
      <label for="pw">Access Password</label>
      <input type="password" id="pw" name="password" autofocus autocomplete="current-password" />
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

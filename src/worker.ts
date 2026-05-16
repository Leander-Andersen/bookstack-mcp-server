import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BookStackMCPServer } from './server';
import { WorkerEnv, buildConfigFromEnv } from './config/worker-config';
import {
  oauthMetadata,
  authorizePage,
  generateAuthCode,
  validateAuthCode,
  generateAccessToken,
  validateAccessToken,
  isAllowedRedirectUri,
} from './utils/oauth';

export type { WorkerEnv as Env };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_VERSION = '1.2.5';
const VERSION_HEADER = { 'X-MCP-Server-Version': SERVER_VERSION };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...VERSION_HEADER },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...VERSION_HEADER },
  });
}

/**
 * Bridge between Cloudflare Workers native Request/Response and the
 * Express-style req/res that StreamableHTTPServerTransport.handleRequest() expects.
 */
async function handleMCPRequest(
  transport: StreamableHTTPServerTransport,
  request: Request,
  body: unknown,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = { ...VERSION_HEADER };
    let statusCode = 200;
    let responseBody = '';
    let settled = false;

    function doResolve() {
      if (!settled) {
        settled = true;
        resolve(new Response(responseBody || null, { status: statusCode, headers }));
      }
    }

    const res: any = {
      get statusCode() { return statusCode; },
      set statusCode(v: number) { statusCode = v; },
      setHeader(key: string, value: string) { headers[key] = value; },
      getHeader(key: string) { return headers[key]; },
      write(chunk: string | Uint8Array) {
        responseBody += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      },
      end(data?: string | Uint8Array) {
        if (data) responseBody += typeof data === 'string' ? data : new TextDecoder().decode(data);
        doResolve();
      },
      status(code: number) { statusCode = code; return res; },
      json(data: unknown) {
        headers['Content-Type'] = 'application/json';
        res.end(JSON.stringify(data));
      },
      send(data: string) { res.end(data); },
      writeHead(code: number, hdrs?: Record<string, string | string[]>) {
        statusCode = code;
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) {
            headers[k] = Array.isArray(v) ? v[v.length - 1] : v;
          }
        }
        return res;
      },
      removeHeader(key: string) { delete headers[key]; },
      hasHeader(key: string) { return key in headers; },
      flushHeaders() {},
      writableEnded: false,
      headersSent: false,
      // EventEmitter stubs — transport calls res.on('close', ...) for SSE cleanup
      on(_event: string, _listener: (...args: unknown[]) => void) { return res; },
      once(_event: string, _listener: (...args: unknown[]) => void) { return res; },
      off(_event: string, _listener: (...args: unknown[]) => void) { return res; },
      removeListener(_event: string, _listener: (...args: unknown[]) => void) { return res; },
      emit(_event: string, ..._args: unknown[]) { return false; },
    };

    const req: any = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      url: new URL(request.url).pathname,
    };

    transport.handleRequest(req, res, body)
      .then(() => {
        // For GET/SSE the transport stores res but never calls end() — resolve here.
        // For POST the transport calls res.end() asynchronously after processing,
        // so doResolve() there would fire too early (before the response is ready).
        if (request.method === 'GET' || request.method === 'DELETE') doResolve();
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Diagnostic / debug log
// Writes timestamped events to KV under `debug:oauth:{ts}-{nonce}` with 1h TTL.
// Inspectable via GET /debug/oauth-log?key=MCP_API_KEY.
// ---------------------------------------------------------------------------

const DEBUG_KEY_PREFIX = 'debug:oauth:';
const DEBUG_TTL_SECONDS = 3600; // 1 hour

async function recordOAuthEvent(
  env: WorkerEnv,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  const kv = env.BOOKSTACK_DIAGNOSTIC_KV;
  if (!kv) return;
  const ts = new Date().toISOString();
  // Reverse-sortable key — newest first when listed.
  const sortKey = (9999999999999 - Date.now()).toString().padStart(13, '0');
  const random = Math.random().toString(36).slice(2, 8);
  const key = `${DEBUG_KEY_PREFIX}${sortKey}-${random}`;
  try {
    await kv.put(
      key,
      JSON.stringify({ ts, type, ...data }),
      { expirationTtl: DEBUG_TTL_SECONDS },
    );
  } catch (e) {
    console.error('debug log write failed', e);
  }
}

async function readOAuthEvents(env: WorkerEnv, limit = 50): Promise<unknown[]> {
  const kv = env.BOOKSTACK_DIAGNOSTIC_KV;
  if (!kv) return [];
  const list = await kv.list({ prefix: DEBUG_KEY_PREFIX, limit });
  const events = await Promise.all(
    list.keys.map(async k => {
      const raw = await kv.get(k.name);
      return raw ? JSON.parse(raw) : null;
    }),
  );
  return events.filter(Boolean);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Main Worker
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    // ── Public routes (no auth) ─────────────────────────────────────────────

    // Health check
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ status: 'ok' });
    }

    // Diagnostic endpoint — returns recent OAuth events from KV.
    // Gated by ?key=<MCP_API_KEY> using constant-time compare.
    if (url.pathname === '/debug/oauth-log' && request.method === 'GET') {
      const apiKey = env.MCP_API_KEY;
      const supplied = url.searchParams.get('key') ?? '';
      if (!apiKey || !constantTimeEq(supplied, apiKey.trim())) {
        return new Response('Unauthorized', { status: 401, headers: VERSION_HEADER });
      }
      const events = await readOAuthEvents(env, 100);
      return json({ count: events.length, events });
    }

    // OAuth server metadata (RFC 8414) — Claude.ai fetches this to discover endpoints
    if (url.pathname === '/.well-known/oauth-authorization-server' && request.method === 'GET') {
      return json(oauthMetadata(baseUrl));
    }

    // OAuth protected resource metadata (RFC 9728) — tells clients which auth server protects this resource
    if (
      (url.pathname === '/.well-known/oauth-protected-resource' ||
       url.pathname.startsWith('/.well-known/oauth-protected-resource/')) &&
      request.method === 'GET'
    ) {
      return json({
        resource: baseUrl,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ['header'],
      });
    }

    // OAuth authorization endpoint — show login page (GET) or process it (POST)
    if (url.pathname === '/oauth/authorize') {
      const apiKey = env.MCP_API_KEY;
      if (!apiKey) return json({ error: 'server_error', error_description: 'MCP_API_KEY not configured' }, 500);

      if (request.method === 'GET') {
        const redirectUri   = url.searchParams.get('redirect_uri') ?? '';
        const state         = url.searchParams.get('state') ?? '';
        const codeChallenge = url.searchParams.get('code_challenge') ?? '';
        const clientId      = url.searchParams.get('client_id') ?? '';

        await recordOAuthEvent(env, 'authorize_get', {
          redirectUri, clientId,
          hasState: !!state,
          hasCodeChallenge: !!codeChallenge,
          codeChallengeLen: codeChallenge.length,
        });

        // Reject untrusted redirect targets BEFORE showing the password form.
        if (!isAllowedRedirectUri(redirectUri)) {
          await recordOAuthEvent(env, 'authorize_get_rejected', { reason: 'redirect_uri_not_allowed', redirectUri });
          return json({
            error: 'invalid_request',
            error_description: 'redirect_uri is not on the allow-list (claude.ai / claude.com only)',
          }, 400);
        }

        return html(authorizePage({ redirectUri, state, codeChallenge, clientId }));
      }

      if (request.method === 'POST') {
        const body = await request.formData();
        const password      = (body.get('password') as string ?? '').trim();
        const redirectUri   = body.get('redirect_uri') as string ?? '';
        const state         = body.get('state') as string ?? '';
        const codeChallenge = body.get('code_challenge') as string ?? '';
        const clientId      = body.get('client_id') as string ?? '';

        // Re-check on POST — a malicious page could craft a form that bypasses
        // the GET check by submitting directly with its own redirect_uri.
        if (!isAllowedRedirectUri(redirectUri)) {
          return json({ error: 'invalid_request', error_description: 'redirect_uri not allowed' }, 400);
        }

        // Validate the password against MCP_API_KEY (trim both to avoid whitespace/newline issues)
        const encoder = new TextEncoder();
        const aBytes = encoder.encode(password);
        const bBytes = encoder.encode(apiKey.trim());
        let diff = aBytes.length === bBytes.length ? 0 : 1;
        const len = Math.min(aBytes.length, bBytes.length);
        for (let i = 0; i < len; i++) diff |= aBytes[i] ^ bBytes[i];

        if (diff !== 0) {
          await recordOAuthEvent(env, 'authorize_post_bad_password', { clientId, redirectUri });
          return html(authorizePage({ redirectUri, state, codeChallenge, clientId, error: true }));
        }

        // Correct password — generate auth code bound to redirect_uri and redirect.
        // (We intentionally don't bind client_id — see generateAuthCode docstring.)
        const code = await generateAuthCode(apiKey, codeChallenge, redirectUri);
        const codeNonce = code.split('.')[1];
        await recordOAuthEvent(env, 'authorize_post_ok', {
          clientId, redirectUri, codeNonce,
          hasCodeChallenge: !!codeChallenge,
        });
        const redirect = new URL(redirectUri);
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', state);
        return Response.redirect(redirect.toString(), 302);
      }

      return new Response('Method Not Allowed', { status: 405 });
    }

    // OAuth token endpoint — exchange auth code for access token
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      const apiKey = env.MCP_API_KEY;
      if (!apiKey) return json({ error: 'server_error' }, 500);

      let params: URLSearchParams;
      const ct = request.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        const body = await request.json() as Record<string, string>;
        params = new URLSearchParams(body);
      } else {
        params = new URLSearchParams(await request.text());
      }

      const grantType    = params.get('grant_type');
      const code         = params.get('code') ?? '';
      const codeVerifier = params.get('code_verifier') ?? '';
      const redirectUri  = params.get('redirect_uri') ?? '';
      const clientId     = params.get('client_id') ?? '';
      const codeNonce    = code.split('.')[1] ?? '(none)';

      await recordOAuthEvent(env, 'token_request', {
        grantType,
        hasCode: !!code,
        codeNonce,
        hasVerifier: !!codeVerifier,
        codeVerifierLen: codeVerifier.length,
        redirectUri,
        clientId,
        contentType: ct,
        allParamKeys: Array.from(params.keys()),
      });

      if (grantType !== 'authorization_code') {
        await recordOAuthEvent(env, 'token_rejected', { reason: 'unsupported_grant_type', grantType });
        return json({ error: 'unsupported_grant_type' }, 400);
      }

      // Validate HMAC + PKCE + (implicitly) redirect_uri binding.
      const result = await validateAuthCode(apiKey, code, codeVerifier, redirectUri);
      if (!result.ok) {
        await recordOAuthEvent(env, 'token_rejected', {
          reason: result.reason,
          detail: result.detail,
          redirectUri,
          codeNonce,
        });
        return json({ error: 'invalid_grant', error_description: `Invalid or expired authorization code (${result.reason})` }, 400);
      }

      // Single-use enforcement via KV. The auth-code TTL is 5 minutes, so KV
      // keys auto-expire after 5 minutes too — no cleanup needed.
      if (env.BOOKSTACK_KV) {
        const consumedKey = `code-used:${result.nonce}`;
        const already = await env.BOOKSTACK_KV.get(consumedKey);
        if (already) {
          await recordOAuthEvent(env, 'token_rejected', { reason: 'code_already_used', codeNonce: result.nonce });
          return json({ error: 'invalid_grant', error_description: 'Authorization code already used' }, 400);
        }
        await env.BOOKSTACK_KV.put(consumedKey, '1', { expirationTtl: 300 });
      }

      await recordOAuthEvent(env, 'token_issued', { codeNonce: result.nonce, redirectUri, clientId });

      const accessToken = await generateAccessToken(apiKey);
      return json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }

    // ── Protected routes (Bearer token required) ────────────────────────────

    const apiKey = env.MCP_API_KEY;
    if (!apiKey) return json({ error: 'server_error' }, 500);

    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      await recordOAuthEvent(env, 'mcp_unauthorized', {
        reason: 'no_bearer',
        path: url.pathname,
        method: request.method,
      });
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="BookStack MCP"', ...VERSION_HEADER },
      });
    }

    const token = authHeader.slice('Bearer '.length);
    const tokenValid = await validateAccessToken(apiKey, token);
    if (!tokenValid) {
      await recordOAuthEvent(env, 'mcp_unauthorized', {
        reason: 'invalid_token',
        path: url.pathname,
        method: request.method,
        tokenPreview: token.slice(0, 8) + '...' + token.slice(-4),
        tokenLen: token.length,
      });
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="BookStack MCP", error="invalid_token"', ...VERSION_HEADER },
      });
    }

    // MCP endpoint
    if (url.pathname !== '/mcp' && url.pathname !== '/message') {
      await recordOAuthEvent(env, 'mcp_not_found', { path: url.pathname, method: request.method });
      return new Response('Not Found', { status: 404, headers: VERSION_HEADER });
    }

    if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST, DELETE', ...VERSION_HEADER } });
    }

    let body: unknown;
    if (request.method === 'POST') {
      try {
        body = await request.json();
      } catch {
        await recordOAuthEvent(env, 'mcp_bad_json', { path: url.pathname });
        return new Response('Bad Request: invalid JSON', { status: 400 });
      }
    }

    // Log the MCP request shape — the method/id from JSON-RPC bodies is the
    // most useful single clue when something fails after authentication.
    const rpcMethod = (body as any)?.method ?? null;
    const rpcId = (body as any)?.id ?? null;
    await recordOAuthEvent(env, 'mcp_request', {
      path: url.pathname,
      httpMethod: request.method,
      rpcMethod,
      rpcId,
    });

    const config = buildConfigFromEnv(env);

    try {
      const mcpServer = new BookStackMCPServer(config);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      });
      // SDK type mismatch: StreamableHTTPServerTransport.onclose is optional,
      // but Transport.onclose is required under exactOptionalPropertyTypes.
      transport.onclose = () => {};
      await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0]);
      const response = await handleMCPRequest(transport, request, body);
      await recordOAuthEvent(env, 'mcp_response', {
        rpcMethod,
        rpcId,
        status: response.status,
      });
      return response;
    } catch (error) {
      console.error('Worker MCP request failed:', error);
      await recordOAuthEvent(env, 'mcp_error', {
        rpcMethod,
        rpcId,
        error: String(error),
        stack: (error as Error)?.stack?.slice(0, 500),
      });
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

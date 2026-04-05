import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BookStackMCPServer } from './server';
import { ConfigManager } from './config/manager';
import { WorkerEnv, buildConfigFromEnv, seedProcessEnv } from './config/worker-config';
import {
  oauthMetadata,
  authorizePage,
  generateAuthCode,
  validateAuthCode,
  generateAccessToken,
  validateAccessToken,
} from './utils/oauth';

export type { WorkerEnv as Env };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
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
    const headers: Record<string, string> = {};
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

    // For GET (SSE), the transport stores res and never calls end().
    // Resolve after handleRequest returns so the Worker doesn't hang.
    transport.handleRequest(req, res, body)
      .then(() => doResolve())
      .catch(reject);
  });
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
        return html(authorizePage({ redirectUri, state, codeChallenge, clientId }));
      }

      if (request.method === 'POST') {
        const body = await request.formData();
        const password      = (body.get('password') as string ?? '').trim();
        const redirectUri   = body.get('redirect_uri') as string ?? '';
        const state         = body.get('state') as string ?? '';
        const codeChallenge = body.get('code_challenge') as string ?? '';
        const clientId      = body.get('client_id') as string ?? '';

        // Validate the password against MCP_API_KEY (trim both to avoid whitespace/newline issues)
        const encoder = new TextEncoder();
        const aBytes = encoder.encode(password);
        const bBytes = encoder.encode(apiKey.trim());
        let diff = aBytes.length === bBytes.length ? 0 : 1;
        const len = Math.min(aBytes.length, bBytes.length);
        for (let i = 0; i < len; i++) diff |= aBytes[i] ^ bBytes[i];

        if (diff !== 0) {
          return html(authorizePage({ redirectUri, state, codeChallenge, clientId, error: true }));
        }

        // Correct password — generate auth code and redirect back to Claude
        const code = await generateAuthCode(apiKey, codeChallenge);
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

      if (grantType !== 'authorization_code') {
        return json({ error: 'unsupported_grant_type' }, 400);
      }

      const valid = await validateAuthCode(apiKey, code, codeVerifier);
      console.log('[oauth/token] validateAuthCode result:', valid, 'grant_type:', grantType, 'code_len:', code.length, 'verifier_len:', codeVerifier.length);
      if (!valid) {
        return json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' }, 400);
      }

      const accessToken = await generateAccessToken(apiKey);
      console.log('[oauth/token] issued token, first 20 chars:', accessToken.slice(0, 20));
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
    console.log('[auth] path:', url.pathname, 'has_bearer:', authHeader.startsWith('Bearer '));
    if (!authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="BookStack MCP"' },
      });
    }

    const token = authHeader.slice('Bearer '.length);
    const tokenValid = await validateAccessToken(apiKey, token);
    console.log('[auth] validateAccessToken result:', tokenValid, 'token_first_20:', token.slice(0, 20));
    if (!tokenValid) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="BookStack MCP", error="invalid_token"' },
      });
    }

    // MCP endpoint
    if (url.pathname !== '/mcp' && url.pathname !== '/message') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method !== 'POST' && request.method !== 'GET' && request.method !== 'DELETE') {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST, DELETE' } });
    }

    // Seed process.env + reset ConfigManager so server-info.ts tools work
    seedProcessEnv(env);
    ConfigManager.reset();

    let body: unknown;
    if (request.method === 'POST') {
      try {
        body = await request.json();
      } catch {
        return new Response('Bad Request: invalid JSON', { status: 400 });
      }
    }

    const config = buildConfigFromEnv(env);

    try {
      const mcpServer = new BookStackMCPServer({ bookstack: config.bookstack });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcpServer.connect(transport);
      return await handleMCPRequest(transport, request, body);
    } catch (error) {
      console.error('Worker MCP request failed:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};

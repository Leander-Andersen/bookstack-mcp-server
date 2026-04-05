import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BookStackMCPServer } from './server';
import { ConfigManager } from './config/manager';
import { WorkerEnv, buildConfigFromEnv, seedProcessEnv } from './config/worker-config';

export type { WorkerEnv as Env };

/**
 * Timing-safe string comparison to prevent timing attacks on the API key.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

/**
 * Bridge between Cloudflare Workers native Request/Response and the
 * Express-style req/res that StreamableHTTPServerTransport.handleRequest()
 * expects.
 */
async function handleMCPRequest(
  transport: StreamableHTTPServerTransport,
  request: Request,
  body: unknown
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let responseBody = '';

    const res: any = {
      get statusCode() { return statusCode; },
      set statusCode(v: number) { statusCode = v; },
      setHeader(key: string, value: string) { headers[key] = value; },
      getHeader(key: string) { return headers[key]; },
      write(chunk: string | Uint8Array) {
        responseBody += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      },
      end(data?: string | Uint8Array) {
        if (data) {
          responseBody += typeof data === 'string' ? data : new TextDecoder().decode(data);
        }
        resolve(new Response(responseBody, { status: statusCode, headers }));
      },
      status(code: number) { statusCode = code; return res; },
      json(data: unknown) {
        headers['Content-Type'] = 'application/json';
        res.end(JSON.stringify(data));
      },
      send(data: string) { res.end(data); },
      writableEnded: false,
      headersSent: false,
    };

    const req: any = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      url: new URL(request.url).pathname,
    };

    transport.handleRequest(req, res, body).catch(reject);
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // --- 1. Validate MCP_API_KEY ---
    const expectedKey = env.MCP_API_KEY;
    if (!expectedKey) {
      return new Response('Server misconfigured: MCP_API_KEY secret not set', { status: 500 });
    }

    const authHeader = request.headers.get('Authorization') ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="BookStack MCP"' },
      });
    }

    const providedKey = authHeader.slice('Bearer '.length);
    if (!timingSafeEqual(providedKey, expectedKey)) {
      return new Response('Unauthorized', { status: 401 });
    }

    // --- 2. Route handling ---
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname !== '/mcp' && url.pathname !== '/message') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'POST' },
      });
    }

    // --- 3. Seed process.env + reset ConfigManager singleton ---
    // ConfigManager reads process.env in its constructor. In CF Workers,
    // process.env is an empty object by default (nodejs_compat_v2), so we
    // populate it from the Worker secrets before each request.
    seedProcessEnv(env);
    ConfigManager.reset();

    // --- 4. Parse request body ---
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response('Bad Request: invalid JSON body', { status: 400 });
    }

    // --- 5. Build BookStack config from env and construct MCP server ---
    const config = buildConfigFromEnv(env);

    try {
      const mcpServer = new BookStackMCPServer({
        bookstack: config.bookstack,
      });

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

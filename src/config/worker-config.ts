import { Config } from './manager';

/**
 * Cloudflare Worker environment bindings
 */
export interface WorkerEnv {
  BOOKSTACK_BASE_URL: string;
  BOOKSTACK_API_TOKEN: string;
  MCP_API_KEY: string;
  SERVER_NAME?: string;
  SERVER_VERSION?: string;
}

/**
 * Build a Config object directly from the CF Worker env bindings.
 * This avoids any dotenv / process.env dependency in the Worker path.
 */
export function buildConfigFromEnv(env: WorkerEnv): Config {
  return {
    bookstack: {
      baseUrl: env.BOOKSTACK_BASE_URL,
      apiToken: env.BOOKSTACK_API_TOKEN,
      timeout: 30000,
    },
    server: {
      name: env.SERVER_NAME ?? 'bookstack-mcp-server',
      version: env.SERVER_VERSION ?? '1.0.0',
      port: 3000,
    },
    rateLimit: {
      requestsPerMinute: 60,
      burstLimit: 10,
    },
    validation: {
      enabled: true,
      strictMode: false,
    },
    logging: {
      level: 'info',
      format: 'json',
    },
    context7: {
      enabled: false,
      libraryId: '/bookstack/bookstack',
      cacheTtl: 3600,
    },
    security: {
      corsEnabled: false,
      corsOrigin: '*',
      helmetEnabled: false,
    },
    development: {
      nodeEnv: 'production',
      debug: false,
    },
  };
}

/**
 * Seed process.env from Worker env bindings so that ConfigManager
 * (used internally by server-info.ts tools) can read configuration.
 * Called once at the start of each Worker fetch() invocation.
 */
export function seedProcessEnv(env: WorkerEnv): void {
  const p = process.env as Record<string, string>;
  p['BOOKSTACK_BASE_URL'] = env.BOOKSTACK_BASE_URL;
  p['BOOKSTACK_API_TOKEN'] = env.BOOKSTACK_API_TOKEN;
  p['SERVER_NAME'] = env.SERVER_NAME ?? 'bookstack-mcp-server';
  p['SERVER_VERSION'] = env.SERVER_VERSION ?? '1.0.0';
  p['NODE_ENV'] = 'production';
  p['LOG_LEVEL'] = 'info';
  p['LOG_FORMAT'] = 'json';
  p['VALIDATION_ENABLED'] = 'true';
  p['VALIDATION_STRICT_MODE'] = 'false';
  p['RATE_LIMIT_REQUESTS_PER_MINUTE'] = '60';
  p['RATE_LIMIT_BURST_LIMIT'] = '10';
}

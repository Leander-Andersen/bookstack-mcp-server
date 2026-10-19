/// <reference types="@cloudflare/workers-types" />
/**
 * The MCP audit trail: every tool call and every authentication event this
 * server handles, written to its own tables in the shared audit D1 database
 * (AUDIT_DB) -- see migrate.ts for the layout.
 *
 * This is not BookStack's own audit log (that is `bookstack_audit_log_list`,
 * which reads what happened inside BookStack). This one records what was asked
 * of *this MCP server*, by which token, from where, and what came back.
 *
 * Modelled on proxmox-mcp-server's auditor, and written to the same table
 * layout so ULV (the unified-logging-and-visualisation viewer) can display
 * it. Three properties carry over:
 *
 *   1. Logging never changes the outcome of the thing being logged. Writes go
 *      through waitUntil and a failure is a console.error, never a failed call.
 *   2. Nothing that is itself a credential is logged. Only the bearer token's
 *      nonce is kept; secret-looking argument keys are redacted.
 *   3. It is a single choke point -- the CallTool handler in server.ts -- so a
 *      tool added later is logged without anyone remembering to log it.
 */

import { ensureSchemaOnce, tablesFor, type InstanceManifest } from './migrate';

// --- Settings ------------------------------------------------------------------

export interface AuditSettings {
  /**
   * Prefix for this instance's tables in the shared audit database
   * (<id>_tool_calls, <id>_auth_events). Give each deployment its own id --
   * two BookStack servers logging into one database need two ids.
   */
  instanceId: string;
  /** Human name shown by viewers. */
  displayName: string;
  /** Master switch. Default on whenever the database is bound. */
  enabled: boolean;
  /** Record read-only calls too. Mutations are always recorded. */
  logReads: boolean;
  /** Cap per stored text field (arguments, result, error). */
  maxFieldChars: number;
}

export interface AuditEnv {
  AUDIT_INSTANCE_ID?: string;
  AUDIT_DISPLAY_NAME?: string;
  AUDIT_ENABLED?: string;
  AUDIT_LOG_READS?: string;
  AUDIT_MAX_FIELD_CHARS?: string;
}

function intSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? NaN : parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function auditSettingsFromEnv(env: AuditEnv): AuditSettings {
  return {
    // Validated where it is turned into table names (tablesFor), so a bad
    // value fails the audit write, never the request.
    instanceId: (env.AUDIT_INSTANCE_ID ?? 'bookstack').trim(),
    displayName: env.AUDIT_DISPLAY_NAME?.trim() || 'BookStack',
    enabled: env.AUDIT_ENABLED !== 'false',
    logReads: env.AUDIT_LOG_READS !== 'false',
    maxFieldChars: intSetting(env.AUDIT_MAX_FIELD_CHARS, 8_000, 500, 200_000),
  };
}

// --- Actor identification -----------------------------------------------------

export interface ActorContext {
  requestId: string;
  actorNonce?: string | undefined;
  actorIssued?: number | undefined;
  clientId?: string | undefined;
  ip?: string | undefined;
  country?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Splits an access token (`issuedAt.nonce.hmac`) into the parts that are safe
 * to keep. The HMAC is a live credential and is never stored.
 */
export function actorFromToken(token: string): { nonce?: string | undefined; issued?: number | undefined } {
  const parts = token.split('.');
  if (parts.length !== 3) return {};
  const issued = parseInt(parts[0], 10);
  return { nonce: parts[1], issued: Number.isFinite(issued) ? issued : undefined };
}

export function actorFromRequest(request: Request, requestId: string): ActorContext {
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const { nonce, issued } = token ? actorFromToken(token) : {};
  return {
    requestId,
    actorNonce: nonce,
    actorIssued: issued,
    ip: request.headers.get('CF-Connecting-IP') ?? undefined,
    country: (request as { cf?: { country?: string } }).cf?.country ?? undefined,
    userAgent: request.headers.get('User-Agent')?.slice(0, 300) ?? undefined,
  };
}

// --- Redaction and capping ------------------------------------------------------

const SECRET_KEY = /pass(?:wd|word)?|secret|token|credential|api[_-]?key|private[_-]?key|^auth/i;

/**
 * Upload payloads (base64 attachments and images). Not secret, but megabytes
 * of base64 are worthless in a log and would blow through the field cap.
 */
const BLOB_KEY = /^(file|image)$/i;

const MAX_REDACT_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) out[k] = '[redacted]';
    else if (BLOB_KEY.test(k) && typeof v === 'string') out[k] = `[${v.length} chars omitted]`;
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

/** Trims to `max` characters keeping both ends -- the head says what, the tail how it ended. */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const notice = (omitted: number) => `\n... [${omitted} of ${text.length} characters omitted] ...\n`;
  const budget = Math.max(0, max - notice(text.length).length);
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return text.slice(0, head) + notice(text.length - budget) + (tail > 0 ? text.slice(-tail) : '');
}

// --- Classifying a call ---------------------------------------------------------

type Args = Record<string, unknown> | undefined;

/** Tool-name suffixes that change something in BookStack. */
const MUTATING_ACTION = /_(create|update|delete|restore|delete_permanently)$/;

export function isMutating(tool: string): boolean {
  return MUTATING_ACTION.test(tool);
}

/** bookstack_<resource>_<action> resource segment → entity name used in targets. */
const ENTITY: Record<string, string> = {
  books: 'book',
  pages: 'page',
  chapters: 'chapter',
  shelves: 'shelf',
  users: 'user',
  roles: 'role',
  attachments: 'attachment',
  images: 'image',
  recyclebin: 'recyclebin',
};

/** A short human-readable description of what the call acted on, e.g. "page:12". */
export function describeTarget(tool: string, args: Args): string | undefined {
  if (!args) return undefined;

  if (tool === 'bookstack_permissions_read' || tool === 'bookstack_permissions_update') {
    if (typeof args.content_type === 'string' && args.content_id !== undefined) {
      return `${args.content_type}:${args.content_id}`;
    }
  }

  if (tool === 'bookstack_search' && typeof args.query === 'string') {
    return `search:${args.query.slice(0, 100)}`;
  }

  const resource = /^bookstack_([a-z]+)_/.exec(tool)?.[1];
  const entity = resource ? ENTITY[resource] : undefined;
  const id = args.id ?? args.deletion_id;
  if (entity && (typeof id === 'number' || typeof id === 'string')) return `${entity}:${id}`;

  // Creates have no id yet; the parent they were created in is the next best thing.
  for (const parent of ['chapter_id', 'book_id', 'uploaded_to'] as const) {
    const value = args[parent];
    if (typeof value === 'number' || typeof value === 'string') {
      const parentEntity = parent === 'uploaded_to' ? 'page' : parent.replace('_id', '');
      return `${parentEntity}:${value}`;
    }
  }
  return undefined;
}

/** Past / infinitive verbs per tool action, for the registry's manifest. */
const VERBS: Record<string, [string, string]> = {
  list: ['Listed', 'list'],
  read: ['Read', 'read'],
  create: ['Created', 'create'],
  update: ['Updated', 'update'],
  delete: ['Deleted', 'delete'],
  delete_permanently: ['Permanently deleted', 'permanently delete'],
  restore: ['Restored', 'restore'],
  export: ['Exported', 'export'],
};

/**
 * How a viewer should phrase a call to this tool: "Deleted page 12", or, when
 * the call has no target, "Listed books". Optional fields in the registry's
 * tools_json -- a viewer that ignores them falls back to a generic sentence.
 */
export function toolPhrasing(tool: string): { past?: string; infinitive?: string; object?: string } {
  if (tool === 'bookstack_search') return { past: 'Searched', infinitive: 'search', object: 'BookStack' };
  const match = /^bookstack_([a-z]+)_(.+)$/.exec(tool);
  if (!match) return {};
  const [, resource, action] = match;
  const verbs = VERBS[action];
  if (!verbs) return {};
  const object = resource === 'recyclebin' ? 'the recycle bin' : action === 'list' ? resource : `a ${ENTITY[resource] ?? resource}`;
  return { past: verbs[0], infinitive: verbs[1], object };
}

// --- The auditor ------------------------------------------------------------------

export interface ToolCallRecord {
  tool: string;
  args: Args;
  /** The tool's raw return value (before the untrusted-data wrapper). */
  result?: unknown;
  error?: unknown;
  /** Set when the call never reached a handler (e.g. unknown tool). */
  rejected?: string | undefined;
  durationMs: number;
}

export interface AuthEventFields {
  clientId?: string | undefined;
  tokenNonce?: string | undefined;
  detail?: string | undefined;
}

export class Auditor {
  constructor(
    private readonly db: D1Database | undefined,
    private readonly ctx: ExecutionContext | undefined,
    private readonly actor: ActorContext,
    private readonly settings: AuditSettings,
  ) {}

  /** Tool metadata for the registry; set once the MCP server has registered its tools. */
  private toolList: InstanceManifest['tools'];

  setTools(tools: InstanceManifest['tools']): void {
    this.toolList = tools;
  }

  /** Registry entry describing this instance: what it logs and what its tools mean. */
  manifest(): InstanceManifest {
    return instanceManifest(this.settings, this.toolList);
  }

  private async ready(db: D1Database) {
    const tables = tablesFor(this.settings.instanceId);
    await ensureSchemaOnce(db, tables, () => this.manifest());
    return tables;
  }

  get configured(): boolean {
    return Boolean(this.db);
  }

  /** Fire-and-forget: waitUntil keeps the isolate alive without delaying the response. */
  private enqueue(work: () => Promise<unknown>): void {
    const promise = work().catch((e) => {
      console.error(`audit: write failed (${e instanceof Error ? e.message : String(e)})`);
    });
    this.ctx?.waitUntil(promise);
  }

  toolCall(record: ToolCallRecord): void {
    const db = this.db;
    if (!db || !this.settings.enabled) return;

    const mutating = isMutating(record.tool);
    // Turning off read logging is a volume decision; the record of what
    // changed cannot be turned off short of disabling the log entirely.
    if (!mutating && !this.settings.logReads) return;

    this.enqueue(async () => {
      const limit = this.settings.maxFieldChars;
      const argsJson = record.args === undefined ? null : JSON.stringify(redact(record.args));
      const resultText =
        record.result === undefined
          ? ''
          : typeof record.result === 'string'
            ? record.result
            : JSON.stringify(record.result);

      const thrown = record.error !== undefined;
      const failed = record.rejected !== undefined || thrown;
      const errorText = record.rejected
        ? record.rejected
        : thrown
          ? record.error instanceof Error
            ? record.error.message
            : String(record.error)
          : null;

      const t = await this.ready(db);
      await db
        .prepare(
          `INSERT INTO ${t.toolCalls} (
             ts, request_id, actor_nonce, actor_issued, client_id, ip, country, user_agent,
             tool, mutating, sudo, target, args_json, args_bytes,
             status, duration_ms, result_json, result_bytes, error, upid
           ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`,
        )
        .bind(
          Date.now(),
          this.actor.requestId,
          this.actor.actorNonce ?? null,
          this.actor.actorIssued ?? null,
          this.actor.clientId ?? null,
          this.actor.ip ?? null,
          this.actor.country ?? null,
          this.actor.userAgent ?? null,
          record.tool,
          mutating ? 1 : 0,
          0,
          describeTarget(record.tool, record.args) ?? null,
          argsJson === null ? null : cap(argsJson, limit),
          argsJson === null ? null : argsJson.length,
          record.rejected !== undefined ? 'rejected' : failed ? 'error' : 'ok',
          record.durationMs,
          failed ? null : cap(resultText, limit),
          failed ? null : resultText.length,
          errorText === null ? null : cap(errorText, limit),
          null,
        )
        .run();
    });
  }

  authEvent(event: string, fields: AuthEventFields = {}): void {
    const db = this.db;
    if (!db || !this.settings.enabled) return;
    this.enqueue(async () => {
      const t = await this.ready(db);
      await db
        .prepare(
          `INSERT INTO ${t.authEvents} (ts, request_id, event, ip, country, user_agent, client_id, token_nonce, detail)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
        )
        .bind(
          Date.now(),
          this.actor.requestId,
          event,
          this.actor.ip ?? null,
          this.actor.country ?? null,
          this.actor.userAgent ?? null,
          fields.clientId ?? this.actor.clientId ?? null,
          fields.tokenNonce ?? null,
          fields.detail ?? null,
        )
        .run();
    });
  }
}

// --- Registry manifest ---------------------------------------------------------

/**
 * What goes into this instance's audit_instances row. Viewers read it to know
 * which tables to query, which events may be missing (logs_reads=false), and
 * how to label each tool.
 */
export function instanceManifest(
  settings: AuditSettings,
  tools?: InstanceManifest['tools'],
): InstanceManifest {
  return {
    displayName: settings.displayName,
    settings: {
      enabled: settings.enabled,
      logs_tool_calls: true,
      logs_reads: settings.logReads,
      logs_auth_events: true,
      max_field_chars: settings.maxFieldChars,
      redacts: ['secret-like argument keys', 'file/image upload payloads', 'bearer token signature'],
      unused_columns: ['sudo', 'upid', 'actor_label'],
    },
    tools,
  };
}

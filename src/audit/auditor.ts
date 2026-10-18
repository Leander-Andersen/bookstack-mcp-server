/// <reference types="@cloudflare/workers-types" />
/**
 * The MCP audit trail: every tool call and every authentication event this
 * server handles, sent to the owner's central log (ULV, the
 * "unified-logging-and-visualisation" Worker) over a service binding.
 *
 * This is not BookStack's own audit log (that is `bookstack_audit_log_list`,
 * which reads what happened inside BookStack). This one records what was asked
 * of *this MCP server*, by which token, from where, and what came back.
 *
 * Identity and storage are ULV's business: the binding's `props` in
 * wrangler.toml say which service we are, and ULV owns retention, indexing and
 * the viewer. All this file does is describe what happened, in ULV's event
 * format (CONTRACT.md section 2-4), and hand it over. Three properties:
 *
 *   1. Logging never changes the outcome of the thing being logged. Sending
 *      happens inside waitUntil; a failure is a console.warn, never a failed call.
 *   2. Nothing that is itself a credential is sent. Only the bearer token's
 *      nonce identifies the actor; secret-looking argument keys are redacted.
 *   3. It is a single choke point -- the CallTool handler in server.ts -- so a
 *      tool added later is logged without anyone remembering to log it.
 */

import { version as PACKAGE_VERSION } from '../../package.json';

// --- The ULV Source surface -----------------------------------------------------

export type EventStatus = 'ok' | 'error' | 'rejected' | 'denied';
export type EventKind = 'tool_call' | 'auth';
export type Risk = 'read' | 'change' | 'destructive' | 'root';

export interface LogEvent {
  uid: string;
  ts: number;
  kind: EventKind;
  name: string;
  status: EventStatus;
  mutating?: boolean;
  risk?: Risk;
  duration_ms?: number;
  target?: string;
  actor?: { id?: string; client?: string; ip?: string; country?: string; user_agent?: string };
  request_id?: string;
  summary?: string;
  error?: string;
  args?: unknown;
  result?: unknown;
}

export interface ManifestTool {
  name: string;
  title?: string;
  description?: string;
  category?: string;
  mutating?: boolean;
  risk?: Risk;
  past?: string;
  infinitive?: string;
  object?: string;
}

export interface Manifest {
  v: 1;
  display_name?: string;
  server?: string;
  version?: string;
  settings?: Record<string, string | number | boolean | null>;
  tools?: ManifestTool[];
}

export interface RecentQuery {
  limit?: number;
  before?: number;
  name?: string;
  status?: EventStatus;
  kind?: EventKind;
  since?: number;
}

export interface SourceError {
  ok: false;
  error: { code: string; message: string };
}

export interface LogResult {
  ok: true;
  service?: string;
  accepted?: number;
  duplicates?: number;
  rejected?: Array<{ index: number; uid?: string; reason: string }>;
}

export interface DescribeResult {
  ok: true;
  service: string;
  changed: boolean;
}

export interface RecentResult {
  ok: true;
  service: string;
  events: Array<Record<string, unknown>>;
  next_before: number | null;
}

/**
 * What the `LOGGER` service binding exposes (ULV's `Source` entrypoint). All
 * three methods resolve with `{ ok: false, error }` instead of throwing, but
 * the callers below defend against both.
 */
export interface SourceBinding {
  log(batch: { v: 1; events: LogEvent[] }): Promise<LogResult | SourceError>;
  describe(manifest: Manifest): Promise<DescribeResult | SourceError>;
  recent(query?: RecentQuery): Promise<RecentResult | SourceError>;
}

/** The server name ULV shows next to the display name. */
export const SERVER_NAME = 'bookstack-mcp-server';
export const AUDIT_SINK = 'unified-logging-and-visualisation';

/** The query tool reads the log back; its own output is not worth logging again. */
export const AUDIT_TOOL_NAME = 'bookstack_mcp_audit_log';

/** ULV accepts 100 events per batch. */
const MAX_BATCH = 100;
/** ULV truncates error text at 4,000 and `summary` is limited to 500 characters. */
const MAX_ERROR_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 500;
/** ULV stores args/result up to 32,000 characters. */
const ULV_FIELD_LIMIT = 32_000;

// --- Settings ---------------------------------------------------------------------

export interface AuditSettings {
  /** Name the log viewer shows for this server. */
  displayName: string;
  /** Master switch. Default on whenever the binding is present. */
  enabled: boolean;
  /** Send read-only calls too. Mutations and auth events are always sent. */
  logReads: boolean;
  /** Client-side cap per args/result/error field. */
  maxFieldChars: number;
}

/**
 * All optional, and meant to be set as dashboard variables (Workers ->
 * Settings -> Variables), NOT in wrangler.toml [vars], which would overwrite
 * the dashboard value on every deploy.
 */
export interface AuditEnv {
  AUDIT_ENABLED?: string | undefined;
  AUDIT_LOG_READS?: string | undefined;
  AUDIT_MAX_FIELD_CHARS?: string | undefined;
  AUDIT_DISPLAY_NAME?: string | undefined;
}

function intSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? NaN : parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function auditSettingsFromEnv(env: AuditEnv): AuditSettings {
  return {
    displayName: env.AUDIT_DISPLAY_NAME?.trim().slice(0, 60) || 'BookStack',
    enabled: env.AUDIT_ENABLED !== 'false',
    logReads: env.AUDIT_LOG_READS !== 'false',
    maxFieldChars: intSetting(env.AUDIT_MAX_FIELD_CHARS, 8_000, 500, ULV_FIELD_LIMIT),
  };
}

// --- Actor identification -------------------------------------------------------

export interface ActorContext {
  requestId: string;
  actorNonce?: string | undefined;
  clientId?: string | undefined;
  ip?: string | undefined;
  country?: string | undefined;
  userAgent?: string | undefined;
}

/** A nonce is random URL-safe text; anything else in that slot is not one. */
const NONCE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Splits an access token (`issuedAt.nonce.hmac`) into the part that is safe to
 * keep. The HMAC is a live credential and is never returned.
 */
export function actorFromToken(token: string): { nonce?: string | undefined } {
  const parts = token.split('.');
  if (parts.length !== 3) return {};
  return { nonce: NONCE_SHAPE.test(parts[1]) ? parts[1] : undefined };
}

export function actorFromRequest(request: Request, requestId: string): ActorContext {
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const { nonce } = token ? actorFromToken(token) : {};
  return {
    requestId,
    actorNonce: nonce,
    ip: request.headers.get('CF-Connecting-IP') ?? undefined,
    country: (request as { cf?: { country?: string } }).cf?.country ?? undefined,
    userAgent: request.headers.get('User-Agent')?.slice(0, 300) ?? undefined,
  };
}

// --- Redaction and capping ------------------------------------------------------

const SECRET_KEY =
  /pass(?:wd|word)?|secret|token|credential|api[_-]?key|private[_-]?key|authoriz|cookie|session|^auth/i;

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

/**
 * A JSON value ready to send: kept structured while it fits `max` characters,
 * otherwise reduced to a capped JSON string (a structured value cannot be cut
 * in the middle).
 */
export function fitJson(value: unknown, max: number): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return cap(value, max);
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return '[unserialisable]';
  }
  if (text === undefined) return undefined;
  return text.length <= max ? JSON.parse(text) : cap(text, max);
}

// --- Classifying a call ---------------------------------------------------------

type Args = Record<string, unknown> | undefined;

/** Tool-name suffixes that change something in BookStack. */
const MUTATING_ACTION = /_(create|update|delete|restore|delete_permanently)$/;

export function isMutating(tool: string): boolean {
  return MUTATING_ACTION.test(tool);
}

/** Same rule ULV applies to a manifest tool that omits `risk`. */
export function riskOf(tool: string): Risk {
  if (!isMutating(tool)) return 'read';
  return /delete|destroy|purge|permanent/.test(tool) ? 'destructive' : 'change';
}

/** bookstack_<resource>_<action> resource segment -> entity name used in targets. */
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
      return `${args.content_type}:${args.content_id}`.slice(0, 256);
    }
  }

  if (tool === 'bookstack_search' && typeof args.query === 'string') {
    return `search:${args.query.slice(0, 100)}`;
  }

  const resource = /^bookstack_([a-z]+)_/.exec(tool)?.[1];
  const entity = resource ? ENTITY[resource] : undefined;
  const id = args.id ?? args.deletion_id;
  if (entity && (typeof id === 'number' || typeof id === 'string')) return `${entity}:${id}`.slice(0, 256);

  // Creates have no id yet; the parent they were created in is the next best thing.
  for (const parent of ['chapter_id', 'book_id', 'uploaded_to'] as const) {
    const value = args[parent];
    if (typeof value === 'number' || typeof value === 'string') {
      const parentEntity = parent === 'uploaded_to' ? 'page' : parent.replace('_id', '');
      return `${parentEntity}:${value}`.slice(0, 256);
    }
  }
  return undefined;
}

/** Past / infinitive verbs per tool action, for the manifest. */
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
 * the call has no target, "Listed books". Optional fields in the manifest --
 * a viewer that ignores them falls back to a generic sentence.
 */
export function toolPhrasing(tool: string): { past?: string; infinitive?: string; object?: string } {
  if (tool === 'bookstack_search') return { past: 'Searched', infinitive: 'search', object: 'BookStack' };
  if (tool === AUDIT_TOOL_NAME) return { past: 'Searched', infinitive: 'search', object: 'the audit log' };
  const match = /^bookstack_([a-z]+)_(.+)$/.exec(tool);
  if (!match) return {};
  const [, resource, action] = match;
  const verbs = VERBS[action];
  if (!verbs) return {};
  const object = resource === 'recyclebin' ? 'the recycle bin' : action === 'list' ? resource : `a ${ENTITY[resource] ?? resource}`;
  return { past: verbs[0], infinitive: verbs[1], object };
}

/** Auth events that are a refusal of access, as opposed to a normal step. */
const DENIED_EVENTS = new Set([
  'authorize_fail',
  'authorize_rejected',
  'token_denied',
  'token_replay',
  'access_denied',
]);

/** Event names are printable ASCII without spaces (ULV rule). */
const EVENT_NAME = /^[\x21-\x7e]{1,128}$/;

/**
 * Failures that mean the arguments were wrong (nothing ran), as opposed to a
 * call that ran and failed. An upstream 400/422 from BookStack carries a
 * `status` in the error data and did run, so it stays an error.
 */
export function isValidationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; message?: unknown; code?: unknown; data?: unknown };
  if (e.name === 'ZodError') return true;
  if (typeof e.message === 'string' && /^Missing required fields:/.test(e.message)) return true;
  // An McpError(InvalidParams) built locally rather than from a BookStack response.
  const status = (e.data as { status?: unknown } | undefined)?.status;
  return e.code === -32602 && status === undefined;
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

/** Memo of the manifest already delivered by this isolate (a failure clears it). */
let manifestMemo: Promise<void> | undefined;

/** Test hook: forget that this isolate has described itself. */
export function resetManifestMemo(): void {
  manifestMemo = undefined;
}

export class Auditor {
  private queue: LogEvent[] = [];
  private scheduled = false;
  private toolList: ManifestTool[] | undefined;

  constructor(
    private readonly logger: SourceBinding | undefined,
    private readonly ctx: ExecutionContext | undefined,
    private readonly actor: ActorContext,
    private readonly settings: AuditSettings,
  ) {}

  get configured(): boolean {
    return Boolean(this.logger);
  }

  get active(): boolean {
    return Boolean(this.logger) && this.settings.enabled;
  }

  /** Tool metadata for the manifest; set once the MCP server has registered its tools. */
  setTools(tools: ManifestTool[]): void {
    this.toolList = tools;
  }

  manifest(): Manifest {
    return {
      v: 1,
      display_name: this.settings.displayName,
      server: SERVER_NAME,
      version: PACKAGE_VERSION,
      settings: {
        logs_reads: this.settings.logReads,
        logs_auth_events: true,
        max_field_chars: this.settings.maxFieldChars,
      },
      tools: this.toolList ?? [],
    };
  }

  toolCall(record: ToolCallRecord): void {
    if (!this.active) return;
    try {
      const mutating = isMutating(record.tool);
      // Turning off read logging is a volume decision; the record of what
      // changed cannot be turned off short of disabling the log entirely.
      if (!mutating && !this.settings.logReads) return;

      const limit = this.settings.maxFieldChars;
      const thrown = record.error !== undefined;
      const failed = record.rejected !== undefined || thrown;
      const status: EventStatus =
        record.rejected !== undefined || (thrown && isValidationFailure(record.error))
          ? 'rejected'
          : thrown
            ? 'error'
            : 'ok';

      const errorText = record.rejected
        ? record.rejected
        : thrown
          ? record.error instanceof Error
            ? record.error.message
            : String(record.error)
          : undefined;

      const event: LogEvent = {
        uid: crypto.randomUUID(),
        ts: Date.now(),
        // The tool name comes from the caller when the tool is unknown: keep
        // it within ULV's name rule so one odd name cannot cost the batch.
        kind: 'tool_call',
        name: EVENT_NAME.test(record.tool) ? record.tool : 'unknown_tool',
        status,
        mutating,
        duration_ms: Math.max(0, Math.round(record.durationMs)),
        actor: this.actorFor(),
        request_id: this.actor.requestId,
      };
      const target = describeTarget(record.tool, record.args);
      if (target) event.target = target;
      if (record.args !== undefined) event.args = fitJson(redact(record.args), limit);
      if (failed) {
        if (errorText) event.error = cap(errorText, Math.min(limit, MAX_ERROR_CHARS));
      } else if (record.result !== undefined && record.tool !== AUDIT_TOOL_NAME) {
        event.result = fitJson(record.result, limit);
      }
      this.push(event);
    } catch (e) {
      console.warn(`audit: could not record tool call (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  authEvent(name: string, fields: AuthEventFields = {}): void {
    if (!this.active) return;
    try {
      const actor = this.actorFor();
      const nonce = fields.tokenNonce ?? this.actor.actorNonce;
      if (nonce) actor.id = nonce;
      const client = fields.clientId ?? this.actor.clientId;
      if (client) actor.client = client.slice(0, 200);

      const event: LogEvent = {
        uid: crypto.randomUUID(),
        ts: Date.now(),
        kind: 'auth',
        name: EVENT_NAME.test(name) ? name : 'auth_event',
        status: DENIED_EVENTS.has(name) ? 'denied' : 'ok',
        actor,
        request_id: this.actor.requestId,
      };
      if (fields.detail) event.summary = cap(fields.detail, MAX_SUMMARY_CHARS);
      this.push(event);
    } catch (e) {
      console.warn(`audit: could not record auth event (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  private actorFor(): NonNullable<LogEvent['actor']> {
    const a: NonNullable<LogEvent['actor']> = {};
    if (this.actor.actorNonce) a.id = this.actor.actorNonce;
    if (this.actor.clientId) a.client = this.actor.clientId;
    if (this.actor.ip) a.ip = this.actor.ip;
    if (this.actor.country) a.country = this.actor.country;
    if (this.actor.userAgent) a.user_agent = this.actor.userAgent;
    return a;
  }

  /**
   * Collects events and sends everything recorded in the same tick in one
   * `log` call, inside waitUntil: the response is never held up, and the
   * isolate stays alive until the send is done.
   */
  private push(event: LogEvent): void {
    this.queue.push(event);
    if (this.scheduled) return;
    this.scheduled = true;
    const work = Promise.resolve()
      .then(() => this.flush())
      .catch((e) => {
        console.warn(`audit: send failed (${e instanceof Error ? e.message : String(e)})`);
      });
    this.ctx?.waitUntil(work);
  }

  private async flush(): Promise<void> {
    const logger = this.logger;
    const events = this.queue;
    this.queue = [];
    this.scheduled = false;
    if (!logger || events.length === 0) return;

    // Describe first, so a brand-new service is created with its display name
    // (ULV only takes the name from whatever creates the row first).
    await this.describeOnce(logger);

    for (let i = 0; i < events.length; i += MAX_BATCH) {
      try {
        const res = await logger.log({ v: 1, events: events.slice(i, i + MAX_BATCH) });
        if (!res || res.ok !== true) {
          const err = (res as SourceError | undefined)?.error;
          console.warn(`audit: log refused (${err?.code ?? 'unknown'}: ${err?.message ?? ''})`);
        } else if (res.rejected && res.rejected.length > 0) {
          console.warn(`audit: ${res.rejected.length} event(s) refused (${res.rejected[0].reason})`);
        }
      } catch (e) {
        console.warn(`audit: log failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }

  /**
   * Once per isolate; a failure clears the memo so a later request retries.
   * Skipped until the tool list is known, so a tool-less manifest (an auth
   * request builds no MCP server) is never what an isolate settles on.
   */
  private describeOnce(logger: SourceBinding): Promise<void> {
    if (manifestMemo) return manifestMemo;
    if (!this.toolList) return Promise.resolve();
    manifestMemo = (async () => {
      // Yield first so the memo is assigned before any failure can clear it
      // (a binding that throws synchronously would otherwise be memoised).
      await Promise.resolve();
      try {
        const res = await logger.describe(this.manifest());
        if (!res || res.ok !== true) {
          const err = (res as SourceError | undefined)?.error;
          throw new Error(`${err?.code ?? 'unknown'}: ${err?.message ?? ''}`);
        }
      } catch (e) {
        // Only one attempt is ever in flight (the memo gates it), so this is that attempt's memo.
        manifestMemo = undefined;
        console.warn(`audit: describe failed (${e instanceof Error ? e.message : String(e)})`);
      }
    })();
    return manifestMemo;
  }
}

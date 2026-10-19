/// <reference types="@cloudflare/workers-types" />
/**
 * Schema for the MCP audit log in a *shared* D1 database.
 *
 * Several MCP servers (BookStack, Proxmox, ...) log into one D1 database --
 * Workers Free allows only a handful of databases, so one per server does not
 * scale. Sharing the database does not mean sharing a schema: every logging
 * instance gets its own set of tables, prefixed with its instance id, and its
 * own migration ledger. No server ever creates, alters or reads another
 * server's tables.
 *
 *   audit_instances                 shared registry -- one row per instance
 *   <instance>_tool_calls           this instance's tool calls
 *   <instance>_auth_events          this instance's OAuth / access events
 *   <instance>_schema_migrations    this instance's migration ledger
 *
 * The registry is the one shared table, and it is deliberately tiny and
 * generic. Each instance upserts only its own row, which tells a viewer
 * (ULV) where that instance's tables are, what it logs (settings_json)
 * and what each of its tools means (tools_json) -- so a viewer can display an
 * instance it has never heard of without code changes.
 *
 * The per-instance tables have the same columns as proxmox-mcp-server's
 * tool_calls / auth_events, so the same viewer code renders all of them.
 *
 * Rules for changing it:
 *   1. Never edit or renumber a migration that has shipped -- append a new one.
 *   2. Never assume a migration runs alone; the ledger insert arbitrates races.
 *   3. Never change the registry's existing columns -- other servers write it.
 *      Additive, nullable columns only.
 */

/** Value written to audit_instances.server, so ownership of a row can be checked. */
export const SERVER = 'bookstack-mcp-server';

/** Version of the registry row format, for viewers. */
export const REGISTRY_FORMAT = 1;

/**
 * Instance ids become part of SQL identifiers, so they are restricted to a
 * shape that cannot inject anything: lowercase letter first, then lowercase
 * letters, digits and underscores, at most 32 characters.
 */
const INSTANCE_ID = /^[a-z][a-z0-9_]{0,31}$/;

export function assertInstanceId(id: string): string {
  if (!INSTANCE_ID.test(id)) {
    throw new Error(
      `Invalid AUDIT_INSTANCE_ID "${id}": use lowercase letters, digits and underscores, ` +
        `starting with a letter, max 32 characters.`,
    );
  }
  return id;
}

export interface AuditTables {
  instance: string;
  toolCalls: string;
  authEvents: string;
  ledger: string;
}

export function tablesFor(instance: string): AuditTables {
  const id = assertInstanceId(instance);
  return {
    instance: id,
    toolCalls: `${id}_tool_calls`,
    authEvents: `${id}_auth_events`,
    ledger: `${id}_schema_migrations`,
  };
}

/** Shared registry. CREATE IF NOT EXISTS -- whichever server gets there first creates it. */
const REGISTRY = `CREATE TABLE IF NOT EXISTS audit_instances (
  instance_id       TEXT    PRIMARY KEY,
  server            TEXT    NOT NULL,
  display_name      TEXT    NOT NULL,
  format            INTEGER NOT NULL,
  tool_calls_table  TEXT    NOT NULL,
  auth_events_table TEXT,
  schema_version    INTEGER NOT NULL,
  settings_json     TEXT,
  tools_json        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
)`;

export interface Migration {
  id: number;
  name: string;
  /** One SQL statement per entry, given this instance's table names. */
  statements: (t: AuditTables) => string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'audit_log',
    statements: (t) => [
      // ts is epoch ms. status: 'ok', 'error' (ran and failed), 'rejected'
      // (never ran -- unknown tool). target: what was acted on, e.g. "page:12".
      // sudo / upid exist only for column parity with the Proxmox server and
      // are always 0 / NULL here.
      `CREATE TABLE IF NOT EXISTS ${t.toolCalls} (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         ts            INTEGER NOT NULL,
         request_id    TEXT    NOT NULL,
         actor_nonce   TEXT,
         actor_issued  INTEGER,
         actor_label   TEXT,
         client_id     TEXT,
         ip            TEXT,
         country       TEXT,
         user_agent    TEXT,
         tool          TEXT    NOT NULL,
         mutating      INTEGER NOT NULL DEFAULT 0,
         sudo          INTEGER NOT NULL DEFAULT 0,
         target        TEXT,
         args_json     TEXT,
         args_bytes    INTEGER,
         status        TEXT    NOT NULL,
         duration_ms   INTEGER,
         result_json   TEXT,
         result_bytes  INTEGER,
         error         TEXT,
         upid          TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS ${t.toolCalls}_ts        ON ${t.toolCalls} (ts DESC)`,
      `CREATE INDEX IF NOT EXISTS ${t.toolCalls}_actor_ts  ON ${t.toolCalls} (actor_nonce, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS ${t.toolCalls}_tool_ts   ON ${t.toolCalls} (tool, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS ${t.toolCalls}_target    ON ${t.toolCalls} (target, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS ${t.toolCalls}_mutations ON ${t.toolCalls} (ts DESC) WHERE mutating = 1`,

      `CREATE TABLE IF NOT EXISTS ${t.authEvents} (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         ts          INTEGER NOT NULL,
         request_id  TEXT,
         event       TEXT    NOT NULL,
         ip          TEXT,
         country     TEXT,
         user_agent  TEXT,
         client_id   TEXT,
         token_nonce TEXT,
         detail      TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS ${t.authEvents}_ts       ON ${t.authEvents} (ts DESC)`,
      `CREATE INDEX IF NOT EXISTS ${t.authEvents}_event_ts ON ${t.authEvents} (event, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS ${t.authEvents}_nonce    ON ${t.authEvents} (token_nonce) WHERE token_nonce IS NOT NULL`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0);

/** Thrown when the instance id is already registered by a different server. */
export class InstanceConflictError extends Error {
  constructor(instance: string, owner: string) {
    super(
      `Audit instance "${instance}" is already registered by "${owner}" in this database. ` +
        `Set AUDIT_INSTANCE_ID to a different id so the two servers keep separate tables.`,
    );
    this.name = 'InstanceConflictError';
  }
}

/** What an instance publishes about itself in the registry. */
export interface InstanceManifest {
  displayName: string;
  /** What is being logged -- shown by viewers so a reader knows what may be missing. */
  settings: Record<string, unknown>;
  /**
   * Per-tool metadata so a viewer can label rows without knowing this server.
   * Undefined leaves the stored list untouched (e.g. from the cron handler,
   * which never builds the MCP server).
   */
  tools?: Array<{
    name: string;
    title: string;
    description: string;
    category?: string | undefined;
    mutating: boolean;
    /** Optional phrasing for viewers: "Deleted" / "delete" / "a page". */
    past?: string | undefined;
    infinitive?: string | undefined;
    object?: string | undefined;
  }> | undefined;
}

export interface SchemaState {
  version: number;
  expected: number;
  applied: number[];
  raced: number[];
}

function isLostRace(error: unknown, ledger: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return new RegExp(`UNIQUE constraint failed:\\s*${ledger}`, 'i').test(message);
}

/**
 * Claims (or confirms) this instance's registry row and refreshes its manifest.
 *
 * The INSERT ... ON CONFLICT only updates when the existing row's server is
 * this one, so a misconfigured id can never overwrite another server's entry;
 * the follow-up read is what turns that into a loud error instead of a silent
 * no-op.
 */
async function register(db: D1Database, t: AuditTables, manifest: InstanceManifest | undefined): Promise<void> {
  await db.prepare(REGISTRY).run();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO audit_instances (
         instance_id, server, display_name, format, tool_calls_table, auth_events_table,
         schema_version, settings_json, tools_json, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
       ON CONFLICT (instance_id) DO UPDATE SET
         display_name = excluded.display_name,
         format = excluded.format,
         tool_calls_table = excluded.tool_calls_table,
         auth_events_table = excluded.auth_events_table,
         schema_version = excluded.schema_version,
         settings_json = COALESCE(excluded.settings_json, audit_instances.settings_json),
         tools_json = COALESCE(excluded.tools_json, audit_instances.tools_json),
         updated_at = excluded.updated_at
       WHERE audit_instances.server = excluded.server`,
    )
    .bind(
      t.instance,
      SERVER,
      manifest?.displayName ?? t.instance,
      REGISTRY_FORMAT,
      t.toolCalls,
      t.authEvents,
      SCHEMA_VERSION,
      manifest ? JSON.stringify(manifest.settings) : null,
      manifest?.tools ? JSON.stringify(manifest.tools) : null,
      now,
    )
    .run();

  const row = await db
    .prepare('SELECT server FROM audit_instances WHERE instance_id = ?1')
    .bind(t.instance)
    .first<{ server: string }>();
  if (row && row.server !== SERVER) throw new InstanceConflictError(t.instance, row.server);
}

export async function ensureSchema(
  db: D1Database,
  t: AuditTables,
  manifest?: InstanceManifest,
  migrations: Migration[] = MIGRATIONS,
): Promise<SchemaState> {
  // Registry first: if the id belongs to someone else, stop before creating anything.
  await register(db, t, manifest);

  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${t.ledger} (
         id         INTEGER PRIMARY KEY,
         name       TEXT    NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    )
    .run();

  const ledger = await db.prepare(`SELECT id FROM ${t.ledger}`).all<{ id: number }>();
  const done = new Set((ledger.results ?? []).map((row) => row.id));
  const pending = migrations.filter((m) => !done.has(m.id)).sort((a, b) => a.id - b.id);

  const state: SchemaState = {
    version: done.size ? Math.max(...done) : 0,
    expected: migrations.reduce((max, m) => Math.max(max, m.id), 0),
    applied: [],
    raced: [],
  };

  for (const migration of pending) {
    try {
      // One batch = one transaction; the ledger row goes first so a concurrent
      // isolate is turned away before any DDL runs.
      await db.batch([
        db
          .prepare(`INSERT INTO ${t.ledger} (id, name, applied_at) VALUES (?1, ?2, ?3)`)
          .bind(migration.id, migration.name, Date.now()),
        ...migration.statements(t).map((sql) => db.prepare(sql)),
      ]);
      state.applied.push(migration.id);
    } catch (error) {
      if (isLostRace(error, t.ledger)) {
        state.raced.push(migration.id);
        continue;
      }
      throw new Error(
        `Audit schema migration ${migration.id} (${migration.name}) for "${t.instance}" failed and was ` +
          `rolled back; still at version ${state.version}. ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    state.version = migration.id;
  }

  if (state.raced.length) state.version = Math.max(state.version, ...state.raced);
  return state;
}

/**
 * Per-isolate memo keyed by database and instance, so the registry upsert and
 * schema check cost one round of queries per isolate, not per request -- which
 * matters on the Workers Free D1 write budget. A failure clears the memo.
 */
const inflight = new WeakMap<D1Database, Map<string, Promise<SchemaState>>>();

export function ensureSchemaOnce(
  db: D1Database,
  t: AuditTables,
  manifest?: () => InstanceManifest | undefined,
): Promise<SchemaState> {
  let byInstance = inflight.get(db);
  if (!byInstance) inflight.set(db, (byInstance = new Map()));
  let pending = byInstance.get(t.instance);
  if (!pending) {
    pending = ensureSchema(db, t, manifest?.()).catch((error) => {
      byInstance!.delete(t.instance);
      throw error;
    });
    byInstance.set(t.instance, pending);
  }
  return pending;
}

/** Test seam. */
export function resetSchemaMemo(db: D1Database): void {
  inflight.delete(db);
}

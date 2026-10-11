/// <reference types="@cloudflare/workers-types" />
/**
 * Schema for the MCP audit log, and the machinery that brings a D1 database up
 * to it.
 *
 * The audit database is BookStack-only. It is a separate D1 instance from the
 * one the Proxmox MCP server logs to, and this module refuses to write to a
 * database that already belongs to another MCP server. The reason is simple:
 * the two servers use the same table names (`tool_calls`, `auth_events`) so
 * that one viewer -- Hindsight -- can read either of them, and the price of
 * that compatibility is that pointing both at one database would silently mix
 * their rows together. Ownership is therefore made explicit and checked:
 *
 *   - `bookstack_audit_owner` holds a single row naming this server. It is
 *     written in the same transaction as the first migration.
 *   - A database that already has audit tables or another server's migration
 *     ledger, but no owner row, belongs to someone else and is left alone.
 *   - The migration ledger is called `bookstack_schema_migrations`, not
 *     `schema_migrations`, so it can never collide with the Proxmox server's
 *     ledger and convince either server that its migrations have already run.
 *
 * Column-for-column the tables match proxmox-mcp-server's migration 1, so
 * Hindsight can be deployed a second time with its AUDIT_DB bound to this
 * database and work unchanged. Columns that have no BookStack meaning (`sudo`,
 * `upid`) are kept and simply always 0 / NULL.
 *
 * Rules for changing it (same as the Proxmox server's):
 *   1. Never edit or renumber a migration that has shipped -- append a new one.
 *   2. Never assume a migration runs alone; the ledger insert arbitrates races.
 */

export const OWNER = 'bookstack-mcp-server';

export interface Migration {
  id: number;
  name: string;
  /** One SQL statement per entry -- D1's prepare() takes a single statement. */
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'audit_log',
    statements: [
      `CREATE TABLE IF NOT EXISTS bookstack_audit_owner (
         id         INTEGER PRIMARY KEY CHECK (id = 1),
         owner      TEXT    NOT NULL,
         created_at INTEGER NOT NULL
       )`,
      `INSERT INTO bookstack_audit_owner (id, owner, created_at) VALUES (1, '${OWNER}', CAST(strftime('%s','now') AS INTEGER) * 1000)`,

      // ts is epoch milliseconds. status is 'ok', 'error' (ran and failed), or
      // 'rejected' (never ran -- unknown tool). target is a short description
      // of what was acted on, e.g. "page:12" or "book:3".
      `CREATE TABLE IF NOT EXISTS tool_calls (
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
      `CREATE INDEX IF NOT EXISTS tool_calls_ts        ON tool_calls (ts DESC)`,
      `CREATE INDEX IF NOT EXISTS tool_calls_actor_ts  ON tool_calls (actor_nonce, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS tool_calls_tool_ts   ON tool_calls (tool, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS tool_calls_target    ON tool_calls (target, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS tool_calls_mutations ON tool_calls (ts DESC) WHERE mutating = 1`,
      `CREATE INDEX IF NOT EXISTS tool_calls_upid      ON tool_calls (upid) WHERE upid IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS tool_calls_sudo      ON tool_calls (ts DESC) WHERE sudo = 1`,

      `CREATE TABLE IF NOT EXISTS auth_events (
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
      `CREATE INDEX IF NOT EXISTS auth_events_ts       ON auth_events (ts DESC)`,
      `CREATE INDEX IF NOT EXISTS auth_events_event_ts ON auth_events (event, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS auth_events_nonce    ON auth_events (token_nonce) WHERE token_nonce IS NOT NULL`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0);

const LEDGER = `CREATE TABLE IF NOT EXISTS bookstack_schema_migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
)`;

/** Thrown when the bound database already holds another server's audit data. */
export class ForeignDatabaseError extends Error {
  constructor(detail: string) {
    super(
      `Refusing to write the BookStack audit log: ${detail}. Bind BOOKSTACK_AUDIT_DB to its own ` +
        `D1 database (npx wrangler d1 create bookstack-mcp-audit) -- it must not be shared with ` +
        `another MCP server.`,
    );
    this.name = 'ForeignDatabaseError';
  }
}

export interface SchemaState {
  version: number;
  expected: number;
  applied: number[];
  raced: number[];
}

function isLostRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*bookstack_(schema_migrations|audit_owner)/i.test(message);
}

async function tableNames(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all<{ name: string }>();
  return new Set((rows.results ?? []).map((r) => r.name));
}

/**
 * Confirms the database is this server's, or empty enough to become it.
 *
 * Cheap enough to run once per isolate, and it is the only thing standing
 * between a copy-pasted database_id and two servers' logs in one table.
 */
async function assertOwnership(db: D1Database): Promise<void> {
  const tables = await tableNames(db);

  if (tables.has('bookstack_audit_owner')) {
    const row = await db
      .prepare(`SELECT owner FROM bookstack_audit_owner WHERE id = 1`)
      .first<{ owner: string }>();
    if (row && row.owner !== OWNER) {
      throw new ForeignDatabaseError(`it is owned by "${row.owner}"`);
    }
    if (row) return;
  }

  const foreign = ['schema_migrations', 'tool_calls', 'auth_events'].filter((t) => tables.has(t));
  if (foreign.length) {
    throw new ForeignDatabaseError(
      `it already contains ${foreign.join(', ')} written by another server (likely proxmox-mcp-server)`,
    );
  }
}

export async function ensureSchema(
  db: D1Database,
  migrations: Migration[] = MIGRATIONS,
): Promise<SchemaState> {
  await assertOwnership(db);
  await db.prepare(LEDGER).run();

  const ledger = await db
    .prepare('SELECT id FROM bookstack_schema_migrations')
    .all<{ id: number }>();
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
      // One batch = one transaction: the ledger row goes first so a concurrent
      // isolate is turned away before any DDL runs.
      await db.batch([
        db
          .prepare('INSERT INTO bookstack_schema_migrations (id, name, applied_at) VALUES (?1, ?2, ?3)')
          .bind(migration.id, migration.name, Date.now()),
        ...migration.statements.map((sql) => db.prepare(sql)),
      ]);
      state.applied.push(migration.id);
    } catch (error) {
      if (isLostRace(error)) {
        state.raced.push(migration.id);
        continue;
      }
      throw new Error(
        `Audit schema migration ${migration.id} (${migration.name}) failed and was rolled back; ` +
          `the database is still at version ${state.version}. ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    state.version = migration.id;
  }

  if (state.raced.length) state.version = Math.max(state.version, ...state.raced);
  return state;
}

/** Per-isolate memo; a failure clears it so a transient error is retried. */
const inflight = new WeakMap<D1Database, Promise<SchemaState>>();

export function ensureSchemaOnce(db: D1Database): Promise<SchemaState> {
  let pending = inflight.get(db);
  if (!pending) {
    pending = ensureSchema(db).catch((error) => {
      inflight.delete(db);
      throw error;
    });
    inflight.set(db, pending);
  }
  return pending;
}

/** Test seam. */
export function resetSchemaMemo(db: D1Database): void {
  inflight.delete(db);
}

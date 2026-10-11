// node:sqlite needs Node >= 22.5; skip the database-backed tests on older runtimes.
let DatabaseSync: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = undefined;
}
const describeDb = DatabaseSync ? describe : describe.skip;
import { Auditor, auditSettingsFromEnv, describeTarget, isMutating, redact, sweepAuditLog } from '../../src/audit/auditor';
import { ensureSchema, ForeignDatabaseError, resetSchemaMemo } from '../../src/audit/migrate';
import { McpAuditTools } from '../../src/tools/mcp-audit';

/** Minimal D1 shim over node:sqlite -- enough of the API the audit code uses. */
function fakeD1(): any {
  const sqlite = new DatabaseSync(':memory:');
  const stmt = (sql: string, binds: unknown[] = []) => ({
    sql,
    binds,
    bind: (...b: unknown[]) => stmt(sql, b),
    run: async () => {
      const r = sqlite.prepare(sql).run(...binds);
      return { meta: { changes: Number(r.changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
  });
  return {
    sqlite,
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: Array<{ sql: string; binds: unknown[] }>) => {
      sqlite.exec('BEGIN');
      try {
        for (const s of stmts) sqlite.prepare(s.sql).run(...s.binds);
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => pending.push(p), flush: () => Promise.all(pending) } as any;
}

const actor = { requestId: 'req-1', actorNonce: 'nonce-1', ip: '203.0.113.9' };

describeDb('MCP audit log', () => {
  it('creates the schema and records tool calls with outcome, target and redaction', async () => {
    const db = fakeD1();
    const ctx = fakeCtx();
    const audit = new Auditor(db, ctx, actor, auditSettingsFromEnv({}));

    audit.toolCall({ tool: 'bookstack_pages_update', args: { id: 12, html: '<p>x</p>' }, result: { id: 12 }, durationMs: 40 });
    audit.toolCall({ tool: 'bookstack_users_create', args: { name: 'a', password: 'hunter2' }, error: new Error('boom'), durationMs: 5 });
    audit.toolCall({ tool: 'bookstack_nope', args: {}, rejected: 'Unknown tool: bookstack_nope', durationMs: 0 });
    await ctx.flush();

    const rows = db.sqlite.prepare('SELECT * FROM tool_calls ORDER BY id').all();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ tool: 'bookstack_pages_update', mutating: 1, target: 'page:12', status: 'ok', actor_nonce: 'nonce-1', sudo: 0 });
    expect(rows[1]).toMatchObject({ status: 'error', error: 'boom', result_json: null });
    expect(rows[1].args_json).not.toContain('hunter2');
    expect(rows[2]).toMatchObject({ status: 'rejected' });

    const owner = db.sqlite.prepare('SELECT owner FROM bookstack_audit_owner').get();
    expect(owner.owner).toBe('bookstack-mcp-server');
  });

  it('skips reads when AUDIT_LOG_READS=false but still logs mutations', async () => {
    const db = fakeD1();
    const ctx = fakeCtx();
    const audit = new Auditor(db, ctx, actor, auditSettingsFromEnv({ AUDIT_LOG_READS: 'false' }));
    audit.toolCall({ tool: 'bookstack_pages_read', args: { id: 1 }, result: {}, durationMs: 1 });
    audit.toolCall({ tool: 'bookstack_pages_delete', args: { id: 1 }, result: {}, durationMs: 1 });
    await ctx.flush();
    const rows = db.sqlite.prepare('SELECT tool FROM tool_calls').all();
    expect(rows.map((r: any) => r.tool)).toEqual(['bookstack_pages_delete']);
  });

  it('records auth events', async () => {
    const db = fakeD1();
    const ctx = fakeCtx();
    new Auditor(db, ctx, actor, auditSettingsFromEnv({})).authEvent('token_issued', { tokenNonce: 'n2' });
    await ctx.flush();
    expect(db.sqlite.prepare('SELECT event, token_nonce FROM auth_events').get()).toMatchObject({ event: 'token_issued', token_nonce: 'n2' });
  });

  it('refuses a database already used by another MCP server (e.g. the Proxmox audit DB)', async () => {
    const db = fakeD1();
    db.sqlite.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)');
    db.sqlite.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY, ts INTEGER)');
    resetSchemaMemo(db);
    await expect(ensureSchema(db)).rejects.toBeInstanceOf(ForeignDatabaseError);

    // And the auditor never writes into it.
    const ctx = fakeCtx();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    new Auditor(db, ctx, actor, auditSettingsFromEnv({})).toolCall({ tool: 'bookstack_books_list', args: {}, result: [], durationMs: 1 });
    await ctx.flush();
    spy.mockRestore();
    expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n).toBe(0);
  });

  it('is idempotent on its own database', async () => {
    const db = fakeD1();
    await ensureSchema(db);
    const again = await ensureSchema(db);
    expect(again.applied).toEqual([]);
    expect(again.version).toBe(1);
  });

  it('does nothing when disabled or unbound', async () => {
    const db = fakeD1();
    const ctx = fakeCtx();
    new Auditor(db, ctx, actor, auditSettingsFromEnv({ AUDIT_ENABLED: 'false' })).toolCall({ tool: 'bookstack_pages_delete', args: { id: 1 }, durationMs: 1 });
    new Auditor(undefined, ctx, actor, auditSettingsFromEnv({})).toolCall({ tool: 'bookstack_pages_delete', args: { id: 1 }, durationMs: 1 });
    await ctx.flush();
    const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'tool_calls'").all();
    expect(tables).toHaveLength(0);
  });

  it('sweeps rows past retention', async () => {
    const db = fakeD1();
    await ensureSchema(db);
    const old = Date.now() - 400 * 86_400_000;
    db.sqlite.prepare("INSERT INTO tool_calls (ts, request_id, tool, status) VALUES (?, 'r', 't', 'ok')").run(old);
    db.sqlite.prepare("INSERT INTO tool_calls (ts, request_id, tool, status) VALUES (?, 'r', 't', 'ok')").run(Date.now());
    const result = await sweepAuditLog(db, auditSettingsFromEnv({}));
    expect(result.tool_calls).toBe(1);
  });

  it('query tool filters and handles an empty database', async () => {
    const db = fakeD1();
    const [tool] = new McpAuditTools(db).getTools();
    expect(await tool.handler({})).toMatchObject({ count: 0 });

    const ctx = fakeCtx();
    const audit = new Auditor(db, ctx, actor, auditSettingsFromEnv({}));
    audit.toolCall({ tool: 'bookstack_books_list', args: {}, result: [], durationMs: 1 });
    audit.toolCall({ tool: 'bookstack_books_delete', args: { id: 3 }, result: {}, durationMs: 1 });
    await ctx.flush();
    const res = await tool.handler({ mutating: true });
    expect(res.count).toBe(1);
    expect(res.calls[0]).toMatchObject({ tool: 'bookstack_books_delete', target: 'book:3', mutating: true });
  });
});

describe('classification helpers', () => {
  it('classifies mutations', () => {
    expect(isMutating('bookstack_pages_create')).toBe(true);
    expect(isMutating('bookstack_recyclebin_delete_permanently')).toBe(true);
    expect(isMutating('bookstack_permissions_update')).toBe(true);
    expect(isMutating('bookstack_pages_export')).toBe(false);
    expect(isMutating('bookstack_search')).toBe(false);
  });

  it('describes targets', () => {
    expect(describeTarget('bookstack_permissions_update', { content_type: 'book', content_id: 5 })).toBe('book:5');
    expect(describeTarget('bookstack_pages_create', { book_id: 2, name: 'x' })).toBe('book:2');
    expect(describeTarget('bookstack_attachments_create', { uploaded_to: 9 })).toBe('page:9');
    expect(describeTarget('bookstack_search', { query: 'vpn' })).toBe('search:vpn');
  });

  it('redacts secrets and upload blobs', () => {
    expect(redact({ password: 'x', image: 'AAAA', nested: { api_token: 't' } })).toEqual({
      password: '[redacted]',
      image: '[4 chars omitted]',
      nested: { api_token: '[redacted]' },
    });
  });
});

/// <reference types="@cloudflare/workers-types" />
import { MCPTool } from '../types';
import { SCHEMA_VERSION, type AuditTables } from '../audit/migrate';

/**
 * Reading this instance's MCP audit log (its own tables in AUDIT_DB) back.
 *
 * Not to be confused with bookstack_audit_log_list, which reads BookStack's
 * own internal audit log. This one answers "what did this MCP server do, and
 * which token asked for it". Only registered when the database is bound.
 */

const RELATIVE = /^(\d+)\s*([mhdw])$/i;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Accepts "24h", "7d", an ISO timestamp, or epoch milliseconds. */
export function parseTime(value: string): number {
  const trimmed = value.trim();
  const relative = RELATIVE.exec(trimmed);
  if (relative) {
    const unit = UNIT_MS[relative[2].toLowerCase() as keyof typeof UNIT_MS];
    return Date.now() - parseInt(relative[1], 10) * unit;
  }
  if (/^\d{10,}$/.test(trimmed)) return parseInt(trimmed, 10);
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Could not read "${value}" as a time. Use "24h", "7d", an ISO timestamp, or epoch milliseconds.`,
    );
  }
  return parsed;
}

const iso = (ts: number) => new Date(ts).toISOString();

export class McpAuditTools {
  /** Reads only this instance's tables -- never another server's in the shared database. */
  constructor(private db: D1Database, private tables: AuditTables) {}

  getTools(): MCPTool[] {
    return [this.createQueryTool()];
  }

  private createQueryTool(): MCPTool {
    return {
      name: 'bookstack_mcp_audit_log',
      description:
        "Search this MCP server's own audit log: every tool call made through it (arguments, " +
        'result, duration, outcome, which token) plus the authentication events behind them. ' +
        'Different from bookstack_audit_log_list, which reads BookStack\'s internal activity log. ' +
        'Actors are identified by the nonce of their bearer token; look the nonce up with ' +
        'kind:"auth" to see when and from where that token was issued.',
      category: 'audit',
      inputSchema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['tools', 'auth'],
            description: '"tools" for tool calls (default), "auth" for authorization and token events.',
          },
          since: { type: 'string', description: 'Start of window: "24h", "7d", ISO time, or epoch ms. Default "7d".' },
          until: { type: 'string', description: 'End of window, same formats. Default now.' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Rows, newest first. Default 50.' },
          tool: { type: 'string', description: 'Only this tool, e.g. "bookstack_pages_delete".' },
          event: { type: 'string', description: 'kind:"auth" only, e.g. "authorize_fail", "token_issued".' },
          actor: { type: 'string', description: 'Only rows for this token nonce.' },
          target: { type: 'string', description: 'Substring match on target, e.g. "page:12", "book:".' },
          status: { type: 'string', enum: ['ok', 'error', 'rejected'], description: 'Outcome filter.' },
          mutating: { type: 'boolean', description: 'true = only changes, false = only reads.' },
          contains: { type: 'string', description: 'Substring search across arguments, results and errors.' },
          include_payloads: { type: 'boolean', description: 'Include stored arguments and results. Default false.' },
        },
      },
      handler: async (args: Record<string, any>) => this.query(args),
    };
  }

  private async query(args: Record<string, any>) {
    const since = parseTime(args.since ?? '7d');
    const until = args.until ? parseTime(args.until) : Date.now();
    const limit = Math.min(500, Math.max(1, Number(args.limit ?? 50) || 50));

    // Every caller-supplied value is a bound parameter; only fixed literals are concatenated.
    const where: string[] = ['ts >= ?', 'ts <= ?'];
    const params: Array<string | number> = [since, until];
    const add = (clause: string, value: string | number) => {
      where.push(clause);
      params.push(value);
    };

    try {
      if (args.kind === 'auth') {
        if (args.event) add('event = ?', String(args.event));
        if (args.actor) add('token_nonce = ?', String(args.actor));
        if (args.contains) add('detail LIKE ?', `%${args.contains}%`);
        const rows = await this.db
          .prepare(
            `SELECT id, ts, event, ip, country, user_agent, client_id, token_nonce, detail
               FROM ${this.tables.authEvents} WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`,
          )
          .bind(...params, limit)
          .all<Record<string, unknown>>();
        return {
          window: { since: iso(since), until: iso(until) },
          count: rows.results.length,
          events: rows.results.map((r) => ({ ...r, ts: iso(r.ts as number) })),
        };
      }

      if (args.tool) add('tool = ?', String(args.tool));
      if (args.actor) add('actor_nonce = ?', String(args.actor));
      if (args.status) add('status = ?', String(args.status));
      if (typeof args.mutating === 'boolean') add('mutating = ?', args.mutating ? 1 : 0);
      if (args.target) add('target LIKE ?', `%${args.target}%`);
      if (args.contains) {
        where.push('(args_json LIKE ? OR result_json LIKE ? OR error LIKE ?)');
        const pattern = `%${args.contains}%`;
        params.push(pattern, pattern, pattern);
      }

      const columns = [
        'id', 'ts', 'tool', 'target', 'mutating', 'status', 'duration_ms',
        'actor_nonce', 'ip', 'country', 'error',
        ...(args.include_payloads === true ? ['args_json', 'args_bytes', 'result_json', 'result_bytes'] : []),
      ].join(', ');

      const rows = await this.db
        .prepare(`SELECT ${columns} FROM ${this.tables.toolCalls} WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
        .bind(...params, limit)
        .all<Record<string, unknown>>();

      return {
        window: { since: iso(since), until: iso(until) },
        count: rows.results.length,
        note: rows.results.length === limit ? `Capped at ${limit} rows; narrow the window.` : undefined,
        calls: rows.results.map((r) => ({ ...r, ts: iso(r.ts as number), mutating: r.mutating === 1 })),
      };
    } catch (error) {
      // Fresh database: nothing has been logged yet, so the lazy migration has not run.
      if (/no such table/i.test(error instanceof Error ? error.message : String(error))) {
        return { count: 0, note: `The audit log is empty -- nothing has been recorded yet (schema v${SCHEMA_VERSION}).` };
      }
      throw error;
    }
  }
}

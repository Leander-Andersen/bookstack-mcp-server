import { MCPTool } from '../types';
import { AUDIT_TOOL_NAME, type RecentQuery, type SourceBinding } from '../audit/auditor';

/**
 * Reading this server's own events back from the central log (ULV).
 *
 * Not to be confused with bookstack_audit_log_list, which reads BookStack's
 * own internal audit log. This one answers "what did this MCP server do, and
 * which token asked for it". Read-only, and scoped by the service binding to
 * this server's events: nothing in the query can reach another service's.
 * Only registered when the LOGGER binding is present.
 *
 * Its output is log data, partly written from untrusted input (tool names,
 * targets and error text come from callers and from BookStack). The server's
 * CallTool handler wraps every tool result in the untrusted-data envelope, so
 * this tool's output is wrapped like any other BookStack data.
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

const STATUSES = ['ok', 'error', 'rejected', 'denied'] as const;
const KINDS = ['tool_call', 'auth'] as const;

export class McpAuditTools {
  constructor(private logger: SourceBinding) {}

  getTools(): MCPTool[] {
    return [this.createQueryTool()];
  }

  private createQueryTool(): MCPTool {
    return {
      name: AUDIT_TOOL_NAME,
      description:
        "Search this MCP server's own audit log, kept in the central unified log: every tool call " +
        'made through it (name, target, outcome, duration, which token) plus the authentication ' +
        "events behind them, newest first. Different from bookstack_audit_log_list, which reads " +
        "BookStack's internal activity log. Actors are identified by the nonce of their bearer " +
        'token; look the nonce up with kind:"auth" to see when and from where it was issued. ' +
        'Page backwards with `before` (the next_before value of the previous result).',
      category: 'audit',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Events to return, newest first. Default 25.' },
          before: { type: 'integer', description: 'Cursor: only events older than this event id (use next_before from the previous result).' },
          name: { type: 'string', description: 'Only this tool or auth event, e.g. "bookstack_pages_delete", "token_issued".' },
          status: { type: 'string', enum: [...STATUSES], description: 'Outcome filter. "rejected" = never ran (bad arguments), "denied" = refused for lack of access.' },
          kind: { type: 'string', enum: [...KINDS], description: '"tool_call" for tool calls, "auth" for authorization and token events.' },
          since: { type: 'string', description: 'Only events after this: "24h", "7d", ISO time, or epoch ms.' },
        },
      },
      handler: async (args: Record<string, any>) => this.query(args),
    };
  }

  private async query(args: Record<string, any>) {
    const query: RecentQuery = {};
    if (args.limit !== undefined) query.limit = Math.min(100, Math.max(1, Math.trunc(Number(args.limit)) || 25));
    if (args.before !== undefined) query.before = Math.trunc(Number(args.before));
    if (typeof args.name === 'string' && args.name) query.name = args.name;
    if (args.status !== undefined) {
      if (!(STATUSES as readonly string[]).includes(args.status)) {
        throw new Error(`status must be one of ${STATUSES.join(', ')}`);
      }
      query.status = args.status;
    }
    if (args.kind !== undefined) {
      if (!(KINDS as readonly string[]).includes(args.kind)) {
        throw new Error(`kind must be one of ${KINDS.join(', ')}`);
      }
      query.kind = args.kind;
    }
    if (args.since !== undefined) query.since = parseTime(String(args.since));

    const res = await this.logger.recent(query);
    if (!res || res.ok !== true) {
      const err = (res as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new Error(`The audit log could not be read (${err?.code ?? 'unknown'}: ${err?.message ?? 'no detail'}).`);
    }
    return {
      count: res.events.length,
      events: res.events,
      next_before: res.next_before,
    };
  }
}

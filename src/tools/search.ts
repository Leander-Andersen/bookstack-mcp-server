import { BookStackClient } from '../api/client';
import { ValidationHandler } from '../validation/validator';
import { Logger } from '../utils/logger';
import { MCPTool } from '../types';

/** Strip HTML tags and decode common entities for a plain-text markdown fallback. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Search tools for BookStack MCP Server
 *
 * Provides comprehensive search functionality across all content types
 */
export class SearchTools {
  constructor(
    private client: BookStackClient,
    private validator: ValidationHandler,
    private logger: Logger
  ) {}

  /**
   * Get all search tools
   */
  getTools(): MCPTool[] {
    return [
      this.createSearchTool(),
    ];
  }

  /**
   * Search tool
   */
  private createSearchTool(): MCPTool {
    return {
      name: 'bookstack_search',
      description: 'Search across all BookStack content. Supports advanced query syntax and structured filters. When include_content is true, full page markdown is automatically inlined into results — no second tool call needed.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            default: '',
            description: 'Search query string. Supports advanced syntax: "exact phrase", {type:page|book|chapter|shelf}, {tag:name=value}, {created_by:me}. Structured filters below are merged into this query automatically. Can be empty when using filters alone.',
          },
          page: {
            type: 'integer',
            minimum: 1,
            default: 1,
            description: 'Page number for pagination.',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 20,
            description: 'Results per page.',
          },
          include_content: {
            type: 'boolean',
            default: false,
            description: 'When true, fetches full markdown content for each page result and inlines it. Eliminates the need for a follow-up bookstack_pages_read call. May be slow for large result sets.',
          },
          filters: {
            type: 'object',
            description: 'Structured filters appended to the query as BookStack syntax. Any field here is merged with the query string.',
            properties: {
              type: {
                type: 'string',
                enum: ['page', 'book', 'chapter', 'shelf'],
                description: 'Restrict results to a single content type.',
              },
              tag: {
                type: 'object',
                description: 'Filter by tag. Both name and value are optional.',
                properties: {
                  name: { type: 'string', description: 'Tag name.' },
                  value: { type: 'string', description: 'Tag value.' },
                },
              },
              owned_by: {
                type: 'string',
                description: 'Filter by owner. Use "me" for the current user, or a numeric user ID.',
              },
              created_by: {
                type: 'string',
                description: 'Filter by creator. Use "me" for the current user, or a numeric user ID.',
              },
              updated_by: {
                type: 'string',
                description: 'Filter by last editor. Use "me" for the current user, or a numeric user ID.',
              },
            },
          },
        },
      },
      examples: [
        {
          description: 'Search pages and get full content inline',
          input: { query: 'proxmox', filters: { type: 'page' }, include_content: true },
          expected_output: 'Pages with full markdown content inlined',
          use_case: 'Read matching pages without a second tool call',
        },
        {
          description: 'Search by tag with structured filter',
          input: { query: '', filters: { tag: { name: 'status', value: 'active' } } },
          expected_output: 'Content tagged status=active',
          use_case: 'Filtering by metadata without knowing BookStack syntax',
        },
        {
          description: 'Find pages created by me about backups',
          input: { query: 'backup', filters: { type: 'page', created_by: 'me' } },
          expected_output: 'Pages about backups created by the current user',
          use_case: 'Personal content audit',
        },
      ],
      usage_patterns: [
        'Use include_content:true to get full page text in one call instead of searching then reading.',
        'Use filters.type to restrict to a content type instead of embedding {type:page} in the query.',
        'Use filters.tag to find content by tag without constructing {tag:name=value} syntax manually.',
      ],
      related_tools: ['bookstack_pages_read', 'bookstack_books_list'],
      error_codes: [
        {
          code: 'VALIDATION_ERROR',
          description: 'Empty query',
          recovery_suggestion: 'Provide a search term or at least one filter',
        }
      ],
      handler: async (params: any) => {
        // Build final query by merging structured filters into the query string
        let finalQuery: string = params.query ?? '';

        const f = params.filters ?? {};

        if (f.type) {
          finalQuery += ` {type:${f.type}}`;
        }
        if (f.tag) {
          const { name, value } = f.tag;
          if (name && value) {
            finalQuery += ` {tag:${name}=${value}}`;
          } else if (name) {
            finalQuery += ` {tag:${name}}`;
          }
        }
        if (f.owned_by) {
          finalQuery += ` {owned_by:${f.owned_by}}`;
        }
        if (f.created_by) {
          finalQuery += ` {created_by:${f.created_by}}`;
        }
        if (f.updated_by) {
          finalQuery += ` {updated_by:${f.updated_by}}`;
        }

        finalQuery = finalQuery.trim();
        if (!finalQuery) {
          throw new Error('Provide a query string or at least one filter (e.g. filters.type, filters.tag).');
        }

        this.logger.info('Searching content', { query: finalQuery, page: params.page, count: params.count });

        const searchParams: any = { query: finalQuery };
        if (params.page) searchParams.page = params.page;
        if (params.count) searchParams.count = params.count;

        const results = await this.client.search(searchParams);

        if (!params.include_content) {
          return results;
        }

        // Inline full page content for page-type results
        const enriched = await Promise.all(
          results.data.map(async (item: any) => {
            if (item.type !== 'page') return item;
            try {
              const full = await this.client.getPage(item.id);
              // markdown is empty for WYSIWYG-authored pages — strip HTML as fallback
              const markdown = full.markdown || htmlToPlainText(full.html || '');
              return { ...item, content: { markdown, html: full.html } };
            } catch {
              return item; // Fall back to snippet if fetch fails
            }
          })
        );

        return { ...results, data: enriched };
      },
    };
  }
}

export default SearchTools;

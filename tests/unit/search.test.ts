import { SearchTools, buildTagTerm } from '../../src/tools/search';

describe('SearchTools tag syntax', () => {
  let search: jest.Mock;
  let handler: (p: any) => Promise<any>;

  beforeEach(() => {
    search = jest.fn().mockResolvedValue({ data: [], total: 0 });
    const client: any = { search };
    const logger: any = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const tool = new SearchTools(client, {} as any, logger).getTools()[0];
    handler = tool.handler as any;
  });

  it('buildTagTerm uses bracket syntax', () => {
    expect(buildTagTerm('status', 'active')).toBe('[status=active]');
    expect(buildTagTerm('status')).toBe('[status]');
    expect(buildTagTerm('a]b', '[c')).toBe('[ab=c]');
  });

  it('sends [name=value] and never {tag:...}', async () => {
    await handler({ query: 'x', filters: { tag: { name: 'status', value: 'active' } } });
    const q = search.mock.calls[0][0].query;
    expect(q).toBe('x [status=active]');
    expect(q).not.toContain('{tag:');
  });

  it('sends [name] when only a name is given', async () => {
    await handler({ query: 'x', filters: { tag: { name: 'status' } } });
    expect(search.mock.calls[0][0].query).toBe('x [status]');
  });

  it('maps the shelf type to bookshelf', async () => {
    await handler({ query: 'x', filters: { type: 'shelf' } });
    expect(search.mock.calls[0][0].query).toBe('x {type:bookshelf}');
  });

  it('documents the bracket syntax in the tool description', () => {
    const client: any = {};
    const tool = new SearchTools(client, {} as any, {} as any).getTools()[0];
    const desc = (tool.inputSchema as any).properties.query.description as string;
    expect(desc).toContain('[tag=value]');
    expect(desc).toContain('silently discarded');
  });
});

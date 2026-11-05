import { ServerInfoTools } from '../../src/tools/server-info';

describe('bookstack_usage_examples', () => {
  const logger: any = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const tools = new (ServerInfoTools as any)({}, {}, logger).getTools();
  const tool = tools.find((t: any) => t.name === 'bookstack_usage_examples');

  it('resolves every advertised workflow value', async () => {
    const values: string[] = tool.inputSchema.properties.workflow.enum;
    expect(values.length).toBeGreaterThan(0);
    for (const workflow of values) {
      const r = await tool.handler({ workflow });
      expect(r.error).toBeUndefined();
      expect(r.title).toBeDefined();
    }
  });

  it('returns all examples when no workflow is given', async () => {
    const r = await tool.handler({});
    expect(r.examples.length).toBeGreaterThan(1);
  });
});

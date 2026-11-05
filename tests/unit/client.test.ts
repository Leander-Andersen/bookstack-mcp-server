import { BookStackClient } from '../../src/api/client';
import { ErrorHandler } from '../../src/utils/errors';

const logger: any = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const config: any = {
  bookstack: { baseUrl: 'https://bs.example/api', apiToken: 'id:secret', timeout: 5000 },
  server: { name: 'test', version: '0.0.0' },
};

function makeClient() {
  return new BookStackClient(config, logger, new ErrorHandler(logger));
}

describe('BookStackClient filter serialisation', () => {
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 })
    );
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  it('sends boolean filters as 1/0 for pages', async () => {
    await makeClient().listPages({ filter: { draft: true, template: false } } as any);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('filter[draft]=1');
    expect(url).toContain('filter[template]=0');
    expect(url).not.toContain('true');
    expect(url).not.toContain('false');
  });

  it('sends mfa_enforced as 1/0 for roles', async () => {
    await makeClient().listRoles({ filter: { mfa_enforced: true } } as any);
    expect(fetchMock.mock.calls[0][0]).toContain('filter[mfa_enforced]=1');
  });

  it('leaves string and numeric filters untouched', async () => {
    await makeClient().listPages({ count: 10, filter: { name: 'a b', book_id: 5 } } as any);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('count=10');
    expect(url).toContain('filter[name]=a%20b');
    expect(url).toContain('filter[book_id]=5');
  });
});

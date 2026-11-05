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

describe('BookStackClient retry', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    (global as any).fetch = realFetch;
    jest.restoreAllMocks();
  });

  const ok = () => new Response(JSON.stringify({ data: [], total: 0 }), { status: 200 });

  function clientWithoutSleep() {
    const c = makeClient();
    const sleep = jest.spyOn(c as any, 'sleep').mockResolvedValue(undefined);
    return { c, sleep };
  }

  it('retries a GET after 503 and then succeeds', async () => {
    const f = jest.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(ok());
    (global as any).fetch = f;
    const { c, sleep } = clientWithoutSleep();
    await expect(c.listBooks()).resolves.toEqual({ data: [], total: 0 });
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('honours Retry-After on 429', async () => {
    const f = jest.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(ok());
    (global as any).fetch = f;
    const { c, sleep } = clientWithoutSleep();
    await c.listBooks();
    expect(sleep).toHaveBeenCalledWith(2250);
  });

  it('does not replay a POST after 503', async () => {
    const f = jest.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    (global as any).fetch = f;
    const { c } = clientWithoutSleep();
    await expect(c.createBook({ name: 'x' } as any)).rejects.toBeDefined();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('replays a POST after 429 (rejected before the route ran)', async () => {
    const f = jest.fn()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 200 }));
    (global as any).fetch = f;
    const { c } = clientWithoutSleep();
    await expect(c.createBook({ name: 'x' } as any)).resolves.toEqual({ id: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('gives up after the attempt limit', async () => {
    const f = jest.fn().mockImplementation(async () => new Response('{}', { status: 503 }));
    (global as any).fetch = f;
    const { c } = clientWithoutSleep();
    await expect(c.listBooks()).rejects.toBeDefined();
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 404', async () => {
    const f = jest.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    (global as any).fetch = f;
    const { c } = clientWithoutSleep();
    await expect(c.listBooks()).rejects.toBeDefined();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('BookStackClient export', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  it('returns PDF bytes intact as base64', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
    (global as any).fetch = jest.fn().mockResolvedValue(
      new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } })
    );
    const r = await makeClient().exportPage(1, 'pdf');
    expect(r.encoding).toBe('base64');
    expect(r.byte_length).toBe(bytes.length);
    expect(Array.from(Buffer.from(r.content, 'base64'))).toEqual(Array.from(bytes));
    expect(r.filename).toBe('export.pdf');
  });

  it('returns text formats as utf8', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue(
      new Response('# Hei æøå', { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } })
    );
    const r = await makeClient().exportPage(1, 'markdown');
    expect(r.encoding).toBe('utf8');
    expect(r.content).toBe('# Hei æøå');
    expect(r.byte_length).toBe(Buffer.byteLength('# Hei æøå'));
    expect(r.filename).toBe('export.md');
  });
});

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { ErrorHandler } from '../../src/utils/errors';
import { PageContentError, PageStaleError } from '../../src/utils/page-content';

const logger: any = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('ErrorHandler page-content errors', () => {
  const handler = new ErrorHandler(logger);

  it('maps PageContentError to InvalidParams and keeps the details', () => {
    const e = handler.handleError(new PageContentError('not unique', { occurrences: 2 }));
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect((e.data as any).type).toBe('page_content_error');
    expect((e.data as any).occurrences).toBe(2);
    expect(e.message).toContain('not unique');
  });

  it('maps PageStaleError to InvalidRequest', () => {
    const e = handler.handleError(new PageStaleError('moved', { actual_updated_at: 'x' }));
    expect(e.code).toBe(ErrorCode.InvalidRequest);
    expect((e.data as any).type).toBe('concurrent_modification');
  });
});

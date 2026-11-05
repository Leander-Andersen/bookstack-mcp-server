import { Config } from '../config/manager';
import { Logger } from '../utils/logger';
import { ErrorHandler } from '../utils/errors';
import {
  BookStackAPIClient,
  Book,
  BookWithContents,
  Page,
  PageWithContent,
  Chapter,
  ChapterWithPages,
  Bookshelf,
  BookshelfWithBooks,
  User,
  UserWithRoles,
  Role,
  RoleWithPermissions,
  Attachment,
  Image,
  SearchResult,
  RecycleBinItem,
  ContentPermissions,
  AuditLogEntry,
  SystemInfo,
  ListResponse,
  BooksListParams,
  PagesListParams,
  ChaptersListParams,
  ShelvesListParams,
  UsersListParams,
  RolesListParams,
  AttachmentsListParams,
  SearchParams,
  ImageGalleryListParams,
  AuditLogListParams,
  CreateBookParams,
  UpdateBookParams,
  CreatePageParams,
  UpdatePageParams,
  CreateChapterParams,
  UpdateChapterParams,
  CreateShelfParams,
  UpdateShelfParams,
  CreateUserParams,
  UpdateUserParams,
  CreateRoleParams,
  UpdateRoleParams,
  CreateAttachmentParams,
  UpdateAttachmentParams,
  CreateImageParams,
  UpdateImageParams,
  UpdateContentPermissionsParams,
  ExportFormat,
  ExportResult,
  ContentType,
  PaginationParams,
} from '../types';

// Retry policy: see BookStackClient.fetchWithRetry.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 4_000;
const RETRY_MAX_TOTAL_WAIT_MS = 10_000;
const RETRYABLE_STATUSES = [502, 503, 504];
const REPLAY_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * BookStack API Client
 *
 * Wraps the BookStack REST API using the native fetch API,
 * compatible with both Cloudflare Workers and Node.js 18+.
 */
export class BookStackClient implements BookStackAPIClient {
  private logger: Logger;
  private errorHandler: ErrorHandler;
  private config: Config;
  private baseHeaders: Record<string, string>;

  constructor(config: Config, logger: Logger, errorHandler: ErrorHandler) {
    this.config = config;
    this.logger = logger;
    this.errorHandler = errorHandler;
    this.baseHeaders = {
      'Authorization': `Token ${config.bookstack.apiToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': `${config.server.name}/${config.server.version}`,
    };

    this.logger.info('BookStack API client initialized', {
      baseUrl: config.bookstack.baseUrl,
      timeout: config.bookstack.timeout,
    });
  }

  /**
   * Wait helper, split out so tests can stub it.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Compute the wait before retry `attempt` (1-based). A server-directed
   * Retry-After (seconds) wins; otherwise exponential backoff with jitter.
   */
  private retryDelayMs(response: Response | undefined, attempt: number): number {
    const header = response?.headers.get('Retry-After');
    if (header) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000) + 250;
    }
    const exp = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    return Math.round(exp * (1 + Math.random() * 0.25));
  }

  /**
   * fetch with bounded retries. Only replayable requests are retried:
   *  - 429 is retried for every method (the throttle rejects before the route runs);
   *  - 502/503/504 and network failures are retried only for GET/HEAD/OPTIONS,
   *    since a write may already have been applied.
   * Retry waits are capped in total so a Worker request never sleeps for long.
   * Returns the final response (which may be a non-OK one); network errors that
   * survive all attempts are thrown through the error handler.
   */
  private async fetchWithRetry(url: string, init: RequestInit, method: string): Promise<Response> {
    const safe = REPLAY_SAFE_METHODS.includes(method.toUpperCase());
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      let response: Response | undefined;
      let networkError: unknown;
      try {
        response = await fetch(url, { ...init, signal: AbortSignal.timeout(this.config.bookstack.timeout) });
      } catch (error) {
        networkError = error;
      }

      const retryable = response
        ? response.status === 429 || (safe && RETRYABLE_STATUSES.includes(response.status))
        : safe;

      if (retryable && attempt < RETRY_MAX_ATTEMPTS) {
        const delay = this.retryDelayMs(response, attempt);
        if (waited + delay <= RETRY_MAX_TOTAL_WAIT_MS) {
          this.logger.debug('Retrying request', { method, url, attempt, status: response?.status, delayMs: delay });
          await response?.body?.cancel().catch(() => undefined);
          waited += delay;
          await this.sleep(delay);
          continue;
        }
      }

      if (response) return response;
      this.logger.error('Fetch network error', { url, method, error: String(networkError) });
      throw this.errorHandler.handleError(networkError);
    }
  }

  /**
   * Generic JSON request method
   */
  private async request<T>(
    method: string,
    path: string,
    data?: unknown,
    params?: Record<string, unknown>
  ): Promise<T> {
    let url = `${this.config.bookstack.baseUrl}${path}`;
    if (params && Object.keys(params).length > 0) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'object' && !Array.isArray(v)) {
          // Flatten nested objects as PHP bracket notation: filter[name]=foo
          // Use literal brackets (not %5B%5D) so BookStack/Laravel parses them correctly.
          for (const [subK, subV] of Object.entries(v as Record<string, unknown>)) {
            if (subV !== undefined && subV !== null) {
              // BookStack compares filter values against tinyint columns, and the
              // string "true"/"false" coerces to 0 there, which returns the opposite
              // rows. Send booleans as 1/0.
              const wire = typeof subV === 'boolean' ? (subV ? '1' : '0') : String(subV);
              parts.push(`${k}[${subK}]=${encodeURIComponent(wire)}`);
            }
          }
        } else {
          parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        }
      }
      if (parts.length > 0) url += '?' + parts.join('&');
    }

    this.logger.debug('API request', { method, url });

    const init: RequestInit = {
      method,
      headers: this.baseHeaders,
    };

    if (data !== undefined) {
      init.body = JSON.stringify(data);
    }

    const response = await this.fetchWithRetry(url, init, method);

    this.logger.debug('API response', { status: response.status, url });

    if (!response.ok) {
      const body = await response.text();
      throw this.errorHandler.handleFetchError(response.status, url, method, body);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    try {
      return await response.json() as T;
    } catch (error) {
      throw this.errorHandler.handleError(error);
    }
  }

  /**
   * Decode base64 → Uint8Array. Tolerates data-URI prefixes ("data:image/png;base64,...").
   */
  private decodeBase64(s: string): Uint8Array {
    const cleaned = s.replace(/^data:[^;]+;base64,/, '');
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /**
   * Sniff the file extension from magic bytes. Falls back to "bin".
   * BookStack uses the filename extension for MIME validation, so getting
   * this right matters even though we don't set a Content-Type on the Blob.
   */
  private sniffExtension(bytes: Uint8Array): string {
    if (bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpg';
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
    if (bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
    if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
    return 'bin';
  }

  /**
   * multipart/form-data POST. Strips the JSON Content-Type so fetch sets
   * "multipart/form-data; boundary=..." automatically. Used for binary
   * uploads (images, attachments) where BookStack does not accept JSON.
   *
   * fileFields: keys whose values are base64 strings to be decoded into Blob
   *             parts; all other entries are sent as plain form fields.
   */
  private async requestMultipart<T>(
    method: 'POST' | 'PUT',
    path: string,
    fields: Record<string, unknown>,
    fileFields: { key: string; nameBase: string }[],
  ): Promise<T> {
    const url = `${this.config.bookstack.baseUrl}${path}`;
    const form = new FormData();

    // Laravel routing quirk: PUT + multipart/form-data does not populate $request->all()
    // in many Laravel versions. The reliable workaround is POST + _method=PUT.
    let actualMethod: 'POST' | 'PUT' = method;
    if (method === 'PUT') {
      form.append('_method', 'PUT');
      actualMethod = 'POST';
    }

    const fileKeys = new Set(fileFields.map(f => f.key));
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      if (fileKeys.has(k)) continue;
      form.append(k, String(v));
    }

    for (const { key, nameBase } of fileFields) {
      const raw = fields[key];
      if (typeof raw !== 'string' || !raw) continue;
      const bytes = this.decodeBase64(raw);
      const ext = this.sniffExtension(bytes);
      const filename = `${(nameBase || key).replace(/[^a-zA-Z0-9._-]/g, '_')}.${ext}`;
      // BodyInit: Blob wraps the bytes; no explicit type — Laravel infers from the filename.
      form.append(key, new Blob([bytes]), filename);
    }

    // Copy auth header, drop Content-Type so fetch sets the multipart boundary.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.baseHeaders)) {
      if (k.toLowerCase() === 'content-type') continue;
      headers[k] = v;
    }

    this.logger.debug('API multipart request', { method: actualMethod, url, fields: Object.keys(fields) });

    let response: Response;
    try {
      response = await fetch(url, {
        method: actualMethod,
        headers,
        body: form,
        signal: AbortSignal.timeout(this.config.bookstack.timeout),
      });
    } catch (error) {
      this.logger.error('Fetch network error (multipart)', { url, method: actualMethod, error: String(error) });
      throw this.errorHandler.handleError(error);
    }

    if (!response.ok) {
      const body = await response.text();
      throw this.errorHandler.handleFetchError(response.status, url, actualMethod, body);
    }

    if (response.status === 204) return undefined as T;
    try {
      return await response.json() as T;
    } catch (error) {
      throw this.errorHandler.handleError(error);
    }
  }

  /**
   * Request that returns raw text (used for export endpoints)
   */
  private async requestText(
    method: string,
    path: string
  ): Promise<ExportResult> {
    const url = `${this.config.bookstack.baseUrl}${path}`;

    this.logger.debug('API export request', { method, url });

    const response = await this.fetchWithRetry(
      url,
      { method, headers: this.baseHeaders },
      method
    );

    if (!response.ok) {
      const body = await response.text();
      throw this.errorHandler.handleFetchError(response.status, url, method, body);
    }

    const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
    const parts = path.split('/');
    const format = parts[parts.length - 1];

    // Read bytes, never text(): decoding a PDF as UTF-8 replaces invalid
    // sequences with U+FFFD and corrupts the file. Binary formats are returned
    // base64-encoded; text formats are decoded as UTF-8.
    const bytes = new Uint8Array(await response.arrayBuffer());
    const isText = format !== 'pdf' && /^(text\/|application\/(json|xml|xhtml))/i.test(mimeType);
    const extension = format === 'plaintext' ? 'txt' : format === 'markdown' ? 'md' : format;

    return {
      content: isText ? new TextDecoder('utf-8').decode(bytes) : this.encodeBase64(bytes),
      encoding: isText ? 'utf8' : 'base64',
      byte_length: bytes.length,
      filename: `export.${extension}`,
      mime_type: mimeType,
    };
  }

  /**
   * Encode bytes as base64 (chunked so large PDFs do not overflow the call stack).
   */
  private encodeBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /**
   * Health check method
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getSystemInfo();
      return true;
    } catch (error) {
      this.logger.warn('Health check failed', error);
      return false;
    }
  }

  /**
   * Fetch every item from a paginated list endpoint, splitting into parallel
   * batches of `pageSize` once the first response reveals the total count.
   */
  async fetchAll<T>(path: string, params: Record<string, unknown>, pageSize = 500): Promise<T[]> {
    const first = await this.request<ListResponse<T>>('GET', path, undefined, { ...params, count: pageSize, offset: 0 });
    const all: T[] = [...first.data];

    if (first.total > pageSize) {
      const extraPages = Math.ceil((first.total - pageSize) / pageSize);
      const requests = Array.from({ length: extraPages }, (_, i) =>
        this.request<ListResponse<T>>('GET', path, undefined, { ...params, count: pageSize, offset: (i + 1) * pageSize })
      );
      const pages = await Promise.all(requests);
      for (const page of pages) all.push(...page.data);
    }

    return all;
  }

  /**
   * List with optional client-side name filtering (partial, case-insensitive).
   * When filter.name is present we fetch all items and match locally because
   * BookStack's filter[name] only supports exact match.
   */
  private async listWithNameFilter<T extends { name: string }>(
    path: string,
    params: Record<string, unknown>
  ): Promise<ListResponse<T>> {
    const filter = (params.filter ?? {}) as Record<string, unknown>;
    const nameQuery = filter.name as string | undefined;

    if (!nameQuery) {
      return this.request<ListResponse<T>>('GET', path, undefined, params);
    }

    // Strip name from filter before hitting the API
    const { name: _n, ...restFilter } = filter;
    const apiParams = Object.keys(restFilter).length > 0
      ? { ...params, filter: restFilter }
      : (({ filter: _f, ...rest }) => rest)(params);

    const all = await this.fetchAll<T>(path, apiParams);
    const needle = nameQuery.toLowerCase();
    const matched = all.filter(item => item.name.toLowerCase().includes(needle));
    return { data: matched, total: matched.length };
  }

  // Books API
  async listBooks(params?: BooksListParams): Promise<ListResponse<Book>> {
    return this.listWithNameFilter<Book>('/books', params as unknown as Record<string, unknown> ?? {});
  }

  async createBook(params: CreateBookParams): Promise<Book> {
    return this.request<Book>('POST', '/books', params);
  }

  async getBook(id: number): Promise<BookWithContents> {
    return this.request<BookWithContents>('GET', `/books/${id}`);
  }

  async updateBook(id: number, params: UpdateBookParams): Promise<Book> {
    return this.request<Book>('PUT', `/books/${id}`, params);
  }

  async deleteBook(id: number): Promise<void> {
    await this.request<void>('DELETE', `/books/${id}`);
  }

  async exportBook(id: number, format: ExportFormat): Promise<ExportResult> {
    return this.requestText('GET', `/books/${id}/export/${format}`);
  }

  // Pages API
  async listPages(params?: PagesListParams): Promise<ListResponse<Page>> {
    return this.request<ListResponse<Page>>('GET', '/pages', undefined, params as unknown as Record<string, unknown>);
  }

  async createPage(params: CreatePageParams): Promise<Page> {
    return this.request<Page>('POST', '/pages', params);
  }

  async getPage(id: number): Promise<PageWithContent> {
    return this.request<PageWithContent>('GET', `/pages/${id}`);
  }

  async updatePage(id: number, params: UpdatePageParams): Promise<Page> {
    return this.request<Page>('PUT', `/pages/${id}`, params);
  }

  async deletePage(id: number): Promise<void> {
    await this.request<void>('DELETE', `/pages/${id}`);
  }

  async exportPage(id: number, format: ExportFormat): Promise<ExportResult> {
    return this.requestText('GET', `/pages/${id}/export/${format}`);
  }

  // Chapters API
  async listChapters(params?: ChaptersListParams): Promise<ListResponse<Chapter>> {
    return this.request<ListResponse<Chapter>>('GET', '/chapters', undefined, params as unknown as Record<string, unknown>);
  }

  async createChapter(params: CreateChapterParams): Promise<Chapter> {
    return this.request<Chapter>('POST', '/chapters', params);
  }

  async getChapter(id: number): Promise<ChapterWithPages> {
    return this.request<ChapterWithPages>('GET', `/chapters/${id}`);
  }

  async updateChapter(id: number, params: UpdateChapterParams): Promise<Chapter> {
    return this.request<Chapter>('PUT', `/chapters/${id}`, params);
  }

  async deleteChapter(id: number): Promise<void> {
    await this.request<void>('DELETE', `/chapters/${id}`);
  }

  async exportChapter(id: number, format: ExportFormat): Promise<ExportResult> {
    return this.requestText('GET', `/chapters/${id}/export/${format}`);
  }

  // Shelves API
  async listShelves(params?: ShelvesListParams): Promise<ListResponse<Bookshelf>> {
    return this.listWithNameFilter<Bookshelf>('/shelves', params as unknown as Record<string, unknown> ?? {});
  }

  async createShelf(params: CreateShelfParams): Promise<Bookshelf> {
    return this.request<Bookshelf>('POST', '/shelves', params);
  }

  async getShelf(id: number): Promise<BookshelfWithBooks> {
    return this.request<BookshelfWithBooks>('GET', `/shelves/${id}`);
  }

  async updateShelf(id: number, params: UpdateShelfParams): Promise<Bookshelf> {
    return this.request<Bookshelf>('PUT', `/shelves/${id}`, params);
  }

  async deleteShelf(id: number): Promise<void> {
    await this.request<void>('DELETE', `/shelves/${id}`);
  }

  // Users API
  async listUsers(params?: UsersListParams): Promise<ListResponse<User>> {
    return this.request<ListResponse<User>>('GET', '/users', undefined, params as unknown as Record<string, unknown>);
  }

  async createUser(params: CreateUserParams): Promise<User> {
    return this.request<User>('POST', '/users', params);
  }

  async getUser(id: number): Promise<UserWithRoles> {
    return this.request<UserWithRoles>('GET', `/users/${id}`);
  }

  async updateUser(id: number, params: UpdateUserParams): Promise<User> {
    return this.request<User>('PUT', `/users/${id}`, params);
  }

  async deleteUser(id: number, migrateOwnershipId?: number): Promise<void> {
    const data = migrateOwnershipId ? { migrate_ownership_id: migrateOwnershipId } : undefined;
    await this.request<void>('DELETE', `/users/${id}`, data);
  }

  // Roles API
  async listRoles(params?: RolesListParams): Promise<ListResponse<Role>> {
    return this.request<ListResponse<Role>>('GET', '/roles', undefined, params as unknown as Record<string, unknown>);
  }

  async createRole(params: CreateRoleParams): Promise<Role> {
    return this.request<Role>('POST', '/roles', params);
  }

  async getRole(id: number): Promise<RoleWithPermissions> {
    return this.request<RoleWithPermissions>('GET', `/roles/${id}`);
  }

  async updateRole(id: number, params: UpdateRoleParams): Promise<Role> {
    return this.request<Role>('PUT', `/roles/${id}`, params);
  }

  async deleteRole(id: number): Promise<void> {
    await this.request<void>('DELETE', `/roles/${id}`);
  }

  // Attachments API
  async listAttachments(params?: AttachmentsListParams): Promise<ListResponse<Attachment>> {
    return this.request<ListResponse<Attachment>>('GET', '/attachments', undefined, params as unknown as Record<string, unknown>);
  }

  async createAttachment(params: CreateAttachmentParams): Promise<Attachment> {
    // BookStack accepts file attachments only as multipart/form-data; link
    // attachments still work as JSON.
    if ((params as any).file) {
      return this.requestMultipart<Attachment>(
        'POST',
        '/attachments',
        params as unknown as Record<string, unknown>,
        [{ key: 'file', nameBase: params.name }],
      );
    }
    return this.request<Attachment>('POST', '/attachments', params);
  }

  async getAttachment(id: number): Promise<Attachment> {
    return this.request<Attachment>('GET', `/attachments/${id}`);
  }

  async updateAttachment(id: number, params: UpdateAttachmentParams): Promise<Attachment> {
    if ((params as any).file) {
      return this.requestMultipart<Attachment>(
        'PUT',
        `/attachments/${id}`,
        params as unknown as Record<string, unknown>,
        [{ key: 'file', nameBase: params.name ?? `attachment-${id}` }],
      );
    }
    return this.request<Attachment>('PUT', `/attachments/${id}`, params);
  }

  async deleteAttachment(id: number): Promise<void> {
    await this.request<void>('DELETE', `/attachments/${id}`);
  }

  // Images API
  async listImages(params?: ImageGalleryListParams): Promise<ListResponse<Image>> {
    return this.request<ListResponse<Image>>('GET', '/image-gallery', undefined, params as unknown as Record<string, unknown>);
  }

  async createImage(params: CreateImageParams): Promise<Image> {
    // BookStack's /image-gallery POST requires multipart/form-data — the
    // image field must be a real file part, not a base64 string in JSON.
    return this.requestMultipart<Image>(
      'POST',
      '/image-gallery',
      params as unknown as Record<string, unknown>,
      [{ key: 'image', nameBase: params.name }],
    );
  }

  async getImage(id: number): Promise<Image> {
    return this.request<Image>('GET', `/image-gallery/${id}`);
  }

  async updateImage(id: number, params: UpdateImageParams): Promise<Image> {
    // If the caller is uploading new bytes, go multipart; otherwise a JSON
    // PUT (rename only) is fine.
    if ((params as any).image) {
      return this.requestMultipart<Image>(
        'PUT',
        `/image-gallery/${id}`,
        params as unknown as Record<string, unknown>,
        [{ key: 'image', nameBase: params.name ?? `image-${id}` }],
      );
    }
    return this.request<Image>('PUT', `/image-gallery/${id}`, params);
  }

  async deleteImage(id: number): Promise<void> {
    await this.request<void>('DELETE', `/image-gallery/${id}`);
  }

  // Search API
  async search(params: SearchParams): Promise<ListResponse<SearchResult>> {
    return this.request<ListResponse<SearchResult>>('GET', '/search', undefined, params as unknown as Record<string, unknown>);
  }

  // Recycle Bin API
  async listRecycleBin(params?: PaginationParams): Promise<ListResponse<RecycleBinItem>> {
    return this.request<ListResponse<RecycleBinItem>>('GET', '/recycle-bin', undefined, params as unknown as Record<string, unknown>);
  }

  async restoreFromRecycleBin(deletionId: number): Promise<void> {
    await this.request<void>('PUT', `/recycle-bin/${deletionId}`);
  }

  async permanentlyDelete(deletionId: number): Promise<void> {
    await this.request<void>('DELETE', `/recycle-bin/${deletionId}`);
  }

  // Content Permissions API
  async getContentPermissions(contentType: ContentType, contentId: number): Promise<ContentPermissions> {
    return this.request<ContentPermissions>('GET', `/content-permissions/${contentType}/${contentId}`);
  }

  async updateContentPermissions(
    contentType: ContentType,
    contentId: number,
    params: UpdateContentPermissionsParams
  ): Promise<ContentPermissions> {
    return this.request<ContentPermissions>('PUT', `/content-permissions/${contentType}/${contentId}`, params);
  }

  // Audit Log API
  async listAuditLog(params?: AuditLogListParams): Promise<ListResponse<AuditLogEntry>> {
    let mapped: Record<string, unknown> = { ...(params as any) };
    let dateFrom: string | undefined;
    let dateTo: string | undefined;

    if (mapped.filter && typeof mapped.filter === 'object') {
      const f = { ...(mapped.filter as any) };

      // Remap entity_type → loggable_type (BookStack API naming)
      if (f.entity_type !== undefined) {
        f.loggable_type = f.entity_type;
        delete f.entity_type;
      }

      // BookStack API does not support date filtering — extract and apply client-side
      if (f.date_from !== undefined) { dateFrom = f.date_from; delete f.date_from; }
      if (f.date_to   !== undefined) { dateTo   = f.date_to;   delete f.date_to;   }

      mapped = { ...mapped, filter: f };
    }

    if (!dateFrom && !dateTo) {
      return this.request<ListResponse<AuditLogEntry>>('GET', '/audit-log', undefined, mapped);
    }

    // Date filtering: fetch all entries matching the other filters, then filter client-side
    const { count, offset, ...fetchParams } = mapped as any;
    const all = await this.fetchAll<AuditLogEntry>('/audit-log', fetchParams);

    const from = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
    const to   = dateTo   ? new Date(dateTo + 'T23:59:59Z').getTime() : Infinity;

    const filtered = all.filter((entry: any) => {
      const t = new Date(entry.created_at).getTime();
      return t >= from && t <= to;
    });

    const pageOffset = offset ?? 0;
    const pageCount  = count  ?? 20;
    return {
      data: filtered.slice(pageOffset, pageOffset + pageCount),
      total: filtered.length,
    };
  }

  // System API
  async getSystemInfo(): Promise<SystemInfo> {
    return this.request<SystemInfo>('GET', '/system');
  }
}

export default BookStackClient;

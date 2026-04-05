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
              parts.push(`${k}[${subK}]=${encodeURIComponent(String(subV))}`);
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
      signal: AbortSignal.timeout(this.config.bookstack.timeout),
    };

    if (data !== undefined) {
      init.body = JSON.stringify(data);
    }

    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      this.logger.error('Fetch network error', { url, method, error: String(error) });
      throw this.errorHandler.handleError(error);
    }

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
   * Request that returns raw text (used for export endpoints)
   */
  private async requestText(
    method: string,
    path: string
  ): Promise<ExportResult> {
    const url = `${this.config.bookstack.baseUrl}${path}`;

    this.logger.debug('API export request', { method, url });

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.baseHeaders,
        signal: AbortSignal.timeout(this.config.bookstack.timeout),
      });
    } catch (error) {
      this.logger.error('Fetch network error', { url, method, error: String(error) });
      throw this.errorHandler.handleError(error);
    }

    if (!response.ok) {
      const body = await response.text();
      throw this.errorHandler.handleFetchError(response.status, url, method, body);
    }

    const content = await response.text();
    const mimeType = response.headers.get('content-type') ?? 'application/octet-stream';
    const parts = path.split('/');
    const format = parts[parts.length - 1];

    return {
      content,
      filename: `export.${format}`,
      mime_type: mimeType,
    };
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

  async deleteRole(id: number, migrateOwnershipId?: number): Promise<void> {
    const data = migrateOwnershipId ? { migrate_ownership_id: migrateOwnershipId } : undefined;
    await this.request<void>('DELETE', `/roles/${id}`, data);
  }

  // Attachments API
  async listAttachments(params?: AttachmentsListParams): Promise<ListResponse<Attachment>> {
    return this.request<ListResponse<Attachment>>('GET', '/attachments', undefined, params as unknown as Record<string, unknown>);
  }

  async createAttachment(params: CreateAttachmentParams): Promise<Attachment> {
    return this.request<Attachment>('POST', '/attachments', params);
  }

  async getAttachment(id: number): Promise<Attachment> {
    return this.request<Attachment>('GET', `/attachments/${id}`);
  }

  async updateAttachment(id: number, params: UpdateAttachmentParams): Promise<Attachment> {
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
    return this.request<Image>('POST', '/image-gallery', params);
  }

  async getImage(id: number): Promise<Image> {
    return this.request<Image>('GET', `/image-gallery/${id}`);
  }

  async updateImage(id: number, params: UpdateImageParams): Promise<Image> {
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
    if (mapped.filter && typeof mapped.filter === 'object') {
      const f = { ...(mapped.filter as any) };

      // Remap entity_type → loggable_type (BookStack API naming)
      if (f.entity_type !== undefined) {
        f.loggable_type = f.entity_type;
        delete f.entity_type;
      }

      // BookStack expects date_from / date_to as top-level params, not under filter[]
      if (f.date_from !== undefined) { mapped.date_from = f.date_from; delete f.date_from; }
      if (f.date_to   !== undefined) { mapped.date_to   = f.date_to;   delete f.date_to;   }

      mapped = { ...mapped, filter: f };
    }
    return this.request<ListResponse<AuditLogEntry>>('GET', '/audit-log', undefined, mapped);
  }

  // System API
  async getSystemInfo(): Promise<SystemInfo> {
    return this.request<SystemInfo>('GET', '/system');
  }
}

export default BookStackClient;

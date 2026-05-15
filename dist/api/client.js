"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookStackClient = void 0;
/**
 * BookStack API Client
 *
 * Wraps the BookStack REST API using the native fetch API,
 * compatible with both Cloudflare Workers and Node.js 18+.
 */
class BookStackClient {
    constructor(config, logger, errorHandler) {
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
    async request(method, path, data, params) {
        let url = `${this.config.bookstack.baseUrl}${path}`;
        if (params && Object.keys(params).length > 0) {
            const parts = [];
            for (const [k, v] of Object.entries(params)) {
                if (v === undefined || v === null)
                    continue;
                if (typeof v === 'object' && !Array.isArray(v)) {
                    // Flatten nested objects as PHP bracket notation: filter[name]=foo
                    // Use literal brackets (not %5B%5D) so BookStack/Laravel parses them correctly.
                    for (const [subK, subV] of Object.entries(v)) {
                        if (subV !== undefined && subV !== null) {
                            parts.push(`${k}[${subK}]=${encodeURIComponent(String(subV))}`);
                        }
                    }
                }
                else {
                    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
                }
            }
            if (parts.length > 0)
                url += '?' + parts.join('&');
        }
        this.logger.debug('API request', { method, url });
        const init = {
            method,
            headers: this.baseHeaders,
            signal: AbortSignal.timeout(this.config.bookstack.timeout),
        };
        if (data !== undefined) {
            init.body = JSON.stringify(data);
        }
        let response;
        try {
            response = await fetch(url, init);
        }
        catch (error) {
            this.logger.error('Fetch network error', { url, method, error: String(error) });
            throw this.errorHandler.handleError(error);
        }
        this.logger.debug('API response', { status: response.status, url });
        if (!response.ok) {
            const body = await response.text();
            throw this.errorHandler.handleFetchError(response.status, url, method, body);
        }
        if (response.status === 204) {
            return undefined;
        }
        try {
            return await response.json();
        }
        catch (error) {
            throw this.errorHandler.handleError(error);
        }
    }
    /**
     * Request that returns raw text (used for export endpoints)
     */
    async requestText(method, path) {
        const url = `${this.config.bookstack.baseUrl}${path}`;
        this.logger.debug('API export request', { method, url });
        let response;
        try {
            response = await fetch(url, {
                method,
                headers: this.baseHeaders,
                signal: AbortSignal.timeout(this.config.bookstack.timeout),
            });
        }
        catch (error) {
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
    async healthCheck() {
        try {
            await this.getSystemInfo();
            return true;
        }
        catch (error) {
            this.logger.warn('Health check failed', error);
            return false;
        }
    }
    /**
     * Fetch every item from a paginated list endpoint, splitting into parallel
     * batches of `pageSize` once the first response reveals the total count.
     */
    async fetchAll(path, params, pageSize = 500) {
        const first = await this.request('GET', path, undefined, { ...params, count: pageSize, offset: 0 });
        const all = [...first.data];
        if (first.total > pageSize) {
            const extraPages = Math.ceil((first.total - pageSize) / pageSize);
            const requests = Array.from({ length: extraPages }, (_, i) => this.request('GET', path, undefined, { ...params, count: pageSize, offset: (i + 1) * pageSize }));
            const pages = await Promise.all(requests);
            for (const page of pages)
                all.push(...page.data);
        }
        return all;
    }
    /**
     * List with optional client-side name filtering (partial, case-insensitive).
     * When filter.name is present we fetch all items and match locally because
     * BookStack's filter[name] only supports exact match.
     */
    async listWithNameFilter(path, params) {
        const filter = (params.filter ?? {});
        const nameQuery = filter.name;
        if (!nameQuery) {
            return this.request('GET', path, undefined, params);
        }
        // Strip name from filter before hitting the API
        const { name: _n, ...restFilter } = filter;
        const apiParams = Object.keys(restFilter).length > 0
            ? { ...params, filter: restFilter }
            : (({ filter: _f, ...rest }) => rest)(params);
        const all = await this.fetchAll(path, apiParams);
        const needle = nameQuery.toLowerCase();
        const matched = all.filter(item => item.name.toLowerCase().includes(needle));
        return { data: matched, total: matched.length };
    }
    // Books API
    async listBooks(params) {
        return this.listWithNameFilter('/books', params ?? {});
    }
    async createBook(params) {
        return this.request('POST', '/books', params);
    }
    async getBook(id) {
        return this.request('GET', `/books/${id}`);
    }
    async updateBook(id, params) {
        return this.request('PUT', `/books/${id}`, params);
    }
    async deleteBook(id) {
        await this.request('DELETE', `/books/${id}`);
    }
    async exportBook(id, format) {
        return this.requestText('GET', `/books/${id}/export/${format}`);
    }
    // Pages API
    async listPages(params) {
        return this.request('GET', '/pages', undefined, params);
    }
    async createPage(params) {
        return this.request('POST', '/pages', params);
    }
    async getPage(id) {
        return this.request('GET', `/pages/${id}`);
    }
    async updatePage(id, params) {
        return this.request('PUT', `/pages/${id}`, params);
    }
    async deletePage(id) {
        await this.request('DELETE', `/pages/${id}`);
    }
    async exportPage(id, format) {
        return this.requestText('GET', `/pages/${id}/export/${format}`);
    }
    // Chapters API
    async listChapters(params) {
        return this.request('GET', '/chapters', undefined, params);
    }
    async createChapter(params) {
        return this.request('POST', '/chapters', params);
    }
    async getChapter(id) {
        return this.request('GET', `/chapters/${id}`);
    }
    async updateChapter(id, params) {
        return this.request('PUT', `/chapters/${id}`, params);
    }
    async deleteChapter(id) {
        await this.request('DELETE', `/chapters/${id}`);
    }
    async exportChapter(id, format) {
        return this.requestText('GET', `/chapters/${id}/export/${format}`);
    }
    // Shelves API
    async listShelves(params) {
        return this.listWithNameFilter('/shelves', params ?? {});
    }
    async createShelf(params) {
        return this.request('POST', '/shelves', params);
    }
    async getShelf(id) {
        return this.request('GET', `/shelves/${id}`);
    }
    async updateShelf(id, params) {
        return this.request('PUT', `/shelves/${id}`, params);
    }
    async deleteShelf(id) {
        await this.request('DELETE', `/shelves/${id}`);
    }
    // Users API
    async listUsers(params) {
        return this.request('GET', '/users', undefined, params);
    }
    async createUser(params) {
        return this.request('POST', '/users', params);
    }
    async getUser(id) {
        return this.request('GET', `/users/${id}`);
    }
    async updateUser(id, params) {
        return this.request('PUT', `/users/${id}`, params);
    }
    async deleteUser(id, migrateOwnershipId) {
        const data = migrateOwnershipId ? { migrate_ownership_id: migrateOwnershipId } : undefined;
        await this.request('DELETE', `/users/${id}`, data);
    }
    // Roles API
    async listRoles(params) {
        return this.request('GET', '/roles', undefined, params);
    }
    async createRole(params) {
        return this.request('POST', '/roles', params);
    }
    async getRole(id) {
        return this.request('GET', `/roles/${id}`);
    }
    async updateRole(id, params) {
        return this.request('PUT', `/roles/${id}`, params);
    }
    async deleteRole(id, migrateOwnershipId) {
        const data = migrateOwnershipId ? { migrate_ownership_id: migrateOwnershipId } : undefined;
        await this.request('DELETE', `/roles/${id}`, data);
    }
    // Attachments API
    async listAttachments(params) {
        return this.request('GET', '/attachments', undefined, params);
    }
    async createAttachment(params) {
        return this.request('POST', '/attachments', params);
    }
    async getAttachment(id) {
        return this.request('GET', `/attachments/${id}`);
    }
    async updateAttachment(id, params) {
        return this.request('PUT', `/attachments/${id}`, params);
    }
    async deleteAttachment(id) {
        await this.request('DELETE', `/attachments/${id}`);
    }
    // Images API
    async listImages(params) {
        return this.request('GET', '/image-gallery', undefined, params);
    }
    async createImage(params) {
        return this.request('POST', '/image-gallery', params);
    }
    async getImage(id) {
        return this.request('GET', `/image-gallery/${id}`);
    }
    async updateImage(id, params) {
        return this.request('PUT', `/image-gallery/${id}`, params);
    }
    async deleteImage(id) {
        await this.request('DELETE', `/image-gallery/${id}`);
    }
    // Search API
    async search(params) {
        return this.request('GET', '/search', undefined, params);
    }
    // Recycle Bin API
    async listRecycleBin(params) {
        return this.request('GET', '/recycle-bin', undefined, params);
    }
    async restoreFromRecycleBin(deletionId) {
        await this.request('PUT', `/recycle-bin/${deletionId}`);
    }
    async permanentlyDelete(deletionId) {
        await this.request('DELETE', `/recycle-bin/${deletionId}`);
    }
    // Content Permissions API
    async getContentPermissions(contentType, contentId) {
        return this.request('GET', `/content-permissions/${contentType}/${contentId}`);
    }
    async updateContentPermissions(contentType, contentId, params) {
        return this.request('PUT', `/content-permissions/${contentType}/${contentId}`, params);
    }
    // Audit Log API
    async listAuditLog(params) {
        let mapped = { ...params };
        let dateFrom;
        let dateTo;
        if (mapped.filter && typeof mapped.filter === 'object') {
            const f = { ...mapped.filter };
            // Remap entity_type → loggable_type (BookStack API naming)
            if (f.entity_type !== undefined) {
                f.loggable_type = f.entity_type;
                delete f.entity_type;
            }
            // BookStack API does not support date filtering — extract and apply client-side
            if (f.date_from !== undefined) {
                dateFrom = f.date_from;
                delete f.date_from;
            }
            if (f.date_to !== undefined) {
                dateTo = f.date_to;
                delete f.date_to;
            }
            mapped = { ...mapped, filter: f };
        }
        if (!dateFrom && !dateTo) {
            return this.request('GET', '/audit-log', undefined, mapped);
        }
        // Date filtering: fetch all entries matching the other filters, then filter client-side
        const { count, offset, ...fetchParams } = mapped;
        const all = await this.fetchAll('/audit-log', fetchParams);
        const from = dateFrom ? new Date(dateFrom).getTime() : -Infinity;
        const to = dateTo ? new Date(dateTo + 'T23:59:59Z').getTime() : Infinity;
        const filtered = all.filter((entry) => {
            const t = new Date(entry.created_at).getTime();
            return t >= from && t <= to;
        });
        const pageOffset = offset ?? 0;
        const pageCount = count ?? 20;
        return {
            data: filtered.slice(pageOffset, pageOffset + pageCount),
            total: filtered.length,
        };
    }
    // System API
    async getSystemInfo() {
        return this.request('GET', '/system');
    }
}
exports.BookStackClient = BookStackClient;
exports.default = BookStackClient;
//# sourceMappingURL=client.js.map
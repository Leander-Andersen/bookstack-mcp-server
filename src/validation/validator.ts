import { z } from 'zod';

/**
 * Validation schemas for BookStack entities
 */
const ValidationSchemas = {
  // Pagination
  pagination: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.string().optional(),
  }),

  // Books
  booksList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'created_at', 'updated_at']).default('name'),
    filter: z.object({
      name: z.string().optional(),
      created_by: z.number().optional(),
    }).optional(),
  }),

  bookCreate: z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    default_template_id: z.number().optional(),
  }),

  bookUpdate: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    default_template_id: z.number().optional(),
  }),

  // Pages
  pagesList: z.object({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'created_at', 'updated_at', 'priority']).default('name'),
    filter: z.object({
      book_id: z.number().optional(),
      chapter_id: z.number().optional(),
      name: z.string().optional(),
      draft: z.boolean().optional(),
      template: z.boolean().optional(),
    }).optional(),
  }),

  pageCreate: z.object({
    book_id: z.number().optional(),
    chapter_id: z.number().optional(),
    name: z.string().min(1).max(255),
    html: z.string().optional(),
    markdown: z.string().optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    priority: z.number().optional(),
  }).refine(data => data.html || data.markdown, {
    message: "Either html or markdown content is required",
  }).refine(data => data.book_id || data.chapter_id, {
    message: "Either book_id or chapter_id is required",
  }),

  pageUpdate: z.object({
    book_id: z.number().optional(),
    chapter_id: z.number().optional(),
    name: z.string().min(1).max(255).optional(),
    html: z.string().optional(),
    markdown: z.string().optional(),
    tags: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })).optional(),
    priority: z.number().optional(),
  }),

  // Page reads: every option beyond `id` is opt-in, so a bare { id } call is unchanged.
  pageRead: z.object({
    id: z.number().int().positive(),
    // Literal search, capped so one result cannot smuggle a whole large page through.
    grep: z.string().min(1).max(1000).optional(),
    case_sensitive: z.boolean().default(false),
    context: z.number().int().min(1).max(2000).default(200),
    max_matches: z.number().int().min(1).max(50).default(10),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).optional(),
    metadata_only: z.boolean().default(false),
  }),

  // Literal find-and-replace. old_string is non-empty (an empty anchor matches nothing
  // meaningful); new_string may be empty, which deletes the anchored text.
  pageEdit: z.strictObject({
    id: z.number().int().positive(),
    edits: z.array(z.strictObject({
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().default(false),
    })).min(1),
    dry_run: z.boolean().default(false),
    // Compared as a string against the page's current updated_at: never parsed or reformatted.
    expected_updated_at: z.string().min(1).optional(),
    allow_shrink: z.boolean().default(false),
  }),

  pageAppend: z.strictObject({
    id: z.number().int().positive(),
    content: z.string().min(1),
    position: z.enum(['start', 'end']).default('end'),
    section: z.string().min(1).optional(),
    separator: z.string().optional(),
    dry_run: z.boolean().default(false),
    expected_updated_at: z.string().min(1).optional(),
  }),

  // Chapters
  chaptersList: z.strictObject({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'created_at', 'updated_at', 'priority']).default('name'),
    filter: z.strictObject({
      book_id: z.number().optional(),
      name: z.string().optional(),
    }).optional(),
  }),

  chapterCreate: z.strictObject({
    name: z.string().min(1).max(255),
    book_id: z.number(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.strictObject({
      name: z.string(),
      value: z.string(),
    })).optional(),
    priority: z.number().optional(),
  }),

  chapterUpdate: z.strictObject({
    name: z.string().min(1).max(255).optional(),
    book_id: z.number().optional(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.strictObject({
      name: z.string(),
      value: z.string(),
    })).optional(),
    priority: z.number().optional(),
  }),

  // Shelves
  shelvesList: z.strictObject({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'created_at', 'updated_at']).default('name'),
    filter: z.strictObject({
      name: z.string().optional(),
      created_by: z.number().optional(),
    }).optional(),
  }),

  shelfCreate: z.strictObject({
    name: z.string().min(1).max(255),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.strictObject({
      name: z.string(),
      value: z.string(),
    })).optional(),
    books: z.array(z.number()).optional(),
  }),

  shelfUpdate: z.strictObject({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1900).optional(),
    description_html: z.string().max(2000).optional(),
    tags: z.array(z.strictObject({
      name: z.string(),
      value: z.string(),
    })).optional(),
    books: z.array(z.number()).optional(),
  }),

  // Users
  usersList: z.strictObject({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'email', 'created_at', 'updated_at']).default('name'),
    filter: z.strictObject({
      name: z.string().optional(),
      email: z.string().optional(),
    }).optional(),
  }),

  userCreate: z.strictObject({
    name: z.string().min(1).max(255),
    email: z.string().email().max(255),
    password: z.string().min(8).optional(),
    roles: z.array(z.number()).optional(),
    send_invite: z.boolean().optional(),
  }),

  userUpdate: z.strictObject({
    name: z.string().min(1).max(255).optional(),
    email: z.string().email().max(255).optional(),
    password: z.string().min(8).optional(),
    roles: z.array(z.number()).optional(),
  }),

  // Roles
  rolesList: z.strictObject({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['display_name', 'created_at', 'updated_at']).default('display_name'),
  }),

  roleCreate: z.strictObject({
    display_name: z.string().min(1).max(255),
    description: z.string().max(1900).optional(),
    external_auth_id: z.string().optional(),
    permissions: z.array(z.string()).optional(),
    mfa_enforced: z.boolean().optional(),
  }),

  roleUpdate: z.strictObject({
    display_name: z.string().min(1).max(255).optional(),
    description: z.string().max(1900).optional(),
    external_auth_id: z.string().optional(),
    permissions: z.array(z.string()).optional(),
    mfa_enforced: z.boolean().optional(),
  }),

  // Attachments
  attachmentsList: z.strictObject({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'extension', 'uploaded_to', 'created_at', 'updated_at']).default('name'),
    filter: z.strictObject({
      name: z.string().optional(),
      uploaded_to: z.number().optional(),
      extension: z.string().optional(),
    }).optional(),
  }),

  attachmentCreate: z.strictObject({
    uploaded_to: z.number(),
    name: z.string().min(1).max(255),
    file: z.string().optional(), // base64 encoded
    link: z.string().url().optional(),
  }).refine(data => data.file || data.link, {
    message: "Either file or link is required",
  }),

  attachmentUpdate: z.strictObject({
    uploaded_to: z.number().optional(),
    name: z.string().min(1).max(255).optional(),
    file: z.string().optional(), // base64 encoded
    link: z.string().url().optional(),
  }),

  // Images
  imagesList: z.strictObject({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['name', 'created_at', 'updated_at']).default('name'),
    filter: z.strictObject({
      name: z.string().optional(),
      type: z.enum(['gallery', 'drawio']).optional(),
    }).optional(),
  }),

  imageCreate: z.strictObject({
    name: z.string().min(1).max(255),
    image: z.string(), // base64 encoded
    type: z.enum(['gallery', 'drawio']).default('gallery'),
  }),

  imageUpdate: z.strictObject({
    name: z.string().min(1).max(255).optional(),
    image: z.string().optional(), // base64 encoded
  }),

  // Search
  search: z.strictObject({
    query: z.string().default(''),
    page: z.number().min(1).default(1),
    count: z.number().min(1).max(100).default(20),
  }),

  // Audit Log
  auditLogList: z.strictObject({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['created_at', 'type', 'user_id']).default('created_at'),
    filter: z.strictObject({
      type: z.string().optional(),
      user_id: z.number().optional(),
      entity_type: z.string().optional(),
      entity_id: z.number().optional(),
      date_from: z.string().optional(),
      date_to: z.string().optional(),
    }).optional(),
  }),

  // Content Permissions
  contentPermissionsUpdate: z.strictObject({
    role_permissions: z.array(z.strictObject({
      role_id: z.number(),
      view: z.boolean(),
      create: z.boolean(),
      update: z.boolean(),
      delete: z.boolean(),
    })).optional(),
    fallback_permissions: z.strictObject({
      inheriting: z.boolean(),
      view: z.boolean().optional(),
      create: z.boolean().optional(),
      update: z.boolean().optional(),
      delete: z.boolean().optional(),
    }).optional(),
  }),

  // Export
  export: z.strictObject({
    id: z.number(),
    format: z.enum(['html', 'pdf', 'plaintext', 'markdown']),
  }),

  // Generic ID parameter
  id: z.strictObject({
    id: z.number().positive(),
  }),

  // Recycle bin operations
  recycleBinList: z.strictObject({
    count: z.number().min(1).max(500).default(20),
    offset: z.number().min(0).default(0),
    sort: z.enum(['deleted_at', 'deletable_type', 'deletable_id']).default('deleted_at'),
  }),

  recycleBinOperation: z.strictObject({
    deletion_id: z.number().positive(),
  }),

  // Content permissions
  contentPermissions: z.strictObject({
    content_type: z.enum(['bookshelf', 'book', 'chapter', 'page']),
    content_id: z.number().positive(),
  }),
};

export type PageReadRequest = z.infer<typeof ValidationSchemas.pageRead>;
export type PageEditRequest = z.infer<typeof ValidationSchemas.pageEdit>;
export type PageAppendRequest = z.infer<typeof ValidationSchemas.pageAppend>;

/**
 * Validation handler
 */
export class ValidationHandler {
  private enabled: boolean;
  private strictMode: boolean;

  constructor(config: { enabled: boolean; strictMode: boolean }) {
    this.enabled = config.enabled;
    this.strictMode = config.strictMode;
  }

  /**
   * Validate parameters against a schema
   */
  validateParams<T>(params: any, schemaName: keyof typeof ValidationSchemas): T {
    if (!this.enabled) {
      return params as T;
    }

    const schema = ValidationSchemas[schemaName];
    if (!schema) {
      throw new Error(`No validation schema found for ${schemaName}`);
    }

    try {
      return schema.parse(params) as T;
    } catch (error) {
      if (this.strictMode) {
        throw error;
      }
      
      // In non-strict mode, log the error but continue with original params
      console.warn(`Validation warning for ${schemaName}:`, (error as Error).message);
      return params as T;
    }
  }

  /**
   * Validate required fields are present
   */
  validateRequired(params: any, requiredFields: string[]): void {
    if (!this.enabled) {
      return;
    }

    const missing = requiredFields.filter(field => 
      params[field] === undefined || params[field] === null
    );

    if (missing.length > 0) {
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }
  }

  /**
   * Validate ID parameter
   */
  validateId(id: any): number {
    if (!this.enabled) {
      return Number(id);
    }

    const parsed = ValidationSchemas.id.parse({ id: Number(id) });
    return parsed.id;
  }

  /**
   * Get available schemas
   */
  getAvailableSchemas(): string[] {
    return Object.keys(ValidationSchemas);
  }
}

export default ValidationHandler;
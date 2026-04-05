import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from './logger';

/**
 * Error handler for BookStack MCP Server
 */
export class ErrorHandler {
  private errorMappings = {
    400: { type: 'validation_error', message: 'Invalid request parameters' },
    401: { type: 'authentication_error', message: 'Invalid or missing authentication token' },
    403: { type: 'permission_error', message: 'Insufficient permissions for this operation' },
    404: { type: 'not_found_error', message: 'Requested resource not found' },
    422: { type: 'validation_error', message: 'Validation failed' },
    429: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    500: { type: 'server_error', message: 'Internal server error' },
    502: { type: 'server_error', message: 'Bad gateway' },
    503: { type: 'server_error', message: 'Service unavailable' },
    504: { type: 'server_error', message: 'Gateway timeout' },
  };

  constructor(private logger: Logger) {}

  /**
   * Handle fetch HTTP errors (non-2xx responses)
   */
  handleFetchError(status: number, url: string, method: string, body: string): McpError {
    const mapping = this.errorMappings[status as keyof typeof this.errorMappings] || {
      type: 'unknown_error',
      message: 'Unknown error occurred',
    };

    let details: unknown;
    try {
      details = JSON.parse(body);
    } catch {
      details = body;
    }

    const mcpError = new McpError(
      this.mapToMCPErrorCode(status),
      mapping.message,
      {
        type: mapping.type,
        status,
        details,
        url,
        method,
      }
    );

    this.logger.error('Fetch error handled', {
      status,
      type: mapping.type,
      url,
      method,
    });

    return mcpError;
  }

  /**
   * Handle generic errors
   */
  handleError(error: any): McpError {
    if (error instanceof McpError) {
      return error;
    }

    // Handle validation errors from Zod
    if (error.name === 'ZodError') {
      const validationDetails = error.errors.map((err: any) => ({
        field: err.path.join('.'),
        message: err.message,
      }));

      return new McpError(
        ErrorCode.InvalidParams,
        'Validation failed',
        {
          type: 'validation_error',
          validation: validationDetails,
        }
      );
    }

    // Handle generic errors
    const mcpError = new McpError(
      ErrorCode.InternalError,
      error.message || 'An unexpected error occurred',
      {
        type: 'internal_error',
        stack: error.stack,
      }
    );

    this.logger.error('Generic error handled', {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });

    return mcpError;
  }

  /**
   * Map HTTP status codes to MCP error codes
   */
  private mapToMCPErrorCode(status?: number): ErrorCode {
    switch (status) {
      case 400:
      case 422:
        return ErrorCode.InvalidParams;
      case 401:
        return ErrorCode.InvalidRequest;
      case 403:
        return ErrorCode.InvalidRequest;
      case 404:
        return ErrorCode.InvalidRequest;
      case 429:
        return ErrorCode.InternalError;
      case 500:
      case 502:
      case 503:
      case 504:
        return ErrorCode.InternalError;
      default:
        return ErrorCode.InternalError;
    }
  }

  /**
   * Create a user-friendly error message
   */
  getUserFriendlyMessage(error: any): string {
    if (error instanceof McpError) {
      return error.message;
    }

    return 'An unexpected error occurred';
  }
}

export default ErrorHandler;

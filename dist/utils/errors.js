"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorHandler = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
/**
 * Error handler for BookStack MCP Server
 */
class ErrorHandler {
    constructor(logger) {
        this.logger = logger;
        this.errorMappings = {
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
    }
    /**
     * Handle fetch HTTP errors (non-2xx responses)
     */
    handleFetchError(status, url, method, body) {
        const mapping = this.errorMappings[status] || {
            type: 'unknown_error',
            message: 'Unknown error occurred',
        };
        // Try to extract a short BookStack-provided error message without leaking the full body.
        let upstreamMessage;
        try {
            const parsed = JSON.parse(body);
            const candidate = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
            if (typeof candidate === 'string') {
                upstreamMessage = candidate.slice(0, 200);
            }
        }
        catch {
            // body wasn't JSON — discard rather than echoing potentially sensitive text.
        }
        const mcpError = new types_js_1.McpError(this.mapToMCPErrorCode(status), upstreamMessage ? `${mapping.message}: ${upstreamMessage}` : mapping.message, {
            type: mapping.type,
            status,
        });
        this.logger.error('Fetch error handled', {
            status,
            type: mapping.type,
            url,
            method,
            body,
        });
        return mcpError;
    }
    /**
     * Handle generic errors
     */
    handleError(error) {
        if (error instanceof types_js_1.McpError) {
            return error;
        }
        // Handle validation errors from Zod
        if (error.name === 'ZodError') {
            const validationDetails = error.errors.map((err) => ({
                field: err.path.join('.'),
                message: err.message,
            }));
            return new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, 'Validation failed', {
                type: 'validation_error',
                validation: validationDetails,
            });
        }
        // Stack traces stay in server logs, never in the response to the client.
        this.logger.error('Generic error handled', {
            message: error.message,
            stack: error.stack,
            name: error.name,
        });
        return new types_js_1.McpError(types_js_1.ErrorCode.InternalError, 'An unexpected error occurred', { type: 'internal_error' });
    }
    /**
     * Map HTTP status codes to MCP error codes
     */
    mapToMCPErrorCode(status) {
        switch (status) {
            case 400:
            case 422:
                return types_js_1.ErrorCode.InvalidParams;
            case 401:
                return types_js_1.ErrorCode.InvalidRequest;
            case 403:
                return types_js_1.ErrorCode.InvalidRequest;
            case 404:
                return types_js_1.ErrorCode.InvalidRequest;
            case 429:
                return types_js_1.ErrorCode.InternalError;
            case 500:
            case 502:
            case 503:
            case 504:
                return types_js_1.ErrorCode.InternalError;
            default:
                return types_js_1.ErrorCode.InternalError;
        }
    }
    /**
     * Create a user-friendly error message
     */
    getUserFriendlyMessage(error) {
        if (error instanceof types_js_1.McpError) {
            return error.message;
        }
        return 'An unexpected error occurred';
    }
}
exports.ErrorHandler = ErrorHandler;
exports.default = ErrorHandler;
//# sourceMappingURL=errors.js.map
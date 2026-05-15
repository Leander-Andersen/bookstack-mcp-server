import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { Logger } from './logger';
/**
 * Error handler for BookStack MCP Server
 */
export declare class ErrorHandler {
    private logger;
    private errorMappings;
    constructor(logger: Logger);
    /**
     * Handle fetch HTTP errors (non-2xx responses)
     */
    handleFetchError(status: number, url: string, method: string, body: string): McpError;
    /**
     * Handle generic errors
     */
    handleError(error: any): McpError;
    /**
     * Map HTTP status codes to MCP error codes
     */
    private mapToMCPErrorCode;
    /**
     * Create a user-friendly error message
     */
    getUserFriendlyMessage(error: any): string;
}
export default ErrorHandler;
//# sourceMappingURL=errors.d.ts.map
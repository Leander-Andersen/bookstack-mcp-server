/**
 * Logger utility — console-based, compatible with Cloudflare Workers and Node.js
 */
export declare class Logger {
    private static instance;
    private constructor();
    static getInstance(): Logger;
    private format;
    debug(message: string, meta?: any): void;
    info(message: string, meta?: any): void;
    warn(message: string, meta?: any): void;
    error(message: string, meta?: any): void;
    child(_meta: any): Logger;
}
export default Logger;
//# sourceMappingURL=logger.d.ts.map
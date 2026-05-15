"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
/**
 * Logger utility — console-based, compatible with Cloudflare Workers and Node.js
 */
class Logger {
    constructor() { }
    static getInstance() {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }
    format(level, message, meta) {
        const ts = new Date().toISOString();
        const metaStr = meta !== undefined ? ' ' + JSON.stringify(meta) : '';
        return `${ts} [${level.toUpperCase()}] ${message}${metaStr}`;
    }
    debug(message, meta) {
        console.debug(this.format('debug', message, meta));
    }
    info(message, meta) {
        console.info(this.format('info', message, meta));
    }
    warn(message, meta) {
        console.warn(this.format('warn', message, meta));
    }
    error(message, meta) {
        console.error(this.format('error', message, meta));
    }
    child(_meta) {
        return Logger.getInstance();
    }
}
exports.Logger = Logger;
exports.default = Logger;
//# sourceMappingURL=logger.js.map
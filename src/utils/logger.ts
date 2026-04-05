/**
 * Logger utility — console-based, compatible with Cloudflare Workers and Node.js
 */
export class Logger {
  private static instance: Logger;

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private format(level: string, message: string, meta?: any): string {
    const ts = new Date().toISOString();
    const metaStr = meta !== undefined ? ' ' + JSON.stringify(meta) : '';
    return `${ts} [${level.toUpperCase()}] ${message}${metaStr}`;
  }

  debug(message: string, meta?: any): void {
    console.debug(this.format('debug', message, meta));
  }

  info(message: string, meta?: any): void {
    console.info(this.format('info', message, meta));
  }

  warn(message: string, meta?: any): void {
    console.warn(this.format('warn', message, meta));
  }

  error(message: string, meta?: any): void {
    console.error(this.format('error', message, meta));
  }

  child(_meta: any): Logger {
    return Logger.getInstance();
  }
}

export default Logger;

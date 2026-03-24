import { type BrowserLaunchOptions } from './browser.js';
export interface StartMcpServerOptions {
    host?: string;
    port?: number;
    allowedHosts?: string[];
    httpsCert?: string;
    httpsKey?: string;
    browserDefaults?: Pick<BrowserLaunchOptions, 'browser' | 'browserPath' | 'cdpUrl' | 'userDataDir' | 'timeoutMs'>;
}
/**
 * Start a Claude-compatible Streamable HTTP MCP server with optional direct TLS.
 */
export declare function startMcpServer(options?: StartMcpServerOptions): Promise<void>;

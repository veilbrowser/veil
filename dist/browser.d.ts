import { Browser, BrowserContext, Page } from 'playwright';
export interface BrowserLaunchOptions {
    headed?: boolean;
    platform?: string;
    browser?: string;
    browserPath?: string;
    cdpUrl?: string;
    userDataDir?: string;
    timeoutMs?: number | string;
}
/**
 * Ensure a browser session is available, creating or attaching as needed.
 */
export declare function ensureBrowser(opts?: BrowserLaunchOptions): Promise<{
    browser: Browser;
    context: BrowserContext;
    page: Page;
}>;
/**
 * Return the current live page if the browser is still open.
 */
export declare function getPage(): Promise<Page | null>;
/**
 * Persist the current storage state when requested and close veil-owned resources.
 */
export declare function closeBrowser(platform?: string): Promise<void>;
/**
 * Sleep for a short human-like randomized delay.
 */
export declare function humanDelay(min?: number, max?: number): Promise<void>;

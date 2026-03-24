import { constants as fsConstants, promises as fs } from 'fs';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { resolve } from 'path';
import { loadSession, saveSession } from './session.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 30000;

type BrowserBackend = 'playwright' | 'chrome' | 'dia';
type CloseTarget = 'browser' | 'context' | 'none';
type LaunchOptions = NonNullable<Parameters<typeof chromium.launch>[0]>;
type PersistentLaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;
type NewContextOptions = NonNullable<Parameters<Browser['newContext']>[0]>;

interface KnownBrowserConfig {
  executablePaths?: string[];
  channel?: LaunchOptions['channel'];
}

interface ResolvedBrowserOptions {
  browser: BrowserBackend;
  browserPath?: string;
  cdpUrl?: string;
  userDataDir?: string;
  headed: boolean;
  platform?: string;
  timeoutMs: number;
}

export interface BrowserLaunchOptions {
  headed?: boolean;
  platform?: string;
  browser?: string;
  browserPath?: string;
  cdpUrl?: string;
  userDataDir?: string;
  timeoutMs?: number | string;
}

const KNOWN_BROWSERS: Record<BrowserBackend, KnownBrowserConfig> = {
  playwright: {},
  chrome: {
    executablePaths: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    channel: 'chrome',
  },
  dia: {
    executablePaths: [
      '/Applications/Dia.app/Contents/MacOS/Dia',
    ],
  },
};

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
let _page: Page | null = null;
let _closeTarget: CloseTarget = 'browser';
let _exitHandlerRegistered = false;

/**
 * Resolve a CLI option or environment variable override.
 */
function resolveOption(value: string | number | undefined, envKey: string): string | undefined {
  if (value !== undefined) return String(value);
  return process.env[envKey];
}

/**
 * Normalize a path-like option to an absolute path.
 */
function normalizePath(value?: string): string | undefined {
  if (!value) return undefined;
  return resolve(value);
}

/**
 * Validate and normalize the requested browser launch mode.
 */
async function resolveBrowserOptions(opts: BrowserLaunchOptions): Promise<ResolvedBrowserOptions> {
  const browserName = (resolveOption(opts.browser, 'VEIL_BROWSER') ?? 'playwright').toLowerCase();
  const browserPath = normalizePath(resolveOption(opts.browserPath, 'VEIL_BROWSER_PATH'));
  const cdpUrl = resolveOption(opts.cdpUrl, 'VEIL_CDP_URL');
  const userDataDir = normalizePath(resolveOption(opts.userDataDir, 'VEIL_USER_DATA_DIR'));
  const timeoutMs = parseTimeout(resolveOption(opts.timeoutMs, 'VEIL_BROWSER_TIMEOUT_MS'));

  if (!isKnownBrowser(browserName) && !browserPath) {
    throw new Error(
      `Unsupported browser "${browserName}". Use one of: ${Object.keys(KNOWN_BROWSERS).join(', ')} or pass --browser-path.`,
    );
  }

  if (cdpUrl && userDataDir) {
    throw new Error('Use either --cdp-url or --user-data-dir, not both.');
  }

  if (cdpUrl) validateCdpUrl(cdpUrl);
  if (browserPath) await ensureExecutable(browserPath);
  if (userDataDir) await ensureDirectory(userDataDir);

  return {
    browser: (isKnownBrowser(browserName) ? browserName : 'playwright') as BrowserBackend,
    browserPath,
    cdpUrl,
    userDataDir,
    headed: !!opts.headed,
    platform: opts.platform,
    timeoutMs,
  };
}

/**
 * Check whether the requested browser name is one of veil's built-in targets.
 */
function isKnownBrowser(value: string): value is BrowserBackend {
  return value === 'playwright' || value === 'chrome' || value === 'dia';
}

/**
 * Parse a timeout input into a positive millisecond value.
 */
function parseTimeout(value?: string): number {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid timeout "${value}". Expected a positive integer in milliseconds.`);
  }
  return parsed;
}

/**
 * Validate that the requested CDP endpoint is well-formed.
 */
function validateCdpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid CDP URL "${url}". Expected http(s)://host:port or ws(s)://...`);
  }

  const protocols = new Set(['http:', 'https:', 'ws:', 'wss:']);
  if (!protocols.has(parsed.protocol)) {
    throw new Error(`Unsupported CDP protocol "${parsed.protocol}". Use http, https, ws, or wss.`);
  }
}

/**
 * Verify that the requested browser executable exists and is runnable.
 */
async function ensureExecutable(pathValue: string): Promise<void> {
  try {
    await fs.access(pathValue, fsConstants.X_OK);
  } catch {
    throw new Error(`Browser executable is not accessible: ${pathValue}`);
  }
}

/**
 * Verify that the requested browser profile directory exists and is writable.
 */
async function ensureDirectory(pathValue: string): Promise<void> {
  await fs.mkdir(pathValue, { recursive: true });
  try {
    await fs.access(pathValue, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new Error(`Browser profile directory is not readable and writable: ${pathValue}`);
  }
}

/**
 * Locate a known browser executable on the current machine.
 */
async function resolveExecutablePath(browser: BrowserBackend): Promise<string | undefined> {
  const candidates = KNOWN_BROWSERS[browser].executablePaths ?? [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next configured candidate.
    }
  }
  return undefined;
}

/**
 * Build Playwright launch options for an ephemeral browser instance.
 */
async function buildLaunchOptions(config: ResolvedBrowserOptions): Promise<LaunchOptions> {
  const options: LaunchOptions = {
    headless: !config.headed,
    timeout: config.timeoutMs,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1280,800',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-default-apps',
    ],
  };

  if (config.browserPath) {
    options.executablePath = config.browserPath;
    return options;
  }

  const executablePath = await resolveExecutablePath(config.browser);
  if (executablePath) {
    options.executablePath = executablePath;
    return options;
  }

  const channel = KNOWN_BROWSERS[config.browser].channel;
  if (channel) {
    options.channel = channel;
    return options;
  }

  if (config.browser !== 'playwright') {
    throw new Error(`Could not locate a ${config.browser} executable. Install it or pass --browser-path.`);
  }

  return options;
}

/**
 * Build new-context options, restoring saved storage state when available.
 */
function buildContextOptions(storageState: unknown | null): NewContextOptions {
  const options: NewContextOptions = {
    viewport: { width: 1280, height: 800 },
    userAgent: UA,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    ignoreHTTPSErrors: true,
  };

  if (storageState) {
    options.storageState = storageState as NewContextOptions['storageState'];
  }

  return options;
}

/**
 * Apply veil's anti-detection browser shims to a browser context.
 */
async function applyStealthContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'chromeapp', { get: () => undefined });
    (window as typeof window & { chrome?: { runtime: object } }).chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

    const permissionShim = {
      query: (_permissionDesc: PermissionDescriptor) =>
        Promise.resolve({ state: Notification.permission } as unknown as PermissionStatus),
    };
    Object.defineProperty(window.navigator, 'permissions', {
      configurable: true,
      value: permissionShim,
    });

    const originalToString = Function.prototype.toString;
    Function.prototype.toString = function toString(): string {
      if (this === permissionShim.query) {
        return 'function query() { [native code] }';
      }
      return originalToString.call(this);
    };
  });
}

/**
 * Open a fresh browser instance for one-shot veil operations.
 */
async function launchEphemeralBrowser(
  config: ResolvedBrowserOptions,
  storageState: unknown | null,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  const browser = await chromium.launch(await buildLaunchOptions(config));
  const context = await browser.newContext(buildContextOptions(storageState));
  await applyStealthContext(context);
  const page = await context.newPage();

  _browser = browser;
  _context = context;
  _page = page;
  _closeTarget = 'browser';

  return { browser, context, page };
}

/**
 * Open a persistent browser profile backed by a user-data directory.
 */
async function launchPersistentBrowser(
  config: ResolvedBrowserOptions,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (!config.userDataDir) {
    throw new Error('Persistent browser launch requires a user data directory.');
  }

  const persistentOptions: PersistentLaunchOptions = {
    ...(await buildLaunchOptions(config)),
    ...buildContextOptions(null),
  };

  const context = await chromium.launchPersistentContext(config.userDataDir, persistentOptions);
  await applyStealthContext(context);
  const browser = context.browser();
  if (!browser) {
    await context.close();
    throw new Error('Persistent browser launch succeeded but no browser handle was returned.');
  }

  const page = context.pages()[0] ?? await context.newPage();

  _browser = browser;
  _context = context;
  _page = page;
  _closeTarget = 'context';

  return { browser, context, page };
}

/**
 * Attach to a manually launched Chromium browser via CDP.
 */
async function connectToExistingBrowser(
  config: ResolvedBrowserOptions,
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (!config.cdpUrl) {
    throw new Error('CDP browser attach requires a CDP URL.');
  }

  const browser = await chromium.connectOverCDP(config.cdpUrl, { timeout: config.timeoutMs });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error(`No browser context is available at ${config.cdpUrl}. Open a normal tab in the target browser and try again.`);
  }

  await applyStealthContext(context);
  const page = context.pages()[0] ?? await context.newPage();

  _browser = browser;
  _context = context;
  _page = page;
  _closeTarget = 'none';

  return { browser, context, page };
}

/**
 * Register a single process-exit hook that respects veil's close policy.
 */
function registerExitHandler(): void {
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;
  process.once('exit', () => {
    void closeBrowser();
  });
}

/**
 * Ensure a browser session is available, creating or attaching as needed.
 */
export async function ensureBrowser(
  opts: BrowserLaunchOptions = {},
): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (_browser?.isConnected() && _context && _page && !_page.isClosed()) {
    return { browser: _browser, context: _context, page: _page };
  }

  const config = await resolveBrowserOptions(opts);
  const storageState = config.platform ? await loadSession(config.platform).catch(() => null) : null;
  registerExitHandler();

  if (config.cdpUrl) {
    return connectToExistingBrowser(config);
  }

  if (config.userDataDir) {
    return launchPersistentBrowser(config);
  }

  return launchEphemeralBrowser(config, storageState);
}

/**
 * Return the current live page if the browser is still open.
 */
export async function getPage(): Promise<Page | null> {
  return _page && !_page.isClosed() ? _page : null;
}

/**
 * Persist the current storage state when requested and close veil-owned resources.
 */
export async function closeBrowser(platform?: string): Promise<void> {
  if (_context && platform) {
    try {
      await saveSession(platform, await _context.storageState());
    } catch {
      // Do not let session save errors block cleanup.
    }
  }

  try {
    if (_closeTarget === 'context' && _context) {
      await _context.close();
    } else if (_closeTarget === 'browser' && _browser) {
      await _browser.close();
    }
  } catch {
    // Ignore cleanup failures; the process may already be tearing down.
  } finally {
    _browser = null;
    _context = null;
    _page = null;
    _closeTarget = 'browser';
  }
}

/**
 * Sleep for a short human-like randomized delay.
 */
export function humanDelay(min = 400, max = 900): Promise<void> {
  return new Promise((resolveDelay) =>
    setTimeout(resolveDelay, Math.floor(Math.random() * (max - min) + min)),
  );
}

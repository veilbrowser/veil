import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { closeBrowser, ensureBrowser, getPage, type BrowserLaunchOptions } from './browser.js';
import { listSessions } from './session.js';

type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';
type ServerInstance = HttpServer | HttpsServer;

const DEFAULT_MCP_PORT = 3456;
const DEFAULT_MCP_HOST = '127.0.0.1';
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
const DEFAULT_WAIT_TIMEOUT_MS = 10000;

interface McpToolResult<T extends object> {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: T;
  isError?: boolean;
}

interface JsonResponseLike {
  headersSent?: boolean;
  json(body: unknown): unknown;
  set(field: string, value: string): this;
  send(body: string): unknown;
  status(code: number): this;
}

type McpHttpRequest = IncomingMessage & { auth?: AuthInfo; body?: unknown };
type McpHttpResponse = ServerResponse & JsonResponseLike;

export interface StartMcpServerOptions {
  host?: string;
  port?: number;
  allowedHosts?: string[];
  httpsCert?: string;
  httpsKey?: string;
  browserDefaults?: Pick<BrowserLaunchOptions, 'browser' | 'browserPath' | 'cdpUrl' | 'userDataDir' | 'timeoutMs'>;
}

/**
 * Convert a successful tool payload into MCP content plus structured data.
 */
function okResult<T extends Record<string, unknown>>(payload: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * Convert an error into a client-readable MCP tool failure.
 */
function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

/**
 * Normalize unknown errors into a readable string.
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve an output path and verify that its parent directory is writable.
 */
async function resolveWritableOutputPath(pathValue?: string): Promise<string> {
  const outputPath = resolve(pathValue ?? join(process.cwd(), `veil-${Date.now()}.png`));
  const parentDir = dirname(outputPath);
  await fs.mkdir(parentDir, { recursive: true });
  await fs.access(parentDir, fsConstants.R_OK | fsConstants.W_OK);
  return outputPath;
}

/**
 * Resolve the current Playwright page or fail with an actionable message.
 */
async function requirePage() {
  const page = await getPage();
  if (!page) {
    throw new Error('No browser page is open. Use the navigate tool first.');
  }
  return page;
}

/**
 * Create the MCP server definition for veil's browser tools.
 */
function createVeilMcpServer(
  browserDefaults: StartMcpServerOptions['browserDefaults'] = {},
): McpServer {
  const server = new McpServer({
    name: 'veil-browser',
    version: '0.4.1',
  });

  server.registerTool(
    'status',
    {
      description: 'Return saved sessions and the current browser page state.',
    },
    async () => {
      try {
        const sessions = await listSessions();
        const page = await getPage();
        const payload = page
          ? { browserOpen: true, url: page.url(), title: await page.title(), sessions }
          : { browserOpen: false, sessions };
        return okResult(payload);
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'list_sessions',
    {
      description: 'List saved veil browser sessions by platform name.',
    },
    async () => {
      try {
        return okResult({ sessions: await listSessions() });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'navigate',
    {
      description: 'Open or reuse a browser and navigate to a URL, optionally restoring a saved session.',
      inputSchema: {
        url: z.url().describe('The absolute URL to open.'),
        platform: z.string().optional().describe('Saved veil session to restore before navigation.'),
        waitUntil: z
          .enum(['load', 'domcontentloaded', 'networkidle'])
          .default('domcontentloaded')
          .describe('Playwright load state to wait for before returning.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(120000)
          .default(DEFAULT_NAVIGATION_TIMEOUT_MS)
          .describe('Navigation timeout in milliseconds.'),
      },
    },
    async ({ url, platform, waitUntil, timeoutMs }) => {
      try {
        const { page } = await ensureBrowser({ ...browserDefaults, platform });
        await page.goto(url, { waitUntil: waitUntil as WaitUntil, timeout: timeoutMs });
        return okResult({ url: page.url(), title: await page.title() });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'current_page',
    {
      description: 'Return the current browser URL and page title.',
    },
    async () => {
      try {
        const page = await requirePage();
        return okResult({ url: page.url(), title: await page.title() });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'go_back',
    {
      description: 'Navigate back to the previous page in the current browser session.',
    },
    async () => {
      try {
        const page = await requirePage();
        await page.goBack();
        return okResult({ url: page.url(), title: await page.title() });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'click',
    {
      description: 'Click an element using a CSS selector.',
      inputSchema: {
        selector: z.string().describe('CSS selector to click.'),
        nth: z.number().int().min(0).default(0).describe('Zero-based match index to click.'),
        force: z.boolean().default(false).describe('Force the click through overlay issues.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(120000)
          .default(5000)
          .describe('Wait and click timeout in milliseconds.'),
      },
    },
    async ({ selector, nth, force, timeoutMs }) => {
      try {
        const page = await requirePage();
        const locator = page.locator(selector).nth(nth);
        await locator.waitFor({ timeout: timeoutMs });
        await locator.click({ force, timeout: timeoutMs });
        return okResult({ selector, nth, force });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'type_text',
    {
      description: 'Type text into an element using a CSS selector.',
      inputSchema: {
        selector: z.string().describe('CSS selector to type into.'),
        text: z.string().describe('Text to type.'),
        clear: z.boolean().default(false).describe('Clear the element before typing.'),
        delayMs: z.number().int().min(0).max(500).default(40).describe('Delay between keystrokes.'),
        nth: z.number().int().min(0).default(0).describe('Zero-based match index to target.'),
      },
    },
    async ({ selector, text, clear, delayMs, nth }) => {
      try {
        const page = await requirePage();
        const locator = page.locator(selector).nth(nth);
        await locator.waitFor({ timeout: 5000 });
        if (clear) await locator.clear();
        await locator.click({ force: true });
        await page.keyboard.type(text, { delay: delayMs });
        return okResult({ selector, typed: text, nth, cleared: clear });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'press_key',
    {
      description: 'Press a keyboard key such as Enter, Tab, Escape, or ArrowDown.',
      inputSchema: {
        key: z.string().describe('Keyboard key name to press.'),
      },
    },
    async ({ key }) => {
      try {
        const page = await requirePage();
        await page.keyboard.press(key);
        return okResult({ key });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'scroll',
    {
      description: 'Scroll the current page up, down, top, or bottom.',
      inputSchema: {
        direction: z.enum(['up', 'down', 'top', 'bottom']).describe('Direction to scroll.'),
        amount: z.number().int().positive().default(600).describe('Pixel distance for up/down scrolling.'),
      },
    },
    async ({ direction, amount }) => {
      try {
        const page = await requirePage();
        const expressions: Record<string, string> = {
          down: `window.scrollBy(0, ${amount})`,
          up: `window.scrollBy(0, -${amount})`,
          top: 'window.scrollTo(0, 0)',
          bottom: 'window.scrollTo(0, document.body.scrollHeight)',
        };
        await page.evaluate(expressions[direction] ?? expressions.down);
        return okResult({ direction, amount });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'wait',
    {
      description: 'Wait for a fixed number of milliseconds.',
      inputSchema: {
        ms: z.number().int().positive().max(300000).describe('Milliseconds to wait.'),
      },
    },
    async ({ ms }) => {
      try {
        await new Promise(resolve => setTimeout(resolve, ms));
        return okResult({ waitedMs: ms });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'wait_for',
    {
      description: 'Wait for an element to appear on the current page.',
      inputSchema: {
        selector: z.string().describe('CSS selector to wait for.'),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(120000)
          .default(DEFAULT_WAIT_TIMEOUT_MS)
          .describe('Maximum wait time in milliseconds.'),
      },
    },
    async ({ selector, timeoutMs }) => {
      try {
        const page = await requirePage();
        await page.waitForSelector(selector, { timeout: timeoutMs });
        return okResult({ selector, timeoutMs });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'snapshot',
    {
      description: 'Return a structured DOM snapshot for Claude to reason over.',
      inputSchema: {
        maxChars: z.number().int().positive().max(50000).default(8000).describe('Maximum characters to return.'),
      },
    },
    async ({ maxChars }) => {
      try {
        const page = await requirePage();
        const snapshot = await page.evaluate((max: number) => {
          function nodeToObj(el: Element, depth = 0): unknown {
            if (depth > 8) return null;
            const obj: Record<string, unknown> = {
              tag: el.tagName?.toLowerCase(),
              role: el.getAttribute('role'),
              label: el.getAttribute('aria-label'),
              testid: el.getAttribute('data-testid'),
              text: el instanceof HTMLElement && !el.children.length ? el.innerText?.slice(0, 100) : undefined,
              href: el instanceof HTMLAnchorElement ? el.href : undefined,
            };
            for (const [key, value] of Object.entries(obj)) {
              if (value === undefined) delete obj[key];
            }
            const children = Array.from(el.children)
              .map(child => nodeToObj(child, depth + 1))
              .filter(Boolean)
              .slice(0, 10);
            if (children.length) obj.children = children;
            return obj;
          }

          return JSON.stringify(nodeToObj(document.body), null, 2).slice(0, max);
        }, maxChars);

        return okResult({ url: page.url(), snapshot });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'read_text',
    {
      description: 'Read text or attribute values from the current page.',
      inputSchema: {
        selector: z.string().optional().describe('Optional CSS selector to target.'),
        all: z.boolean().default(false).describe('Return all matching text values as an array.'),
        attribute: z.string().optional().describe('Attribute name to read instead of text.'),
      },
    },
    async ({ selector, all, attribute }) => {
      try {
        const page = await requirePage();
        if (!selector) {
          const text = await page.evaluate(() => document.body.innerText);
          return okResult({ text: text.slice(0, 5000) });
        }
        if (all) {
          return okResult({ items: await page.locator(selector).allTextContents() });
        }
        if (attribute) {
          return okResult({ value: await page.locator(selector).first().getAttribute(attribute) });
        }
        return okResult({ text: await page.locator(selector).first().textContent() });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'find_text',
    {
      description: 'Check whether visible text exists on the current page.',
      inputSchema: {
        text: z.string().describe('Visible text to find.'),
      },
    },
    async ({ text }) => {
      try {
        const page = await requirePage();
        const found = await page.getByText(text).first().isVisible().catch(() => false);
        return okResult({ text, found });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'selector_exists',
    {
      description: 'Check whether a CSS selector exists on the current page.',
      inputSchema: {
        selector: z.string().describe('CSS selector to check.'),
      },
    },
    async ({ selector }) => {
      try {
        const page = await requirePage();
        const count = await page.locator(selector).count();
        return okResult({ selector, exists: count > 0, count });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'screenshot',
    {
      description: 'Take a screenshot of the current page or a specific element.',
      inputSchema: {
        path: z.string().optional().describe('Optional output path for the screenshot image.'),
        selector: z.string().optional().describe('Optional CSS selector for element screenshots.'),
        fullPage: z.boolean().default(false).describe('Capture the full page instead of the viewport.'),
      },
    },
    async ({ path, selector, fullPage }) => {
      try {
        const page = await requirePage();
        const outputPath = await resolveWritableOutputPath(path);
        if (selector) {
          await page.locator(selector).first().screenshot({ path: outputPath });
        } else {
          await page.screenshot({ path: outputPath, fullPage });
        }
        return okResult({ path: outputPath, selector: selector ?? null, fullPage });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  server.registerTool(
    'close_browser',
    {
      description: 'Close the current browser session and optionally persist its platform storage state.',
      inputSchema: {
        platform: z.string().optional().describe('Optional platform name to save before closing.'),
      },
    },
    async ({ platform }) => {
      try {
        await closeBrowser(platform);
        return okResult({ closed: true, platform: platform ?? null });
      } catch (error) {
        return errorResult(getErrorMessage(error));
      }
    },
  );

  return server;
}

/**
 * Parse a comma-separated allowed-host string into a clean host list.
 */
function parseAllowedHosts(value?: string[]): string[] | undefined {
  const hosts = (value ?? [])
    .flatMap(entry => entry.split(','))
    .map(entry => entry.trim())
    .filter(Boolean);
  return hosts.length > 0 ? hosts : undefined;
}

/**
 * Validate TLS configuration and load certificate material when present.
 */
async function resolveTlsOptions(
  certPath?: string,
  keyPath?: string,
): Promise<{ cert: Buffer; key: Buffer } | undefined> {
  if (!certPath && !keyPath) {
    return undefined;
  }

  if (!certPath || !keyPath) {
    throw new Error('Both --https-cert and --https-key are required to enable HTTPS.');
  }

  const resolvedCertPath = resolve(certPath);
  const resolvedKeyPath = resolve(keyPath);
  await fs.access(resolvedCertPath, fsConstants.R_OK);
  await fs.access(resolvedKeyPath, fsConstants.R_OK);

  return {
    cert: await fs.readFile(resolvedCertPath),
    key: await fs.readFile(resolvedKeyPath),
  };
}

/**
 * Start a Claude-compatible Streamable HTTP MCP server with optional direct TLS.
 */
export async function startMcpServer(options: StartMcpServerOptions = {}): Promise<void> {
  const host = options.host ?? DEFAULT_MCP_HOST;
  const port = options.port ?? DEFAULT_MCP_PORT;
  const allowedHosts = parseAllowedHosts(options.allowedHosts);
  const tlsOptions = await resolveTlsOptions(options.httpsCert, options.httpsKey);
  const app = createMcpExpressApp({ host, allowedHosts });

  const handleMcpRequest = async (
    req: McpHttpRequest,
    res: McpHttpResponse,
  ) => {
    const server = createVeilMcpServer(options.browserDefaults);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: getErrorMessage(error) },
          id: null,
        });
      }
    } finally {
      await transport.close();
      await server.close();
    }
  };

  app.post('/', handleMcpRequest);
  app.post('/mcp', handleMcpRequest);

  app.get('/', (_req: unknown, res: JsonResponseLike) => {
    res.json({
      name: 'veil-browser',
      transport: 'streamable-http',
      mcpEndpoint: '/mcp',
      health: '/healthz',
      https: Boolean(tlsOptions),
    });
  });

  app.get('/healthz', (_req: unknown, res: JsonResponseLike) => {
    res.json({ ok: true, service: 'veil-browser-mcp' });
  });

  app.get('/mcp', (_req: unknown, res: JsonResponseLike) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
  });

  app.delete('/', (_req: unknown, res: JsonResponseLike) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
  });

  app.delete('/mcp', (_req: unknown, res: JsonResponseLike) => {
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
  });

  const server: ServerInstance = tlsOptions
    ? createHttpsServer(tlsOptions, app)
    : createHttpServer(app);

  await new Promise<void>((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, host, () => {
      server.off('error', rejectStart);
      resolveStart();
    });
  });

  const protocol = tlsOptions ? 'https' : 'http';
  console.log(
    JSON.stringify({
      ok: true,
      transport: 'streamable-http',
      protocol,
      host,
      port,
      rootUrl: `${protocol}://${host}:${port}/`,
      mcpUrl: `${protocol}://${host}:${port}/mcp`,
      healthUrl: `${protocol}://${host}:${port}/healthz`,
      allowedHosts: allowedHosts ?? [],
    }),
  );

  let shuttingDown = false;

  /**
   * Close the HTTP listener and any veil-owned browser resources on process shutdown.
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.error(`Received ${signal}. Shutting down veil MCP server.`);

    await Promise.allSettled([
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      }),
      closeBrowser(),
    ]);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

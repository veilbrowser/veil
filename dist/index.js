#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { ensureBrowser, closeBrowser, getPage, humanDelay } from './browser.js';
import { saveSession } from './session.js';
import { getPlatform, listPlatforms, searchPlatforms } from './platforms.js';
import { startMcpServer } from './mcp.js';
const program = new Command();
program
    .name('veil')
    .description('🕶️  OpenClaw browser remote — stealth headless browser')
    .version('0.4.1');
/**
 * Add shared browser-selection options to a command that can create a browser.
 */
function addBrowserOptions(command) {
    return command
        .option('--browser <browser>', 'Browser backend: playwright, chrome, or dia')
        .option('--browser-path <path>', 'Executable path for a Chromium-compatible browser')
        .option('--cdp-url <url>', 'Attach to a running Chromium browser via CDP')
        .option('--user-data-dir <path>', 'Launch with a persistent browser profile directory')
        .option('--timeout-ms <ms>', 'Browser launch/connect timeout in milliseconds');
}
/**
 * Extract shared browser-launch options from Commander command options.
 */
function pickBrowserOptions(opts) {
    return {
        browser: opts.browser,
        browserPath: opts.browserPath,
        cdpUrl: opts.cdpUrl,
        userDataDir: opts.userDataDir,
        timeoutMs: opts.timeoutMs,
    };
}
/**
 * Parse an integer CLI option and fail fast on invalid input.
 */
function parseIntegerOption(value, label) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid ${label}: ${value}`);
    }
    return parsed;
}
// ─── Platforms Directory ──────────────────────────────────────────────────────
program
    .command('platforms')
    .description('Manage platform directory')
    .action(() => {
    console.log(chalk.blue('\n📚 Veil Platform Directory\n'));
    const platforms = listPlatforms();
    const byCategory = platforms.reduce((acc, p) => {
        acc[p.category] = (acc[p.category] || []).concat(p);
        return acc;
    }, {});
    for (const [category, proms] of Object.entries(byCategory)) {
        console.log(chalk.cyan(`  ${category.toUpperCase()} (${proms.length})`));
        proms.forEach(p => {
            console.log(chalk.gray(`    • ${p.name} — ${p.aliases.join(', ')}`));
        });
        console.log();
    }
    console.log(chalk.gray(`Total: ${platforms.length} platforms\n`));
});
program
    .command('platforms:list [category]')
    .description('List platforms by category (ai, social, dev, productivity, finance, shopping, email, other)')
    .action((category) => {
    const platforms = listPlatforms(category);
    console.log(chalk.blue(`\n📊 ${category ? `${category.toUpperCase()} Platforms` : 'All Platforms'} (${platforms.length})\n`));
    platforms.forEach(p => {
        console.log(`  ${chalk.cyan(p.name)}`);
        console.log(`    Aliases: ${p.aliases.join(', ')}`);
        if (p.notes)
            console.log(`    Notes: ${chalk.gray(p.notes)}`);
        console.log();
    });
});
program
    .command('platforms:search <query>')
    .description('Search for a platform')
    .action((query) => {
    const results = searchPlatforms(query);
    if (results.length === 0) {
        console.log(chalk.yellow(`\nNo platforms found matching "${query}"\n`));
    }
    else {
        console.log(chalk.blue(`\n🔍 Found ${results.length} platform(s):\n`));
        results.forEach(p => {
            console.log(`  ${chalk.cyan(p.name)}`);
            console.log(`    Login: ${chalk.gray(p.loginUrl)}`);
            console.log(`    Aliases: ${p.aliases.join(', ')}`);
            console.log();
        });
    }
});
// ─── Session ──────────────────────────────────────────────────────────────────
addBrowserOptions(program
    .command('login <platform>')
    .description('Open visible browser to log in and save session')
    .action(async (platformQuery, opts) => {
    const platform = getPlatform(platformQuery);
    const url = platformQuery.startsWith('http://') || platformQuery.startsWith('https://')
        ? platformQuery
        : platform?.loginUrl ?? `https://${platformQuery}`;
    const { context, page } = await ensureBrowser({
        ...pickBrowserOptions(opts),
        headed: true,
        platform: platformQuery,
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const displayName = platform?.name || platformQuery;
    console.log(chalk.cyan(`\n🔐 Log into ${displayName} in the browser window.`));
    console.log(chalk.gray('   Press Enter here when done.\n'));
    await new Promise(res => process.stdin.once('data', () => res()));
    await saveSession(platformQuery, await context.storageState());
    console.log(chalk.green(`✅ Session saved for ${displayName}`));
    await closeBrowser();
}));
program
    .command('sessions')
    .description('List saved sessions')
    .action(async () => {
    const { listSessions } = await import('./session.js');
    const sessions = await listSessions();
    if (sessions.length === 0) {
        console.log(chalk.gray('No sessions saved. Run: veil login <platform>'));
    }
    else {
        sessions.forEach(s => console.log(chalk.green(`  ✓ ${s}`)));
    }
});
// ─── Navigation ───────────────────────────────────────────────────────────────
addBrowserOptions(program
    .command('go <url>')
    .description('Navigate to a URL')
    .option('--platform <platform>', 'Platform for session restore', 'default')
    .option('--wait <event>', 'Wait event: load|domcontentloaded|networkidle', 'domcontentloaded')
    .option('--timeout <ms>', 'Timeout in ms', '30000')
    .action(async (url, opts) => {
    const { page } = await ensureBrowser({ ...pickBrowserOptions(opts), platform: opts.platform });
    try {
        await page.goto(url, { waitUntil: opts.wait, timeout: parseInt(opts.timeout) });
        const title = await page.title();
        const finalUrl = page.url();
        console.log(JSON.stringify({ ok: true, url: finalUrl, title }));
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
        process.exit(1);
    }
}));
program
    .command('url')
    .description('Get current URL')
    .action(async () => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser session open' }));
        process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, url: page.url(), title: await page.title() }));
});
program
    .command('back')
    .description('Navigate back')
    .action(async () => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser session open' }));
        process.exit(1);
    }
    await page.goBack();
    console.log(JSON.stringify({ ok: true, url: page.url() }));
});
// ─── Interaction ──────────────────────────────────────────────────────────────
program
    .command('click <selector>')
    .description('Click an element by CSS selector or data-testid')
    .option('--nth <n>', 'Which match (0-indexed)', '0')
    .option('--force', 'Force click (bypass overlays)', false)
    .option('--timeout <ms>', 'Timeout', '5000')
    .action(async (selector, opts) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open. Run: veil go <url>' }));
        process.exit(1);
    }
    try {
        const el = page.locator(selector).nth(parseInt(opts.nth));
        await el.waitFor({ timeout: parseInt(opts.timeout) });
        await el.click({ force: opts.force, timeout: parseInt(opts.timeout) });
        console.log(JSON.stringify({ ok: true, selector, nth: opts.nth }));
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message, selector }));
        process.exit(1);
    }
});
program
    .command('type <selector> <text>')
    .description('Type text into an element')
    .option('--clear', 'Clear field first', false)
    .option('--delay <ms>', 'Delay between keystrokes in ms', '40')
    .option('--nth <n>', 'Which match (0-indexed)', '0')
    .action(async (selector, text, opts) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open' }));
        process.exit(1);
    }
    try {
        const el = page.locator(selector).nth(parseInt(opts.nth));
        await el.waitFor({ timeout: 5000 });
        if (opts.clear)
            await el.clear();
        await el.click({ force: true });
        await page.keyboard.type(text, { delay: parseInt(opts.delay) });
        console.log(JSON.stringify({ ok: true, selector, typed: text }));
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message, selector }));
        process.exit(1);
    }
});
program
    .command('press <key>')
    .description('Press a keyboard key (Enter, Tab, Escape, ArrowDown...)')
    .action(async (key) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open' }));
        process.exit(1);
    }
    await page.keyboard.press(key);
    console.log(JSON.stringify({ ok: true, key }));
});
program
    .command('scroll <direction>')
    .description('Scroll page: up, down, top, bottom')
    .option('--amount <px>', 'Pixels to scroll', '600')
    .action(async (direction, opts) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open' }));
        process.exit(1);
    }
    const amount = parseInt(opts.amount);
    const scrollMap = {
        down: `window.scrollBy(0, ${amount})`,
        up: `window.scrollBy(0, -${amount})`,
        top: 'window.scrollTo(0, 0)',
        bottom: 'window.scrollTo(0, document.body.scrollHeight)',
    };
    await page.evaluate(scrollMap[direction] ?? scrollMap.down);
    console.log(JSON.stringify({ ok: true, direction, amount }));
});
program
    .command('wait <ms>')
    .description('Wait for N milliseconds')
    .action(async (ms) => {
    await new Promise(r => setTimeout(r, parseInt(ms)));
    console.log(JSON.stringify({ ok: true, waited: parseInt(ms) }));
});
program
    .command('wait-for <selector>')
    .description('Wait until selector appears on the page')
    .option('--timeout <ms>', 'Timeout', '10000')
    .action(async (selector, opts) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open' }));
        process.exit(1);
    }
    try {
        await page.waitForSelector(selector, { timeout: parseInt(opts.timeout) });
        console.log(JSON.stringify({ ok: true, selector }));
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: `Timeout waiting for: ${selector}` }));
        process.exit(1);
    }
});
// ─── Reading / Extraction ─────────────────────────────────────────────────────
program
    .command('read [selector]')
    .description('Read text from page or specific element')
    .option('--all', 'Return all matches as array', false)
    .option('--attr <attribute>', 'Read attribute instead of text (e.g. href, src)')
    .action(async (selector, opts) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open' }));
        process.exit(1);
    }
    try {
        if (!selector) {
            // Full page text
            const text = await page.evaluate(() => document.body.innerText);
            console.log(JSON.stringify({ ok: true, text: text.slice(0, 5000) }));
            return;
        }
        if (opts.all) {
            const items = await page.locator(selector).allTextContents();
            console.log(JSON.stringify({ ok: true, items }));
        }
        else if (opts.attr) {
            const val = await page.locator(selector).first().getAttribute(opts.attr);
            console.log(JSON.stringify({ ok: true, value: val }));
        }
        else {
            const text = await page.locator(selector).first().textContent();
            console.log(JSON.stringify({ ok: true, text }));
        }
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
        process.exit(1);
    }
});
program
    .command('snapshot')
    .description('Get full page accessibility snapshot (ARIA tree) for reasoning')
    .option('--max <chars>', 'Max chars to return', '8000')
    .action(async (opts) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open' }));
        process.exit(1);
    }
    // Use DOM snapshot instead of deprecated accessibility
    const snapshot = await page.evaluate((max) => {
        function nodeToObj(el, depth = 0) {
            if (depth > 8)
                return null;
            const obj = {
                tag: el.tagName?.toLowerCase(),
                role: el.getAttribute('role'),
                label: el.getAttribute('aria-label'),
                testid: el.getAttribute('data-testid'),
                text: el instanceof HTMLElement && !el.children.length ? el.innerText?.slice(0, 100) : undefined,
                href: el instanceof HTMLAnchorElement ? el.href : undefined,
            };
            // Remove undefined keys
            Object.keys(obj).forEach(k => obj[k] === undefined && delete obj[k]);
            const children = Array.from(el.children)
                .map(c => nodeToObj(c, depth + 1))
                .filter(Boolean)
                .slice(0, 10);
            if (children.length)
                obj.children = children;
            return obj;
        }
        return JSON.stringify(nodeToObj(document.body), null, 2).slice(0, max);
    }, parseInt(opts.max));
    console.log(JSON.stringify({ ok: true, snapshot, url: page.url() }));
});
program
    .command('find <text>')
    .description('Check if text exists on the current page')
    .action(async (text) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open' }));
        process.exit(1);
    }
    const found = await page.getByText(text).first().isVisible().catch(() => false);
    console.log(JSON.stringify({ ok: true, found, text }));
});
program
    .command('exists <selector>')
    .description('Check if a selector exists on the page')
    .action(async (selector) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open' }));
        process.exit(1);
    }
    const count = await page.locator(selector).count();
    console.log(JSON.stringify({ ok: true, exists: count > 0, count, selector }));
});
// ─── Screenshots ──────────────────────────────────────────────────────────────
program
    .command('shot [filename]')
    .description('Take a screenshot')
    .option('--selector <sel>', 'Screenshot specific element')
    .option('--full', 'Full page screenshot', false)
    .action(async (filename, opts) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open' }));
        process.exit(1);
    }
    const path = filename ?? `veil-${Date.now()}.png`;
    if (opts.selector) {
        await page.locator(opts.selector).first().screenshot({ path });
    }
    else {
        await page.screenshot({ path, fullPage: opts.full });
    }
    console.log(JSON.stringify({ ok: true, path }));
});
// ─── Evaluate ─────────────────────────────────────────────────────────────────
program
    .command('eval <script>')
    .description('Run JavaScript in the browser and return result')
    .action(async (script) => {
    const page = await getPage();
    if (!page) {
        console.log(JSON.stringify({ ok: false, error: 'No browser open' }));
        process.exit(1);
    }
    try {
        const result = await page.evaluate(script);
        console.log(JSON.stringify({ ok: true, result }));
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
        process.exit(1);
    }
});
// ─── Session management ───────────────────────────────────────────────────────
addBrowserOptions(program
    .command('open <platform>')
    .description('Open a browser session using saved login cookies for a platform')
    .option('--headed', 'Show browser window', false)
    .action(async (platform, opts) => {
    const { page } = await ensureBrowser({
        ...pickBrowserOptions(opts),
        headed: opts.headed,
        platform,
    });
    const platformUrls = {
        x: 'https://x.com/home',
        twitter: 'https://x.com/home',
        linkedin: 'https://www.linkedin.com/feed',
        reddit: 'https://www.reddit.com',
        bluesky: 'https://bsky.app',
    };
    const url = platformUrls[platform.toLowerCase()] ?? `https://${platform}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const title = await page.title();
    console.log(JSON.stringify({ ok: true, platform, url: page.url(), title }));
}));
// ─── X / Social Interactions ─────────────────────────────────────────────────
addBrowserOptions(program
    .command('like')
    .description('Like the Nth post on the current page')
    .option('--nth <n>', 'Which post (0-indexed)', '0')
    .option('--platform <platform>', 'Platform for session', 'x')
    .action(async (opts) => {
    const { page } = await ensureBrowser({ ...pickBrowserOptions(opts), platform: opts.platform });
    try {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector("article[data-testid='tweet']", { timeout: 20000 });
        await humanDelay(1000, 1600);
        await page.locator("[data-testid='like']").nth(parseInt(opts.nth)).click({ force: true });
        await humanDelay(1000, 1400);
        const isLiked = await page.locator("[data-testid='unlike']").count() > 0;
        console.log(JSON.stringify({ ok: true, action: 'like', nth: opts.nth, confirmed: isLiked }));
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
        process.exit(1);
    }
    finally {
        await closeBrowser(opts.platform);
    }
}));
addBrowserOptions(program
    .command('reply <text>')
    .description('Reply to the Nth post on the current X feed')
    .option('--nth <n>', 'Which post (0-indexed)', '0')
    .option('--platform <platform>', 'Platform for session', 'x')
    .action(async (text, opts) => {
    const { page } = await ensureBrowser({ ...pickBrowserOptions(opts), platform: opts.platform });
    try {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector("article[data-testid='tweet']", { timeout: 20000 });
        await humanDelay(1000, 1500);
        await page.locator("[data-testid='reply']").nth(parseInt(opts.nth)).click({ force: true });
        await humanDelay(800, 1100);
        await page.locator("[data-testid='tweetTextarea_0']").first().waitFor({ timeout: 8000 });
        await page.locator("[data-testid='tweetTextarea_0']").first().click({ force: true });
        await humanDelay(300, 500);
        await page.keyboard.type(text, { delay: 38 });
        await humanDelay(600, 900);
        await page.locator("[data-testid='tweetButton']").first().click({ force: true });
        await humanDelay(1800, 2400);
        console.log(JSON.stringify({ ok: true, action: 'reply', nth: opts.nth, text }));
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
        process.exit(1);
    }
    finally {
        await closeBrowser(opts.platform);
    }
}));
addBrowserOptions(program
    .command('repost')
    .description('Repost (retweet) the Nth post on the current X feed')
    .option('--nth <n>', 'Which post (0-indexed)', '0')
    .option('--platform <platform>', 'Platform for session', 'x')
    .action(async (opts) => {
    const { page } = await ensureBrowser({ ...pickBrowserOptions(opts), platform: opts.platform });
    try {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector("article[data-testid='tweet']", { timeout: 20000 });
        await humanDelay(1000, 1500);
        await page.locator("[data-testid='retweet']").nth(parseInt(opts.nth)).click({ force: true });
        await humanDelay(500, 800);
        await page.locator("[data-testid='retweetConfirm']").first().waitFor({ timeout: 5000 });
        await page.locator("[data-testid='retweetConfirm']").first().click({ force: true });
        await humanDelay(1200, 1800);
        console.log(JSON.stringify({ ok: true, action: 'repost', nth: opts.nth }));
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
        process.exit(1);
    }
    finally {
        await closeBrowser(opts.platform);
    }
}));
addBrowserOptions(program
    .command('quote <text>')
    .description('Quote the Nth post on the current X feed with your comment')
    .option('--nth <n>', 'Which post (0-indexed)', '0')
    .option('--platform <platform>', 'Platform for session', 'x')
    .action(async (text, opts) => {
    const { page } = await ensureBrowser({ ...pickBrowserOptions(opts), platform: opts.platform });
    try {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector("article[data-testid='tweet']", { timeout: 20000 });
        await humanDelay(1000, 1500);
        // Get tweet URL for the target post
        const tweetUrls = await page.locator('a[href*="/status/"]').evaluateAll((els) => els.map(el => el.href).filter(h => /\/status\/\d+$/.test(h)));
        const targetUrl = tweetUrls[parseInt(opts.nth)] ?? tweetUrls[0];
        if (!targetUrl)
            throw new Error('Could not find tweet URL for quoting');
        // Navigate to compose with tweet URL appended
        const composeUrl = `https://x.com/compose/post?text=${encodeURIComponent(text + '\n\n' + targetUrl)}`;
        await page.goto(composeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await humanDelay(1500, 2000);
        await page.locator("[data-testid='tweetButtonInline']").first().waitFor({ timeout: 8000 });
        await page.locator("[data-testid='tweetButtonInline']").first().click({ force: true });
        await humanDelay(2000, 2500);
        console.log(JSON.stringify({ ok: true, action: 'quote', nth: opts.nth, text, quotedUrl: targetUrl }));
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
        process.exit(1);
    }
    finally {
        await closeBrowser(opts.platform);
    }
}));
addBrowserOptions(program
    .command('post <text>')
    .description('Post a tweet on X')
    .option('--platform <platform>', 'Platform for session', 'x')
    .action(async (text, opts) => {
    const { page } = await ensureBrowser({ ...pickBrowserOptions(opts), platform: opts.platform });
    try {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector("[data-testid='primaryColumn']", { timeout: 20000 });
        await humanDelay(800, 1400);
        await page.locator("[data-testid='tweetTextarea_0']").first().click({ force: true });
        await humanDelay(400, 700);
        await page.keyboard.type(text, { delay: 38 });
        await humanDelay(600, 1000);
        await page.locator("[data-testid='tweetButtonInline']").first().click({ force: true });
        await humanDelay(2000, 2500);
        console.log(JSON.stringify({ ok: true, action: 'post', text }));
    }
    catch (err) {
        console.log(JSON.stringify({ ok: false, error: err.message }));
        process.exit(1);
    }
    finally {
        await closeBrowser(opts.platform);
    }
}));
addBrowserOptions(program
    .command('serve')
    .description('Start a Streamable HTTP MCP server for Claude or other MCP clients')
    .option('--host <host>', 'Host interface to bind', '127.0.0.1')
    .option('--port <port>', 'TCP port to bind', '3456')
    .option('--allowed-hosts <hosts>', 'Comma-separated allowed Host header values')
    .option('--https-cert <path>', 'TLS certificate path for direct HTTPS')
    .option('--https-key <path>', 'TLS private key path for direct HTTPS')
    .action(async (opts) => {
    await startMcpServer({
        host: opts.host,
        port: parseIntegerOption(opts.port, 'port'),
        allowedHosts: opts.allowedHosts
            ? String(opts.allowedHosts)
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean)
            : undefined,
        httpsCert: opts.httpsCert,
        httpsKey: opts.httpsKey,
        browserDefaults: pickBrowserOptions(opts),
    });
}));
program
    .command('close')
    .description('Close the current browser session')
    .option('--platform <platform>', 'Platform to close', 'default')
    .action(async (opts) => {
    await closeBrowser(opts.platform);
    console.log(JSON.stringify({ ok: true }));
});
// ─── Status ───────────────────────────────────────────────────────────────────
program
    .command('status')
    .description('Show veil status')
    .action(async () => {
    const { listSessions } = await import('./session.js');
    const { isFlareSolverrUp } = await import('./local-captcha.js');
    const sessions = await listSessions();
    const flare = await isFlareSolverrUp();
    console.log(chalk.cyan('\n🕶️  veil v0.4.1 — OpenClaw Browser Remote\n'));
    console.log(`  Sessions:     ${sessions.length > 0 ? chalk.green(sessions.join(', ')) : chalk.gray('none')}`);
    console.log(`  FlareSolverr: ${flare ? chalk.green('running') : chalk.gray('not running (auto-starts on use)')}`);
    console.log('');
    console.log(chalk.gray('  Quick reference:'));
    console.log(chalk.gray('    veil login x        # save X session'));
    console.log(chalk.gray('    veil open x         # restore X session'));
    console.log(chalk.gray('    veil go <url>       # navigate'));
    console.log(chalk.gray('    veil snapshot       # read current page'));
    console.log(chalk.gray('    veil click <sel>    # click element'));
    console.log(chalk.gray('    veil type <sel> <text>'));
    console.log(chalk.gray('    veil read [sel]     # extract text'));
    console.log(chalk.gray('    veil shot           # screenshot'));
    console.log(chalk.gray('    veil serve          # start MCP server'));
    console.log('');
});
program.parse();

<div align="center">

<img src="https://raw.githubusercontent.com/cuttlelab/veil/main/docs/logo.png" alt="veil" width="80" />

# veil

**Stealth browser remote for AI agents.**

[![npm](https://img.shields.io/npm/v/veil-browser?color=000&style=flat-square)](https://www.npmjs.com/package/veil-browser)
[![license](https://img.shields.io/badge/license-MIT-000?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-000?style=flat-square)](https://nodejs.org)

</div>

---

veil is a **headless browser CLI** built for AI agents. It runs a real, stealth Chromium browser and exposes every interaction as a simple command that returns clean JSON.

You (or your agent) are the brain. veil is the hands.

```bash
npm install -g veil-browser
npx playwright install chromium
veil login x          # save your session once
veil post "Hello, world from an AI agent."
```

---

## Why veil

Most browser automation tools are built for developers writing scripts. veil is built for **AI agents making decisions in real-time** — where every step is a tool call, every result is parseable JSON, and the agent decides what to do next.

- **No LLM inside** — veil is pure remote control. Your agent is the intelligence.
- **Stealth by default** — hides automation signals, realistic user agent, human-like delays
- **Persistent sessions** — log in once, reuse forever via saved cookies
- **Every output is JSON** — `{ ok: true, ... }` or `{ ok: false, error: "..." }`

---

## Installation

```bash
npm install -g veil-browser
npx playwright install chromium
```

---

## Quick Start

```bash
# Log in once (opens visible browser)
veil login x

# Post a tweet
veil post "Building something new."

# Like, reply, repost, quote
veil like --nth 0
veil reply "Great point." --nth 0
veil repost --nth 1
veil quote "Worth reading." --nth 2

# Navigate and read any page
veil go https://example.com
veil snapshot          # DOM tree → understand the page
veil read "h1"         # Extract specific elements
veil find "Sign in"    # Check if text exists

# Click, type, interact
veil click "[data-testid='button']"
veil type "input[name='q']" "search query"
veil press Enter
veil scroll down

# Screenshot
veil shot page.png
```

---

## Browser Selection

veil can use Playwright's bundled Chromium, an installed Chrome-compatible browser, or an already-running browser exposed over CDP.

```bash
# Installed Google Chrome
veil login reddit --browser chrome

# Installed Dia
veil login reddit --browser dia

# Attach to a manually started browser over CDP
veil login reddit --cdp-url http://127.0.0.1:9222

# Launch a dedicated persistent automation profile
veil login reddit --browser chrome --user-data-dir "$HOME/.veil/chrome-profile"
```

Supported shared browser flags:

- `--browser playwright|chrome|dia`
- `--browser-path /absolute/path/to/browser`
- `--cdp-url http://127.0.0.1:9222`
- `--user-data-dir /path/to/profile`
- `--timeout-ms 45000`

Use a dedicated automation profile for `--user-data-dir`. Do not point veil at your live default Chrome profile while that browser is open.

---

## All Commands

### Session
| Command | Description |
|---------|-------------|
| `veil login <platform>` | Open visible browser → log in → save session |
| `veil open <platform>` | Restore session and navigate to platform home |
| `veil sessions` | List saved sessions |
| `veil close` | Close browser |
| `veil serve` | Start the Streamable HTTP MCP server |

**Supported platforms:** `x`, `linkedin`, `reddit`, `bluesky` (or any URL)

### X / Social
| Command | Description |
|---------|-------------|
| `veil post "text"` | Post a tweet |
| `veil like --nth 0` | Like Nth post in feed |
| `veil reply "text" --nth 0` | Reply to Nth post |
| `veil repost --nth 0` | Repost Nth post |
| `veil quote "text" --nth 0` | Quote Nth post with comment |

### Navigation
| Command | Description |
|---------|-------------|
| `veil go <url>` | Navigate to URL |
| `veil url` | Get current URL and title |
| `veil back` | Go back |

### Reading
| Command | Description |
|---------|-------------|
| `veil snapshot` | Full DOM tree (best for understanding page structure) |
| `veil read [selector]` | Page text or element text |
| `veil read <sel> --all` | All matches as array |
| `veil read <sel> --attr href` | Read attribute value |
| `veil find "text"` | Check if text exists on page |
| `veil exists <selector>` | Check if selector exists |

### Interaction
| Command | Description |
|---------|-------------|
| `veil click <selector>` | Click element |
| `veil click <sel> --force` | Force click (bypass overlays) |
| `veil click <sel> --nth 2` | Click Nth match |
| `veil type <selector> "text"` | Type into element |
| `veil type <sel> "text" --clear` | Clear first, then type |
| `veil press <key>` | Press key (Enter, Tab, Escape…) |
| `veil scroll down\|up\|top\|bottom` | Scroll page |
| `veil wait <ms>` | Wait N milliseconds |
| `veil wait-for <selector>` | Wait until element appears |
| `veil eval "script"` | Run JavaScript, returns result |

### Screenshot
| Command | Description |
|---------|-------------|
| `veil shot [file.png]` | Screenshot (full page with `--full`) |
| `veil shot file.png --selector <sel>` | Screenshot specific element |

---

## Remote MCP Server for Claude

veil now includes a real Streamable HTTP MCP server built on the official MCP SDK.

Local HTTP example:

```bash
veil serve --host 127.0.0.1 --port 3456
```

Direct HTTPS example:

```bash
veil serve \
  --host 0.0.0.0 \
  --port 3443 \
  --allowed-hosts your-domain.example \
  --https-cert /etc/ssl/your-domain/fullchain.pem \
  --https-key /etc/ssl/your-domain/privkey.pem
```

Important deployment notes:

- Claude needs a reachable `https://` endpoint with a valid certificate. A localhost server or self-signed certificate is useful for testing, but not for production Claude integrations.
- The MCP endpoint is `POST /mcp`.
- Health checks are available at `GET /healthz`.
- When binding to `0.0.0.0` or another non-localhost interface, set `--allowed-hosts` to the real public hostname to keep host-header validation in place.
- You can also terminate TLS in a reverse proxy or tunnel and forward plain HTTP to `veil serve`.
- Sessions are still created separately with `veil login <platform>`. The MCP server reuses those saved sessions when tools specify a `platform`.

Smoke-test the built server locally:

```bash
npm run build
npm run test:mcp
```

---

## For AI Agents (OpenClaw / MCP)

veil ships with a `SKILL.md` that teaches OpenClaw exactly how to use it — all commands, all platform selectors, and complete task sequences.

The agent pattern:
```
1. veil open x           → restore session
2. veil snapshot         → understand current page
3. veil click / type     → act
4. veil wait 800         → let UI settle
5. veil find / read      → verify
```

Every command is deterministic. Every output is parseable. The agent decides the logic.

---

## Platform Support

| Platform | Login | Post | Like | Reply | Repost | Quote |
|----------|-------|------|------|-------|--------|-------|
| X (Twitter) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| LinkedIn | ✅ | ✅ | ✅ | ✅ | — | — |
| Reddit | ✅ | — | ✅ | ✅ | — | — |
| Any website | — | — | ✅ via selectors | — | — | — |

---

## Configuration

Config stored at `~/.veil/config.json`. Sessions at `~/.veil/sessions/<platform>.json`.

```bash
veil status    # show current config and saved sessions
```

---

## How It Works

1. **Stealth Chromium** — launches with flags that hide automation signals
2. **Session cookies** — saved after manual login, restored on every run
3. **Human timing** — random delays between actions (400–1200ms)
4. **Clean JSON output** — every command returns `{ ok, ... }` for easy parsing

---

## Built by CUTTLELAB

veil is part of the tooling stack we're building for AI agents at [CUTTLELAB](https://cuttle.io).

---

## License

MIT

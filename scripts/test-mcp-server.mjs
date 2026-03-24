import assert from 'node:assert/strict';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_ENTRY = resolve(REPO_ROOT, 'dist', 'index.js');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3456;
const START_TIMEOUT_MS = 15000;
const HEALTH_POLL_INTERVAL_MS = 250;

/**
 * Parse simple `--flag value` command-line arguments.
 */
function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

/**
 * Validate and normalize a TCP port value.
 */
function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

/**
 * Fetch the health endpoint until the server is ready or a timeout expires.
 */
async function waitForHealthyServer(healthUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {
      // The process may still be starting.
    }

    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for MCP server health at ${healthUrl}`);
}

/**
 * Start the built veil MCP server and wait until its health endpoint responds.
 */
async function startServer(options) {
  const commandArgs = [
    SERVER_ENTRY,
    'serve',
    '--host',
    options.host,
    '--port',
    String(options.port),
  ];

  if (options.allowedHosts) {
    commandArgs.push('--allowed-hosts', options.allowedHosts);
  }
  if (options.httpsCert) {
    commandArgs.push('--https-cert', options.httpsCert);
  }
  if (options.httpsKey) {
    commandArgs.push('--https-key', options.httpsKey);
  }

  const child = spawn(process.execPath, commandArgs, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk;
  });

  child.on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      stderrBuffer += `\nServer exited with code ${code}.`;
    } else if (signal) {
      stderrBuffer += `\nServer exited with signal ${signal}.`;
    }
  });

  const protocol = options.httpsCert && options.httpsKey ? 'https' : 'http';
  const healthUrl = `${protocol}://${options.host}:${options.port}/healthz`;

  try {
    await waitForHealthyServer(healthUrl, START_TIMEOUT_MS);
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(
      `Failed to start veil MCP server.\nSTDOUT:\n${stdoutBuffer || '(empty)'}\nSTDERR:\n${stderrBuffer || '(empty)'}\nCause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    child,
    stderrBuffer,
    stdoutBuffer,
    mcpUrl: `${protocol}://${options.host}:${options.port}/mcp`,
  };
}

/**
 * Shut down the spawned MCP server process.
 */
async function stopServer(child) {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  child.kill('SIGTERM');

  const deadline = Date.now() + 5000;
  while (child.exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }

  if (child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

/**
 * Connect using the official MCP SDK and verify the veil server's basic tool flow.
 */
async function runSmokeTest(mcpUrl) {
  const client = new Client({
    name: 'veil-mcp-smoke-test',
    version: '0.1.0',
  });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: {
      headers: {
        Accept: 'application/json, text/event-stream',
      },
    },
  });

  try {
    await client.connect(transport);

    const toolsResult = await client.listTools();
    assert.ok(Array.isArray(toolsResult.tools), 'Expected tools/list to return an array.');
    assert.ok(
      toolsResult.tools.some((tool) => tool.name === 'status'),
      'Expected the `status` MCP tool to be registered.',
    );

    const statusResult = await client.callTool({
      name: 'status',
      arguments: {},
    });

    assert.ok(statusResult.isError !== true, 'Expected the `status` tool call to succeed.');
    assert.ok(Array.isArray(statusResult.content), 'Expected tool result content.');
    assert.ok(
      statusResult.content.some(
        (item) => item.type === 'text' && typeof item.text === 'string' && item.text.includes('browserOpen'),
      ),
      'Expected the `status` tool response to include browser state.',
    );
  } finally {
    if (typeof client.close === 'function') {
      await client.close();
    }
    await transport.close();
  }
}

/**
 * Execute the MCP smoke test from the command line.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = String(args.host ?? DEFAULT_HOST);
  const port = parsePort(args.port, DEFAULT_PORT);
  const allowedHosts = args['allowed-hosts'] ? String(args['allowed-hosts']) : undefined;
  const httpsCert = args['https-cert'] ? resolve(String(args['https-cert'])) : undefined;
  const httpsKey = args['https-key'] ? resolve(String(args['https-key'])) : undefined;

  if (httpsCert && httpsKey) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  const { child, mcpUrl } = await startServer({
    host,
    port,
    allowedHosts,
    httpsCert,
    httpsKey,
  });

  try {
    await runSmokeTest(mcpUrl);
    console.log(JSON.stringify({ ok: true, mcpUrl }));
  } finally {
    await stopServer(child);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

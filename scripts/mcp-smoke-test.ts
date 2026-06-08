/**
 * Smoke test for the Discord MCP server's StreamableHTTP transport.
 *
 * Boots the MCP server in-process (no Discord client — tools/resources are
 * only registered, not invoked) and drives it with a real MCP client over
 * StreamableHTTPClientTransport to confirm:
 *   1. POST /mcp initializes a session and returns an Mcp-Session-Id.
 *   2. listResources / listTools succeed over the new transport.
 *   3. A missing/expired session id is rejected (404).
 *   4. A bad bearer token is rejected (401).
 *
 * Run: MCP_AUTH_TOKEN=smoke-token npm run test:mcp
 *
 * This exercises the transport wiring only; resource/tool handlers that read
 * the DB or Discord client are not invoked (they are covered elsewhere).
 */

process.env.MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? 'smoke-token';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer, stopMcpServer } from '../src/mcp/server.js';

const MCP_PORT = 3001;
const TOKEN = process.env.MCP_AUTH_TOKEN;
const BASE = `http://127.0.0.1:${MCP_PORT}/mcp`;

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function run(): Promise<void> {
  console.log('\n=== Discord MCP StreamableHTTP Smoke Test ===\n');

  console.log('1. Booting MCP server in-process...');
  await startMcpServer();
  // Give the listener a moment to bind.
  await new Promise((r) => setTimeout(r, 250));

  console.log('\n2. Connecting MCP client (valid token)...');
  const transport = new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: 'mcp-smoke-test', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  assert(true, 'client connected (session initialized)');

  console.log('\n3. Listing resources and tools over /mcp...');
  const resources = await client.listResources();
  assert(Array.isArray(resources.resources), 'listResources returned a list');
  const tools = await client.listTools();
  assert(Array.isArray(tools.tools), 'listTools returned a list');

  await transport.close();

  console.log('\n4. Rejecting a bad bearer token (expect 401)...');
  const badResp = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer wrong-token',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert(badResp.status === 401, `bad token rejected with 401 (got ${badResp.status})`);

  console.log('\n5. Rejecting an unknown session id (expect 404)...');
  const unknownResp = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
      'Mcp-Session-Id': 'does-not-exist',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
  });
  assert(unknownResp.status === 404, `unknown session rejected with 404 (got ${unknownResp.status})`);

  console.log('\n6. Shutting down...');
  stopMcpServer();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Smoke test crashed:', err);
  stopMcpServer();
  process.exit(1);
});

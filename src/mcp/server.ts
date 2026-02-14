import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

const MCP_HOST = '127.0.0.1';
const MCP_PORT = 3001;

let httpServer: http.Server | null = null;
let mcpServer: McpServer | null = null;
let activeSocketPath: string | null = null;

// Store transports by session ID
const transports = new Map<string, SSEServerTransport>();

export function getMcpServer(): McpServer | null {
  return mcpServer;
}

/** Check if a Unix Domain Socket has a live listener. Returns true if alive. */
function checkSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath }, () => {
      // Connection succeeded — another instance is alive
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      // ECONNREFUSED or similar — socket is stale
      resolve(false);
    });
    // Timeout after 1s to avoid hanging
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function startMcpServer(): Promise<void> {
  const config = getConfig();
  if (!config.mcpAuthToken) {
    logger.info('MCP server: disabled (no MCP_AUTH_TOKEN set)');
    return;
  }

  mcpServer = new McpServer(
    {
      name: 'magi-assistant-discord',
      version: '0.1.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  registerResources(mcpServer);
  registerTools(mcpServer);

  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Token auth: check Authorization header first, then query param fallback.
    // Query token only accepted on GET /sse (EventSource can't send headers).
    // POST /messages requires Authorization header to avoid token exposure in URLs.
    const expectedToken = config.mcpAuthToken;
    const authHeader = req.headers.authorization;
    const headerOk = authHeader === `Bearer ${expectedToken}`;
    const isGetSse = url.pathname === '/sse' && req.method === 'GET';
    const queryTokenOk = isGetSse && url.searchParams.get('token') === expectedToken;
    const authenticated = headerOk || queryTokenOk;

    if (!authenticated) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (isGetSse) {
      // SSE endpoint — create a new transport for this connection
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);

      res.on('close', () => {
        transports.delete(transport.sessionId);
      });

      await mcpServer!.server.connect(transport);
    } else if (url.pathname === '/messages' && req.method === 'POST') {
      // Message endpoint — find the transport and handle the message
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId || !transports.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid session' }));
        return;
      }

      const transport = transports.get(sessionId)!;
      await transport.handlePostMessage(req, res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  // Use Unix Domain Socket on Linux when configured (Appendix A.4: filesystem-level ACLs)
  const socketPath = config.mcpSocketPath;
  if (socketPath && process.platform !== 'win32') {
    // Check for stale vs live socket: try to connect before unlinking
    if (fs.existsSync(socketPath)) {
      const isAlive = await checkSocketAlive(socketPath);
      if (isAlive) {
        logger.error(`MCP server: another instance is already listening on ${socketPath} — aborting MCP startup`);
        mcpServer = null;
        httpServer.close();
        httpServer = null;
        return;
      }
      // Socket is stale (connection refused) — safe to unlink
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // May have been removed between check and unlink
      }
    }

    httpServer.listen(socketPath, () => {
      // Restrict socket to owner only (0600)
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch (err) {
        logger.warn('Could not set socket permissions:', err);
      }
      activeSocketPath = socketPath;
      logger.info(`MCP server listening on UDS ${socketPath} (mode 0600)`);
    });
  } else {
    httpServer.listen(MCP_PORT, MCP_HOST, () => {
      logger.info(`MCP server listening on ${MCP_HOST}:${MCP_PORT}`);
    });
  }

  httpServer.on('error', (err) => {
    logger.error('MCP server error:', err);
  });
}

export function stopMcpServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = null;
    logger.info('MCP server stopped');
  }

  // Clean up socket file
  if (activeSocketPath) {
    try {
      if (fs.existsSync(activeSocketPath)) {
        fs.unlinkSync(activeSocketPath);
      }
    } catch {
      // Best effort
    }
    activeSocketPath = null;
  }

  for (const [, transport] of transports) {
    transport.close?.();
  }
  transports.clear();

  mcpServer = null;
}

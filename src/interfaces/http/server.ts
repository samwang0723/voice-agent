import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { createBunWebSocket } from 'hono/bun';
import { randomUUID } from 'crypto';
import type { WebSocketData } from '../websocket/websocket.handler';
import { WebSocketHandler } from '../websocket/websocket.handler';
import logger from '../../infrastructure/logger';

const { upgradeWebSocket, websocket: webSocketCallbacks } =
  createBunWebSocket<WebSocketData>();

export function createServer(webSocketHandler: WebSocketHandler) {
  const app = new Hono();

  // Serve static files from the public directory
  app.use('/*', serveStatic({ root: './public' }));

  // WebSocket endpoint
  app.get(
    '/ws',
    upgradeWebSocket((c) => {
      const sessionId = randomUUID(); // Generate sessionId on upgrade
      const bearerToken = c.req.query('token');

      return {
        onOpen: (event, ws) => {
          // Pass the context and bearer token to onOpen
          webSocketHandler.onOpen(ws, sessionId, bearerToken);
        },
        onMessage: async (event, ws) => {
          const data = event.data;
          if (data instanceof Blob) {
            const buffer = Buffer.from(await data.arrayBuffer());
            webSocketHandler.onMessage(ws, buffer, sessionId);
          } else if (data instanceof SharedArrayBuffer) {
            const buffer = Buffer.from(data);
            webSocketHandler.onMessage(ws, buffer, sessionId);
          } else {
            webSocketHandler.onMessage(ws, data, sessionId);
          }
        },
        onClose: (event, ws) => {
          webSocketHandler.onClose(ws, event.code, event.reason, sessionId);
        },
        onError: (event, ws) => {
          webSocketHandler.onError(ws, (event as ErrorEvent).error, sessionId);
        },
      };
    })
  );

  logger.info('Server setup complete. Ready to accept connections.');

  return { app, webSocketCallbacks };
}

import type { WSContext } from 'hono/ws';
import logger from '../../infrastructure/logger';
import type { WebSocketData } from './websocket.handler';

interface WebSocketMessage {
  type: string;
  [key: string]: any;
}

export class WebSocketGateway {
  public static send(
    ws: WSContext<WebSocketData>,
    message: WebSocketMessage
  ): void {
    try {
      ws.send(JSON.stringify({ ...message, timestamp: new Date().toISOString() }));
    } catch (error) {
      logger.error('Failed to send WebSocket message:', error);
    }
  }

  public static sendError(
    ws: WSContext<WebSocketData>,
    errorMessage: string
  ): void {
    this.send(ws, { type: 'error', message: errorMessage });
  }

  public static broadcast(
    sessions: Map<string, { ws: WSContext<WebSocketData> }>,
    message: WebSocketMessage
  ): void {
    const serializedMessage = JSON.stringify({
      ...message,
      timestamp: new Date().toISOString(),
    });
    for (const session of sessions.values()) {
      try {
        session.ws.send(serializedMessage);
      } catch (error) {
        logger.error(`Failed to broadcast to session:`, error);
      }
    }
  }
} 
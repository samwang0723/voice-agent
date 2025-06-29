import type { WSContext } from 'hono/ws';
import type { WebSocketData } from '../../interfaces/websocket/websocket.handler';

export class Session {
  public context: any = {};

  constructor(
    public readonly id: string,
    public readonly ws: WSContext<WebSocketData>,
    public conversationId: string
  ) {}
} 
import type { WSContext } from 'hono/ws';
import type { WebSocketData } from '../../interfaces/websocket/websocket.handler';

export class Session {
  public context: any = {};
  public sttEngine: string = 'groq';
  public ttsEngine: string = 'groq';

  constructor(
    public readonly id: string,
    public readonly ws: WSContext<WebSocketData>,
    public conversationId: string
  ) {}
} 
import type { ServerWebSocket } from 'bun';
import type { WSContext } from 'hono/ws';
import { randomUUID } from 'crypto';
import { VoiceAgentService } from '../../application/voiceAgent.service';
import { Session } from '../../domain/session/session.entity';
import type { ISessionRepository } from '../../domain/session/session.repository';
import logger from '../../infrastructure/logger';
import { WebSocketGateway } from './websocket.gateway';

// Define the shape of the data attached to our WebSocket
export type WebSocketData = {
  sessionId: string;
};

// Create a specific WebSocket type from Hono's context
export type VoiceAgentWSCotext = WSContext<WebSocketData>;

export class WebSocketHandler {
  constructor(
    private readonly voiceAgentService: VoiceAgentService,
    private readonly sessionRepository: ISessionRepository
  ) {}

  public onOpen(ws: VoiceAgentWSCotext, sessionId: string) {
    // The session now correctly stores the websocket with its specific data type
    const session = new Session(sessionId, ws, sessionId);
    this.sessionRepository.save(session);

    logger.info(`[${sessionId}] WebSocket connection opened.`);

    WebSocketGateway.send(ws, {
      type: 'agent',
      message: 'Hello! How may I assist you today?',
    });
  }

  public async onMessage(
    ws: VoiceAgentWSCotext,
    data: string | Buffer | ArrayBuffer | Blob,
    sessionId: string
  ) {
    // Handle JSON context messages
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        if (message.type === 'audio-context') {
          const session = await this.sessionRepository.findById(sessionId);
          if (session) {
            session.context = message.context;
            await this.sessionRepository.save(session);
            logger.info(
              `[${sessionId}] Updated session context:`,
              message.context
            );
          }
        }
        return; // Context message handled, no further action needed
      } catch (error) {
        logger.warn(
          `[${sessionId}] Received invalid JSON message: ${data}`,
          error
        );
        return;
      }
    }

    // Handle binary audio data
    let audioBuffer: Buffer;
    if (data instanceof ArrayBuffer) {
      audioBuffer = Buffer.from(data);
    } else if (data instanceof Blob) {
      audioBuffer = Buffer.from(await data.arrayBuffer());
    } else {
      audioBuffer = data;
    }

    logger.debug(
      `[${sessionId}] Received audio chunk: ${audioBuffer.length} bytes`
    );

    try {
      const session = await this.sessionRepository.findById(sessionId);
      const context = session?.context;

      const { transcript, aiResponse, audioResponse } =
        await this.voiceAgentService.processAudio(
          sessionId,
          audioBuffer,
          context
        );

      // Send transcript to client
      if (transcript) {
        WebSocketGateway.send(ws, {
          type: 'transcript',
          transcript: transcript,
        });
      }

      // Send AI response and audio to client
      if (aiResponse) {
        WebSocketGateway.send(ws, {
          type: 'agent',
          message: aiResponse,
          speechAudio: audioResponse ? audioResponse.toString('base64') : undefined,
        });
      }
    } catch (error) {
      logger.error(`[${sessionId}] Error processing audio:`, error);
      WebSocketGateway.sendError(
        ws,
        'An error occurred while processing your request.'
      );
    }
  }

  public onClose(ws: VoiceAgentWSCotext, code: number, reason: string, sessionId: string) {
    if (sessionId) {
      this.sessionRepository.delete(sessionId);
      logger.info(`[${sessionId}] WebSocket connection closed. Code: ${code}, Reason: ${reason}`);
    }
  }

  public onError(ws: VoiceAgentWSCotext, error: Error, sessionId: string) {
    if (sessionId) {
      this.sessionRepository.delete(sessionId);
      logger.error(`[${sessionId}] WebSocket error:`, error);
    }
  }
} 
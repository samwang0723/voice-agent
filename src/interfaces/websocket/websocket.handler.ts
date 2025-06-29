import type { WSContext } from 'hono/ws';
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
        const session = await this.sessionRepository.findById(sessionId);
        if (!session) {
          logger.warn(`[${sessionId}] Session not found for incoming message.`);
          return;
        }

        if (message.type === 'config') {
          session.sttEngine = message.sttEngine || 'groq';
          session.ttsEngine = message.ttsEngine || 'groq';
          await this.sessionRepository.save(session);
          logger.info(
            `[${sessionId}] Updated engines - STT: ${session.sttEngine}, TTS: ${session.ttsEngine}`
          );
        } else if (message.type === 'audio-context') {
          session.context = message.context;
          await this.sessionRepository.save(session);
          logger.info(
            `[${sessionId}] Updated session context:`,
            message.context
          );
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
      if (!session) {
        logger.error(`[${sessionId}] Session not found for audio processing.`);
        return;
      }

      const { transcript, aiResponse, audioResponse } =
        await this.voiceAgentService.processAudio(
          sessionId,
          audioBuffer,
          session.sttEngine,
          session.ttsEngine,
          session.context
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
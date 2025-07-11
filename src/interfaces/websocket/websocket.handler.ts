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

  public async onOpen(
    ws: VoiceAgentWSCotext,
    sessionId: string,
    bearerToken?: string
  ) {
    try {
      let token: string | undefined;

      // Optional bearer token validation - log warning if missing but allow connection
      if (!bearerToken || bearerToken.trim() === '') {
        logger.warn(
          `[${sessionId}] WebSocket connection opened without authentication - guest mode enabled`
        );
        token = undefined;
      } else {
        // Basic token format validation (should start with 'Bearer ' or be a valid token)
        token = bearerToken.startsWith('Bearer ')
          ? bearerToken.slice(7)
          : bearerToken;
        if (token.length < 10) {
          // Basic length check for token validity - warn but don't reject
          logger.warn(
            `[${sessionId}] WebSocket connection opened with invalid token format - treating as guest`
          );
          token = undefined;
        }
      }

      // Create session with optional bearer token
      const session = new Session(sessionId, ws, sessionId, token);
      await this.sessionRepository.save(session);

      if (token) {
        logger.info(
          `[${sessionId}] WebSocket connection opened with authentication.`
        );
      } else {
        logger.info(
          `[${sessionId}] WebSocket connection opened in guest mode.`
        );
      }

      // Always send greeting message regardless of authentication status
      WebSocketGateway.send(ws, {
        type: 'agent',
        message: 'Hello! How may I assist you today?',
      });
    } catch (error) {
      logger.error(
        `[${sessionId}] Error during WebSocket connection setup:`,
        error
      );
      WebSocketGateway.sendError(ws, 'Connection setup failed');
      this.sessionRepository.delete(sessionId);
      ws.close(4500, 'Internal Server Error');
    }
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
          session.chatMode = message.chatMode || 'single';
          await this.sessionRepository.save(session);
          logger.info(
            `[${sessionId}] Updated engines - STT: ${session.sttEngine}, TTS: ${session.ttsEngine}, Chat Mode: ${session.chatMode}`
          );
        } else if (message.type === 'audio-context') {
          session.context = message.context;
          await this.sessionRepository.save(session);
          logger.info(
            `[${sessionId}] Updated session context:`,
            message.context
          );
        } else if (message.type === 'barge-in') {
          try {
            await this.voiceAgentService.cancelCurrentTTS(session.id);
            logger.info(`[${sessionId}] Barge-in processed successfully`);

            // Send acknowledgment response
            WebSocketGateway.send(ws, {
              type: 'barge-in-ack',
              message: 'Barge-in processed successfully',
            });
          } catch (error) {
            logger.error(`[${sessionId}] Error processing barge-in:`, error);
            WebSocketGateway.sendError(
              ws,
              'Failed to process barge-in request'
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
      if (!session) {
        logger.error(`[${sessionId}] Session not found for audio processing.`);
        return;
      }

      // Prepare streaming callbacks for real-time message delivery
      const onTextChunk =
        session.chatMode === 'stream'
          ? (chunk: string) => WebSocketGateway.sendAgentStream(ws, chunk)
          : undefined;

      const onAudioChunk =
        session.chatMode === 'stream'
          ? (chunk: Buffer) => WebSocketGateway.sendAudioChunk(ws, chunk)
          : undefined;

      // Callback to send transcript immediately after transcription
      const onTranscript = (transcript: string) => {
        WebSocketGateway.send(ws, {
          type: 'transcript',
          transcript: transcript,
        });
      };

      const { transcript, aiResponse, audioResponse } =
        await this.voiceAgentService.processAudio(
          sessionId,
          audioBuffer,
          session.sttEngine,
          session.ttsEngine,
          {
            ...session.context,
            session: {
              id: session.id,
              bearerToken: session.bearerToken,
              conversationId: session.conversationId,
            },
          },
          session.chatMode,
          onTextChunk,
          onAudioChunk,
          onTranscript
        );

      // Note: transcript is now sent immediately via onTranscript callback

      // Send AI response and audio to client (only for single mode)
      // In streaming mode, responses are already sent via callbacks
      if (aiResponse && session.chatMode === 'single') {
        // Check if AI response indicates authentication is required
        const responseText = aiResponse.toLowerCase();
        const authRequiredPatterns = [
          'sign in to your account',
          'please authenticate',
          'authentication required',
          'login required',
          'need to sign in',
          'please sign in',
          'authentication needed',
          'access external tools',
          'sign in first',
          'authenticate to access',
        ];

        const requiresAuth = authRequiredPatterns.some((pattern) =>
          responseText.includes(pattern)
        );

        if (requiresAuth) {
          // Send as auth_required type to trigger login prompt
          logger.info(
            `[${sessionId}] AI response detected authentication requirement, sending auth_required message`
          );
          WebSocketGateway.send(ws, {
            type: 'auth_required',
            message: aiResponse,
          });
        } else {
          // Send normal agent response
          WebSocketGateway.send(ws, {
            type: 'agent',
            message: aiResponse,
            speechAudio: audioResponse
              ? audioResponse.toString('base64')
              : undefined,
          });
        }
      } else if (aiResponse && session.chatMode === 'stream') {
        // In streaming mode, check for auth requirements and send final message if needed
        const responseText = aiResponse.toLowerCase();
        const authRequiredPatterns = [
          'sign in to your account',
          'please authenticate',
          'authentication required',
          'login required',
          'need to sign in',
          'please sign in',
          'authentication needed',
          'access external tools',
          'sign in first',
          'authenticate to access',
        ];

        const requiresAuth = authRequiredPatterns.some((pattern) =>
          responseText.includes(pattern)
        );

        if (requiresAuth) {
          // Send as auth_required type to trigger login prompt
          logger.info(
            `[${sessionId}] AI response detected authentication requirement in streaming mode, sending auth_required message`
          );
          WebSocketGateway.send(ws, {
            type: 'auth_required',
            message: aiResponse,
          });
        } else {
          // Send stream completion signal
          WebSocketGateway.send(ws, {
            type: 'agent-stream-complete',
            message: 'Stream completed',
          });
        }
      }
    } catch (error) {
      logger.error(`[${sessionId}] Error processing audio:`, error);

      // Check if this is an authentication-related error
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();

        // Enhanced authentication error detection patterns
        if (
          errorMessage.includes('authentication') ||
          errorMessage.includes('401') ||
          errorMessage.includes('403') ||
          errorMessage.includes('authentication failed') ||
          errorMessage.includes('access forbidden') ||
          errorMessage.includes('bearer token') ||
          errorMessage.includes('token expired') ||
          errorMessage.includes('unauthorized') ||
          errorMessage.includes('forbidden')
        ) {
          WebSocketGateway.send(ws, {
            type: 'auth_required',
            message: 'Authentication expired. Please sign in again.',
          });
        } else if (errorMessage.includes('agent-swarm')) {
          WebSocketGateway.sendError(
            ws,
            'AI service temporarily unavailable. Please try again.'
          );
        } else {
          WebSocketGateway.sendError(
            ws,
            'An error occurred while processing your request.'
          );
        }
      } else {
        WebSocketGateway.sendError(
          ws,
          'An error occurred while processing your request.'
        );
      }
    }
  }

  public onClose(
    ws: VoiceAgentWSCotext,
    code: number,
    reason: string,
    sessionId: string
  ) {
    if (sessionId) {
      this.sessionRepository.delete(sessionId);
      logger.info(
        `[${sessionId}] WebSocket connection closed. Code: ${code}, Reason: ${reason}`
      );
    }
  }

  public onError(ws: VoiceAgentWSCotext, error: Error, sessionId: string) {
    if (sessionId) {
      // Clean up session on error
      this.sessionRepository.delete(sessionId);
      logger.error(`[${sessionId}] WebSocket error:`, error);

      // Send appropriate error message if connection is still open
      try {
        const errorMessage = error.message.toLowerCase();

        // Enhanced authentication error detection patterns
        if (
          errorMessage.includes('authentication') ||
          errorMessage.includes('token') ||
          errorMessage.includes('401') ||
          errorMessage.includes('403') ||
          errorMessage.includes('authentication failed') ||
          errorMessage.includes('access forbidden') ||
          errorMessage.includes('bearer token') ||
          errorMessage.includes('token expired') ||
          errorMessage.includes('unauthorized') ||
          errorMessage.includes('forbidden')
        ) {
          WebSocketGateway.send(ws, {
            type: 'auth_required',
            message: 'Authentication expired. Please sign in again.',
          });
        } else if (errorMessage.includes('agent-swarm')) {
          WebSocketGateway.sendError(ws, 'AI service error occurred');
        } else {
          WebSocketGateway.sendError(ws, 'Connection error occurred');
        }
      } catch (sendError) {
        // Connection might already be closed, ignore send errors
        logger.debug(
          `[${sessionId}] Could not send error message, connection likely closed`
        );
      }
    }
  }
}

import type { IConversationRepository } from '../domain/conversation/conversation.repository';
import {
  Conversation,
  Message,
} from '../domain/conversation/conversation.entity';
import { pcmToWav } from '../infrastructure/audio/wav.util';
import logger from '../infrastructure/logger';
import {
  getTranscriptionService,
  getTextToSpeechService,
  getStreamingTTSService,
} from '../domain/audio/audio.factory';
import { transcriptionConfigs } from '../config';
import { AgentSwarmService } from '../infrastructure/ai/agentSwarm.service';

// Map TTS engine names to their streaming service keys
const streamProviderMap: Record<string, string> = {
  azure: 'azure-stream',
  elevenlabs: 'elevenlabs-stream',
};

export class VoiceAgentService {
  private activeTTSControllers: Map<string, AbortController> = new Map();

  constructor(
    private readonly conversationRepository: IConversationRepository,
    private readonly agentSwarmService: AgentSwarmService
  ) {
    logger.info(
      'VoiceAgentService initialized with dual-AI runtime (local + agent-swarm)'
    );
  }

  public async processAudio(
    conversationId: string,
    audioChunk: Buffer,
    sttEngine: string,
    ttsEngine: string,
    context?: any,
    chatMode: 'single' | 'stream' = 'stream',
    onTextChunk?: (chunk: string) => void,
    onAudioChunk?: (chunk: Buffer) => void,
    onTranscript?: (transcript: string) => void
  ): Promise<{
    transcript: string;
    aiResponse: string;
    audioResponse: Buffer | null;
  }> {
    const sessionId = context?.session?.id || conversationId;
    const overallStartTime = Date.now();
    logger.info(
      `[${conversationId}] Starting audio processing with STT: ${sttEngine}, TTS: ${ttsEngine}`
    );

    // 1. Get or create conversation
    const conversationStartTime = Date.now();
    let conversation =
      await this.conversationRepository.findById(conversationId);
    if (!conversation) {
      conversation = new Conversation(conversationId);
      await this.conversationRepository.save(conversation);
    }
    const conversationDuration = Date.now() - conversationStartTime;
    logger.debug(
      `[${conversationId}] Conversation setup took ${conversationDuration}ms`
    );

    // 2. Transcribe audio
    const transcriptionStartTime = Date.now();
    const sttConfig = transcriptionConfigs[sttEngine];
    let audioBuffer = audioChunk;
    if (sttConfig?.inputType === 'container') {
      audioBuffer = pcmToWav(audioChunk);
    }

    // 3. Transcribe audio using the selected service
    const transcriptionService = getTranscriptionService(sttEngine);
    const transcript = await transcriptionService.transcribe(audioBuffer);
    const transcriptionDuration = Date.now() - transcriptionStartTime;
    logger.info(
      `[${conversationId}] Transcription (${sttEngine}) took ${transcriptionDuration}ms`
    );
    logger.debug(`[${conversationId}] Transcript: "${transcript}"`);

    // Send transcript immediately after transcription (especially important for streaming mode)
    if (transcript && !transcript.startsWith('[') && onTranscript) {
      onTranscript(transcript);
    }

    if (!transcript || transcript.startsWith('[')) {
      const overallDuration = Date.now() - overallStartTime;
      logger.info(
        `[${conversationId}] Processing completed early (empty/invalid transcript) in ${overallDuration}ms`
      );
      return {
        transcript,
        aiResponse: '',
        audioResponse: null,
      };
    }
    conversation.addMessage(new Message('user', transcript));

    // 4. Generate AI response with dynamic routing
    const aiResponseStartTime = Date.now();
    let aiResponse: string;
    let aiResponseDuration = 0;
    const isAuthenticated = !!context?.session?.bearerToken;

    logger.debug(`[${conversationId}] Authentication check:`, {
      hasContext: !!context,
      hasSession: !!context?.session,
      hasBearerToken: !!context?.session?.bearerToken,
      isAuthenticated,
      sessionId: context?.session?.id,
      chatMode,
    });

    // Determine backend based on conditions
    const selectedBackend = isAuthenticated ? 'agent-swarm' : 'auth-prompt';

    try {
      if (selectedBackend === 'agent-swarm') {
        // Tools detected and user is authenticated - use agent-swarm
        logger.debug(
          `[${conversationId}] Using agent-swarm AI (tools detected, authenticated) in ${chatMode} mode`
        );

        // Add current datetime to context for enhanced responses
        const enhancedContext = {
          ...context,
          datetime: new Date().toISOString(),
        };

        if (chatMode === 'stream') {
          // Streaming mode - use chatStream and handle real-time responses
          logger.debug(
            `[${conversationId}] Generating streaming response using agent-swarm with session: ${context.session.id}`
          );

          const chunks: string[] = [];

          // Create AbortController for streaming operations
          const abortController = new AbortController();
          this.activeTTSControllers.set(sessionId, abortController);

          try {
            // Get streaming TTS service if available
            const streamingTtsService = streamProviderMap[ttsEngine]
              ? getStreamingTTSService(streamProviderMap[ttsEngine])
              : null;
            let audioStreamPromise: Promise<void> | null = null;

            if (streamingTtsService && onAudioChunk) {
              // Create async generator for text chunks
              const textChunkGenerator = async function* (
                this: VoiceAgentService
              ) {
                for await (const chunk of this.agentSwarmService.chatStream(
                  transcript,
                  context.session.bearerToken,
                  enhancedContext
                )) {
                  logger.debug(
                    `[${conversationId}] Streaming text chunk: "${chunk}"`
                  );
                  chunks.push(chunk);
                  if (onTextChunk) {
                    onTextChunk(chunk);
                  }
                  yield chunk;
                }
              }.bind(this);

              // Start streaming TTS in parallel
              audioStreamPromise = (async () => {
                try {
                  for await (const audioChunk of streamingTtsService.synthesizeStream(
                    textChunkGenerator(),
                    abortController.signal
                  )) {
                    onAudioChunk(audioChunk);
                  }
                } catch (error) {
                  if (error instanceof Error && error.name === 'AbortError') {
                    logger.info(
                      `[${conversationId}] Streaming TTS was cancelled for session ${sessionId}`
                    );
                  } else {
                    logger.error(
                      `[${conversationId}] Streaming TTS failed:`,
                      error
                    );
                  }
                }
              })();
            } else {
              // No streaming TTS available, just stream text
              for await (const chunk of this.agentSwarmService.chatStream(
                transcript,
                context.session.bearerToken,
                enhancedContext
              )) {
                chunks.push(chunk);
                if (onTextChunk) {
                  onTextChunk(chunk);
                }
              }
            }

            // Wait for audio streaming to complete if it was started
            if (audioStreamPromise) {
              await audioStreamPromise;
            }

            aiResponse = chunks.join('');
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
              logger.info(
                `[${conversationId}] Streaming was cancelled for session ${sessionId}`
              );
            } else {
              throw error;
            }
            aiResponse = chunks.join('');
          } finally {
            this.activeTTSControllers.delete(sessionId);
          }
        } else {
          // Single mode - use regular chat
          logger.debug(
            `[${conversationId}] Generating response using agent-swarm with session: ${context.session.id}`
          );
          const response = await this.agentSwarmService.chat(
            transcript,
            context.session.bearerToken,
            enhancedContext
          );
          aiResponse = response.response;
        }

        logger.debug(
          `[${conversationId}] Agent-swarm AI Response: "${aiResponse}"`
        );
      } else {
        // Tools detected but user is not authenticated - prompt for authentication
        logger.debug(
          `[${conversationId}] Tools detected but user not authenticated - prompting for auth`
        );
        aiResponse =
          'I can help you with that once you sign in to your account. Please authenticate to access external tools like email, calendar, and booking services.';
      }

      aiResponseDuration = Date.now() - aiResponseStartTime;
      logger.info(
        `[${conversationId}] AI response generation (${selectedBackend}, ${chatMode}) took ${aiResponseDuration}ms`
      );
    } catch (error) {
      aiResponseDuration = Date.now() - aiResponseStartTime;
      logger.error(
        `[${conversationId}] AI response generation failed with ${selectedBackend} backend in ${chatMode} mode after ${aiResponseDuration}ms:`,
        error
      );

      // For auth-prompt case, this shouldn't happen but handle gracefully
      aiResponse =
        "I apologize, but I'm having trouble processing your request right now. Please try again.";
    }

    conversation.addMessage(new Message('assistant', aiResponse));

    // 6. Synthesize audio response using the selected service (only for single mode)
    let audioResponse: Buffer | null = null;
    let ttsDuration = 0;

    if (chatMode === 'single') {
      const ttsStartTime = Date.now();
      const ttsService = getTextToSpeechService(ttsEngine);

      // Create AbortController for TTS cancellation
      const abortController = new AbortController();
      this.activeTTSControllers.set(sessionId, abortController);

      try {
        audioResponse = await ttsService.synthesize(
          aiResponse,
          abortController.signal
        );
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          logger.info(
            `[${conversationId}] TTS synthesis was cancelled for session ${sessionId}`
          );
        } else {
          logger.error(`[${conversationId}] TTS synthesis failed:`, error);
        }
      } finally {
        // Clean up the controller from the map
        this.activeTTSControllers.delete(sessionId);
      }

      ttsDuration = Date.now() - ttsStartTime;
      logger.info(
        `[${conversationId}] Text-to-speech synthesis (${ttsEngine}) took ${ttsDuration}ms`
      );
      logger.debug(
        `[${conversationId}] Synthesized audio response: ${
          audioResponse ? audioResponse.length : 0
        } bytes`
      );
    } else {
      logger.debug(
        `[${conversationId}] Skipping single TTS synthesis in streaming mode`
      );
    }

    // 7. Save conversation
    const saveStartTime = Date.now();
    await this.conversationRepository.save(conversation);
    const saveDuration = Date.now() - saveStartTime;
    logger.debug(
      `[${conversationId}] Conversation save took ${saveDuration}ms`
    );

    // Log overall processing summary
    const overallDuration = Date.now() - overallStartTime;
    logger.info(
      `[${conversationId}] Total audio processing completed in ${overallDuration}ms (${chatMode} mode) - Breakdown: Transcription: ${transcriptionDuration}ms, AI: ${aiResponseDuration || 'N/A'}ms, TTS: ${ttsDuration}ms`
    );

    return { transcript, aiResponse, audioResponse };
  }

  public async cancelCurrentTTS(sessionId: string): Promise<void> {
    const controller = this.activeTTSControllers.get(sessionId);
    if (controller) {
      logger.info(`Cancelling active TTS operation for session ${sessionId}`);
      controller.abort();
      this.activeTTSControllers.delete(sessionId);
    } else {
      logger.debug(`No active TTS operation found for session ${sessionId}`);
    }
  }
}

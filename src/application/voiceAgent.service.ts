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
import { AgentCoreService } from '../infrastructure/ai/agentCore.service';

// Map TTS engine names to their streaming service keys
const streamProviderMap: Record<string, string> = {
  azure: 'azure-stream',
  elevenlabs: 'elevenlabs-stream',
  minimax: 'minimax-stream',
};

export class VoiceAgentService {
  private activeSessionControllers: Map<
    string,
    { ttsCtrl: AbortController; aiCtrl: AbortController }
  > = new Map();

  constructor(
    private readonly conversationRepository: IConversationRepository,
    private readonly agentCoreService: AgentCoreService
  ) {
    logger.info('VoiceAgentService initialized');
  }

  private startNewSessionControllers(sessionId: string): {
    ttsCtrl: AbortController;
    aiCtrl: AbortController;
  } {
    // Check if existing controllers exist and abort them
    const existingControllers = this.activeSessionControllers.get(sessionId);
    if (existingControllers) {
      logger.info(
        `Aborting existing TTS and AI operations for session ${sessionId}`
      );
      existingControllers.ttsCtrl.abort();
      existingControllers.aiCtrl.abort();
    }

    // Create new controllers and store them
    const ttsCtrl = new AbortController();
    const aiCtrl = new AbortController();
    const controllers = { ttsCtrl, aiCtrl };
    this.activeSessionControllers.set(sessionId, controllers);
    logger.debug(`Created new session controllers for session ${sessionId}`);

    return controllers;
  }

  private cleanupSessionControllers(sessionId: string): void {
    this.activeSessionControllers.delete(sessionId);
    logger.debug(`Cleaned up session controllers for session ${sessionId}`);
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

    // Cancel any existing operations for this session immediately
    await this.cancelCurrentSession(sessionId);

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
    const selectedBackend = isAuthenticated ? 'agent-core' : 'auth-prompt';

    try {
      if (selectedBackend === 'agent-core') {
        // Tools detected and user is authenticated - use agent-core
        logger.debug(
          `[${conversationId}] Using agent-core AI (tools detected, authenticated) in ${chatMode} mode`
        );

        // Add current datetime to context for enhanced responses
        const enhancedContext = {
          ...context,
          datetime: new Date().toISOString(),
        };

        if (chatMode === 'stream') {
          // Streaming mode - use chatStream and handle real-time responses
          logger.debug(
            `[${conversationId}] Generating streaming response using agent-core with session: ${context.session.id}`
          );

          const chunks: string[] = [];

          // Create AbortControllers for streaming operations
          const { ttsCtrl, aiCtrl } =
            this.startNewSessionControllers(sessionId);

          try {
            // Get streaming TTS service if available
            const streamingTtsService = streamProviderMap[ttsEngine]
              ? getStreamingTTSService(streamProviderMap[ttsEngine])
              : null;

            if (streamingTtsService && onAudioChunk) {
              // Decouple text and audio streaming for smooth, non-blocking performance

              // Text buffer for async communication between streams
              const textChunkQueue: string[] = [];
              let textStreamingComplete = false;
              let textStreamingError: Error | null = null;

              // Start text streaming immediately - this runs independently
              const textStreamingPromise = (async () => {
                try {
                  logger.debug(
                    `[${conversationId}] Starting independent text streaming`
                  );
                  for await (const chunk of this.agentCoreService.chatStream(
                    transcript,
                    context.session.bearerToken,
                    enhancedContext,
                    aiCtrl.signal
                  )) {
                    logger.debug(
                      `[${conversationId}] Streaming text chunk: "${chunk}"`
                    );
                    chunks.push(chunk);

                    // Send text chunk immediately - no blocking!
                    if (onTextChunk) {
                      onTextChunk(chunk);
                    }

                    // Add to queue for audio processing
                    textChunkQueue.push(chunk);
                  }
                  textStreamingComplete = true;
                  logger.debug(
                    `[${conversationId}] Text streaming completed, ${chunks.length} chunks total`
                  );
                } catch (error) {
                  textStreamingError = error as Error;
                  textStreamingComplete = true;
                  if (error instanceof Error && error.name === 'AbortError') {
                    logger.info(
                      `[${conversationId}] Text streaming was cancelled`
                    );
                  } else {
                    logger.error(
                      `[${conversationId}] Text streaming failed:`,
                      error
                    );
                  }
                }
              })();

              // Create async generator that consumes from the text queue
              const audioTextGenerator =
                async function* (): AsyncGenerator<string> {
                  let buffer = '';
                  let queueIndex = 0;
                  // Expanded delimiters for more natural paragraph detection
                  const sentenceEnders = ['.', '!', '?', '\n'];

                  while (
                    !textStreamingComplete ||
                    queueIndex < textChunkQueue.length
                  ) {
                    // Check for text streaming errors
                    if (textStreamingError) {
                      logger.error(
                        `[${conversationId}] Text streaming error in audio generator:`,
                        textStreamingError
                      );
                      break;
                    }

                    // Consume available chunks from the queue and add to buffer
                    while (queueIndex < textChunkQueue.length) {
                      const chunk = textChunkQueue[queueIndex];
                      if (chunk) {
                        buffer += chunk;
                      }
                      queueIndex++;
                    }

                    // Find the last occurrence of a sentence ender
                    let lastEnderIndex = -1;
                    for (let i = buffer.length - 1; i >= 0; i--) {
                      const char = buffer[i];
                      if (char && sentenceEnders.includes(char)) {
                        lastEnderIndex = i;
                        break;
                      }
                    }

                    // If an ender is found, yield the content up to it
                    if (lastEnderIndex !== -1) {
                      const textToYield = buffer.substring(
                        0,
                        lastEnderIndex + 1
                      );
                      buffer = buffer.substring(lastEnderIndex + 1);

                      if (textToYield.trim()) {
                        logger.debug(
                          `[${conversationId}] Yielding paragraph for TTS: "${textToYield}"`
                        );
                        yield textToYield;
                      }
                    }

                    // If no more chunks and streaming not complete, wait briefly
                    if (
                      queueIndex >= textChunkQueue.length &&
                      !textStreamingComplete
                    ) {
                      await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                  }

                  // After the loop, flush any remaining content in the buffer
                  if (buffer.trim()) {
                    logger.debug(
                      `[${conversationId}] Flushing remaining buffer for TTS: "${buffer}"`
                    );
                    yield buffer;
                  }

                  logger.debug(
                    `[${conversationId}] Audio text generator completed, processed ${queueIndex} chunks`
                  );
                };

              // Start audio streaming in parallel - this doesn't block text streaming
              const audioStreamingPromise = (async () => {
                try {
                  logger.debug(
                    `[${conversationId}] Starting parallel audio streaming`
                  );
                  let audioChunkCount = 0;
                  for await (const audioChunk of streamingTtsService.synthesizeStream(
                    audioTextGenerator(),
                    ttsCtrl.signal
                  )) {
                    audioChunkCount++;
                    onAudioChunk(audioChunk);
                  }
                  logger.debug(
                    `[${conversationId}] Audio streaming completed, ${audioChunkCount} audio chunks sent`
                  );
                } catch (error) {
                  if (error instanceof Error && error.name === 'AbortError') {
                    logger.info(
                      `[${conversationId}] Audio streaming was cancelled`
                    );
                  } else {
                    logger.error(
                      `[${conversationId}] Audio streaming failed:`,
                      error
                    );
                  }
                }
              })();

              // Wait for text streaming to complete (audio runs independently)
              await textStreamingPromise;

              // Don't wait for audio - let it complete in background
              // This ensures text streaming remains smooth and responsive
              audioStreamingPromise.catch((error) => {
                // Audio errors should never affect text streaming
                if (error instanceof Error && error.name !== 'AbortError') {
                  logger.error(
                    `[${conversationId}] Background audio streaming error:`,
                    error
                  );
                }
              });
            } else {
              // No streaming TTS available, just stream text
              for await (const chunk of this.agentCoreService.chatStream(
                transcript,
                context.session.bearerToken,
                enhancedContext,
                aiCtrl.signal
              )) {
                chunks.push(chunk);
                if (onTextChunk) {
                  onTextChunk(chunk);
                }
              }
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
            this.cleanupSessionControllers(sessionId);
          }
        } else {
          // Single mode - use regular chat
          logger.debug(
            `[${conversationId}] Generating response using agent-core with session: ${context.session.id}`
          );
          const response = await this.agentCoreService.chat(
            transcript,
            context.session.bearerToken,
            enhancedContext
          );
          aiResponse = response.response;
        }

        logger.debug(
          `[${conversationId}] Agent-core AI Response: "${aiResponse}"`
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

      // Create AbortControllers for TTS cancellation
      const { ttsCtrl } = this.startNewSessionControllers(sessionId);

      try {
        audioResponse = await ttsService.synthesize(aiResponse, ttsCtrl.signal);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          logger.info(
            `[${conversationId}] TTS synthesis was cancelled for session ${sessionId}`
          );
        } else {
          logger.error(`[${conversationId}] TTS synthesis failed:`, error);
        }
      } finally {
        // Clean up the controllers from the map
        this.cleanupSessionControllers(sessionId);
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

  public async cancelCurrentSession(sessionId: string): Promise<void> {
    const controllers = this.activeSessionControllers.get(sessionId);
    if (controllers) {
      logger.info(
        `Cancelling active TTS and AI operations for session ${sessionId}`
      );
      controllers.ttsCtrl.abort();
      controllers.aiCtrl.abort();
      this.activeSessionControllers.delete(sessionId);
    } else {
      logger.debug(`No active operations found for session ${sessionId}`);
    }
  }
}

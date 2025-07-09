import type { ILanguageModel } from '../domain/ai/ai.service';
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
} from '../domain/audio/audio.factory';
import { transcriptionConfigs } from '../config';
import type { AgentSwarmLanguageModel } from '../infrastructure/ai/agentSwarmLanguageModel.service';
import type { IToolIntentDetector } from '../domain/intent/intentDetector.service';

export class VoiceAgentService {
  private activeTTSControllers: Map<string, AbortController> = new Map();

  constructor(
    private readonly localLanguageModel: ILanguageModel,
    private readonly conversationRepository: IConversationRepository,
    private readonly agentSwarmLanguageModel: AgentSwarmLanguageModel,
    private readonly intentDetector: IToolIntentDetector
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
    context?: any
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

    // 4. Detect tool intent from transcript
    const intentDetectionStartTime = Date.now();
    const intentResult = await this.intentDetector.detectToolIntent(transcript);
    const intentDetectionDuration = Date.now() - intentDetectionStartTime;
    logger.info(
      `[${conversationId}] Intent detection took ${intentDetectionDuration}ms.`
    );
    logger.debug(`[${conversationId}] Tool intent detection result:`, {
      requiresTools: intentResult.requiresTools,
      detectedTools: intentResult.detectedTools,
      confidence: intentResult.confidence,
    });

    // 5. Generate AI response with dynamic routing
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
    });

    // Determine backend based on conditions
    let selectedBackend: string;
    if (intentResult.requiresTools) {
      selectedBackend = isAuthenticated ? 'agent-swarm' : 'auth-prompt';
    } else {
      selectedBackend = 'local';
    }

    try {
      if (selectedBackend === 'agent-swarm') {
        // Tools detected and user is authenticated - use agent-swarm
        logger.debug(
          `[${conversationId}] Using agent-swarm AI (tools detected, authenticated)`
        );

        // Add current datetime to context for enhanced responses
        const enhancedContext = {
          ...context,
          datetime: new Date().toISOString(),
        };

        logger.debug(
          `[${conversationId}] Generating response using agent-swarm with session: ${context.session.id}`
        );
        aiResponse = await this.agentSwarmLanguageModel.generateResponse(
          conversation.getHistory(),
          transcript,
          enhancedContext
        );

        logger.debug(
          `[${conversationId}] Agent-swarm AI Response: "${aiResponse}"`
        );
      } else if (selectedBackend === 'auth-prompt') {
        // Tools detected but user is not authenticated - prompt for authentication
        logger.debug(
          `[${conversationId}] Tools detected but user not authenticated - prompting for auth`
        );
        aiResponse =
          'I can help you with that once you sign in to your account. Please authenticate to access external tools like email, calendar, and booking services.';
      } else {
        // No tools detected - use local AI
        logger.debug(`[${conversationId}] Using local AI (no tools detected)`);
        aiResponse = await this.localLanguageModel.generateResponse(
          conversation.getHistory(),
          transcript,
          context,
          ttsEngine
        );
        logger.debug(`[${conversationId}] Local AI Response: "${aiResponse}"`);
      }

      aiResponseDuration = Date.now() - aiResponseStartTime;
      logger.info(
        `[${conversationId}] AI response generation (${selectedBackend}) took ${aiResponseDuration}ms`
      );
    } catch (error) {
      aiResponseDuration = Date.now() - aiResponseStartTime;
      logger.error(
        `[${conversationId}] AI response generation failed with ${selectedBackend} backend after ${aiResponseDuration}ms:`,
        error
      );

      // Implement fallback behavior
      if (selectedBackend === 'agent-swarm') {
        logger.info(
          `[${conversationId}] Agent-swarm failed, attempting fallback to local AI`
        );
        const fallbackStartTime = Date.now();
        try {
          aiResponse = await this.localLanguageModel.generateResponse(
            conversation.getHistory(),
            transcript,
            context,
            ttsEngine
          );
          const fallbackDuration = Date.now() - fallbackStartTime;
          logger.info(
            `[${conversationId}] Successfully generated response using local AI fallback in ${fallbackDuration}ms`
          );
        } catch (fallbackError) {
          const fallbackDuration = Date.now() - fallbackStartTime;
          logger.error(
            `[${conversationId}] Local AI fallback also failed after ${fallbackDuration}ms:`,
            fallbackError
          );
          aiResponse =
            '[Error: AI service temporarily unavailable. Please try again later.]';
        }
      } else if (selectedBackend === 'local') {
        // For local AI mode, provide appropriate error message
        if (error instanceof Error) {
          if (error.message.includes('API key')) {
            aiResponse =
              '[Error: AI service configuration issue. Please contact support.]';
          } else if (error.message.includes('rate limit')) {
            aiResponse =
              '[Error: AI service temporarily unavailable due to rate limiting. Please try again later.]';
          } else {
            aiResponse =
              '[Error: Could not generate AI response. Please try again.]';
          }
        } else {
          aiResponse =
            '[Error: Could not generate AI response. Please try again.]';
        }
      } else {
        // For auth-prompt case, this shouldn't happen but handle gracefully
        aiResponse =
          "I apologize, but I'm having trouble processing your request right now. Please try again.";
      }
    }

    conversation.addMessage(new Message('assistant', aiResponse));

    // 6. Synthesize audio response using the selected service
    const ttsStartTime = Date.now();
    const ttsService = getTextToSpeechService(ttsEngine);

    // Create AbortController for TTS cancellation
    const abortController = new AbortController();
    this.activeTTSControllers.set(sessionId, abortController);

    let audioResponse: Buffer | null = null;
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

    const ttsDuration = Date.now() - ttsStartTime;
    logger.info(
      `[${conversationId}] Text-to-speech synthesis (${ttsEngine}) took ${ttsDuration}ms`
    );
    logger.debug(
      `[${conversationId}] Synthesized audio response: ${
        audioResponse ? audioResponse.length : 0
      } bytes`
    );

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
      `[${conversationId}] Total audio processing completed in ${overallDuration}ms - Breakdown: Transcription: ${transcriptionDuration}ms, Intent: ${intentDetectionDuration}ms, AI: ${aiResponseDuration || 'N/A'}ms, TTS: ${ttsDuration}ms`
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

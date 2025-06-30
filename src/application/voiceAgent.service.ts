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
    // 1. Get or create conversation
    let conversation =
      await this.conversationRepository.findById(conversationId);
    if (!conversation) {
      conversation = new Conversation(conversationId);
      await this.conversationRepository.save(conversation);
    }

    // 2. Transcribe audio
    const sttConfig = transcriptionConfigs[sttEngine];
    let audioBuffer = audioChunk;
    if (sttConfig?.inputType === 'container') {
      audioBuffer = pcmToWav(audioChunk);
    }

    // 3. Transcribe audio using the selected service
    const transcriptionService = getTranscriptionService(sttEngine);
    const transcript = await transcriptionService.transcribe(audioBuffer);
    logger.debug(`[${conversationId}] Transcript: "${transcript}"`);
    if (!transcript || transcript.startsWith('[')) {
      return {
        transcript,
        aiResponse: '',
        audioResponse: null,
      };
    }
    conversation.addMessage(new Message('user', transcript));

    // 4. Detect tool intent from transcript
    const intentResult = await this.intentDetector.detectToolIntent(transcript);
    logger.debug(`[${conversationId}] Tool intent detection result:`, {
      requiresTools: intentResult.requiresTools,
      detectedTools: intentResult.detectedTools,
      confidence: intentResult.confidence,
    });

    // 5. Generate AI response with dynamic routing
    let aiResponse: string;
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
          context
        );
        logger.debug(`[${conversationId}] Local AI Response: "${aiResponse}"`);
      }

      logger.info(
        `[${conversationId}] AI backend selected: ${selectedBackend}`
      );
    } catch (error) {
      logger.error(
        `[${conversationId}] AI response generation failed with ${selectedBackend} backend:`,
        error
      );

      // Implement fallback behavior
      if (selectedBackend === 'agent-swarm') {
        logger.info(
          `[${conversationId}] Agent-swarm failed, attempting fallback to local AI`
        );
        try {
          aiResponse = await this.localLanguageModel.generateResponse(
            conversation.getHistory(),
            transcript,
            context
          );
          logger.info(
            `[${conversationId}] Successfully generated response using local AI fallback`
          );
        } catch (fallbackError) {
          logger.error(
            `[${conversationId}] Local AI fallback also failed:`,
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
    const ttsService = getTextToSpeechService(ttsEngine);
    const audioResponse = await ttsService.synthesize(aiResponse);
    logger.debug(
      `[${conversationId}] Synthesized audio response: ${
        audioResponse ? audioResponse.length : 0
      } bytes`
    );

    // 7. Save conversation
    await this.conversationRepository.save(conversation);

    return { transcript, aiResponse, audioResponse };
  }
}

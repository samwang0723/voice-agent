import type {
  ITranscriptionService,
  ITextToSpeechService,
} from '../domain/audio/audio.service';
import type { ILanguageModel } from '../domain/ai/ai.service';
import type { IConversationRepository } from '../domain/conversation/conversation.repository';
import {
  Conversation,
  Message,
} from '../domain/conversation/conversation.entity';
import { pcmToWav } from '../infrastructure/audio/wav.util';
import logger from '../infrastructure/logger';

export class VoiceAgentService {
  constructor(
    private readonly transcriptionService: ITranscriptionService,
    private readonly ttsService: ITextToSpeechService,
    private readonly languageModel: ILanguageModel,
    private readonly conversationRepository: IConversationRepository
  ) {}

  public async processAudio(
    conversationId: string,
    audioChunk: Buffer,
    context?: any
  ): Promise<{
    transcript: string;
    aiResponse: string;
    audioResponse: Buffer | null;
  }> {
    // 1. Get or create conversation
    let conversation = await this.conversationRepository.findById(conversationId);
    if (!conversation) {
      conversation = new Conversation(conversationId);
      await this.conversationRepository.save(conversation);
    }

    // 2. Convert audio to WAV
    const wavBuffer = pcmToWav(audioChunk);

    // 3. Transcribe audio
    const transcript = await this.transcriptionService.transcribe(wavBuffer);
    logger.debug(`[${conversationId}] Transcript: "${transcript}"`);
    if (!transcript || transcript.startsWith('[')) {
      return {
        transcript,
        aiResponse: '',
        audioResponse: null,
      };
    }
    conversation.addMessage(new Message('user', transcript));

    // 4. Generate AI response
    const aiResponse = await this.languageModel.generateResponse(
      conversation.getHistory(),
      transcript,
      context
    );
    logger.debug(`[${conversationId}] AI Response: "${aiResponse}"`);
    conversation.addMessage(new Message('assistant', aiResponse));

    // 5. Synthesize audio response
    const audioResponse = await this.ttsService.synthesize(aiResponse);
    logger.debug(
      `[${conversationId}] Synthesized audio response: ${
        audioResponse ? audioResponse.length : 0
      } bytes`
    );

    // 6. Save conversation
    await this.conversationRepository.save(conversation);

    return { transcript, aiResponse, audioResponse };
  }
} 
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

export class VoiceAgentService {
  constructor(
    private readonly languageModel: ILanguageModel,
    private readonly conversationRepository: IConversationRepository
  ) {}

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
    let conversation = await this.conversationRepository.findById(conversationId);
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

    // 4. Generate AI response
    const aiResponse = await this.languageModel.generateResponse(
      conversation.getHistory(),
      transcript,
      context
    );
    logger.debug(`[${conversationId}] AI Response: "${aiResponse}"`);
    conversation.addMessage(new Message('assistant', aiResponse));

    // 5. Synthesize audio response using the selected service
    const ttsService = getTextToSpeechService(ttsEngine);
    const audioResponse = await ttsService.synthesize(aiResponse);
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
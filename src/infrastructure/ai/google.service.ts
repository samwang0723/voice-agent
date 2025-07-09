import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { generateText } from 'ai';
import type { LanguageModelV1 } from 'ai';
import { getCurrentModelConfig } from '../../config';
import type { ILanguageModel } from '../../domain/ai/ai.service';
import type { Message } from '../../domain/conversation/conversation.entity';
import logger from '../logger';

export class GoogleLanguageModel implements ILanguageModel {
  private model: LanguageModelV1;

  constructor() {
    const config = getCurrentModelConfig();
    if (config.provider !== 'google') {
      throw new Error(
        'GoogleLanguageModel service was initialized with a non-Google model.'
      );
    }
    if (!config.apiKey) {
      throw new Error('Google API key is not configured.');
    }

    const google = createGoogleGenerativeAI({
      apiKey: config.apiKey,
    });
    this.model = google(`models/${config.modelName}`);
    logger.info(`Initialized Google Language Model: ${config.modelName}`);
  }

  async generateResponse(
    history: Message[],
    newUserMessage: string,
    context?: any,
    ttsEngine?: string
  ): Promise<string> {
    try {
      const isJarvis = ttsEngine === 'groq' || ttsEngine === 'elevenlabs';
      const agentName = isJarvis ? 'Jarvis' : 'Veronica';

      const systemPrompt =
        agentName === 'Jarvis'
          ? 'You are a professional virtual assistant named Jarvis of mine (always call me Sir). Provide assistance, concise, natural responses suitable for voice interaction. Keep responses conversational and brief unless more detail is specifically requested. It is ok to make a joke in a natural way. Behave like Jarvis from Iron Man movie.'
          : 'You are a professional virtual assistant named Veronica of mine (always call me Sir). Provide assistance, concise, natural responses suitable for voice interaction. Keep responses conversational and brief unless more detail is specifically requested. It is ok to make a joke in a natural way. Behave like Veronica from Iron Man movie.';

      const contextPrompt = context?.datetime
        ? ` The current date and time is ${context.datetime}.`
        : '';

      logger.info(`current datetime: ${context?.datetime}`);

      // Convert domain messages to AI SDK format
      const messages = history.map(({ role, content }) => ({
        role: role,
        content: content,
      }));

      // Add the new user message
      messages.push({ role: 'user', content: newUserMessage });

      const { text } = await generateText({
        model: this.model,
        system: `${systemPrompt}${contextPrompt}`,
        messages: messages,
        temperature: 0.7,
        maxTokens: 500, // Keep responses reasonably short for voice interaction
      });

      return text;
    } catch (error) {
      logger.error('Failed to generate AI response from Google:', error);
      return '[Error: Could not generate AI response]';
    }
  }
}

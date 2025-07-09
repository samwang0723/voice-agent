import { Message } from '../conversation/conversation.entity';

export interface ILanguageModel {
  generateResponse(
    history: Message[],
    newUserMessage: string,
    context?: any,
    ttsEngine?: string
  ): Promise<string>;
}

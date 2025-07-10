export interface ILanguageModel {
  generateResponse(
    newUserMessage: string,
    context?: any,
    ttsEngine?: string
  ): Promise<string>;
}

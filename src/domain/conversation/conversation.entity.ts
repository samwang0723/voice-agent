export type MessageRole = 'user' | 'assistant' | 'system';

export class Message {
  constructor(
    public readonly role: MessageRole,
    public readonly content: string,
    public readonly timestamp: Date = new Date()
  ) {}
}

export class Conversation {
  public messages: Message[];

  constructor(
    public readonly id: string,
    initialMessages: Message[] = []
  ) {
    this.messages = initialMessages;
  }

  addMessage(message: Message) {
    this.messages.push(message);
  }

  getHistory(): Message[] {
    return this.messages;
  }
} 
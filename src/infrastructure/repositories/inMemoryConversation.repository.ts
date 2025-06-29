import { Conversation } from '../../domain/conversation/conversation.entity';
import type { IConversationRepository } from '../../domain/conversation/conversation.repository';

export class InMemoryConversationRepository implements IConversationRepository {
  private conversations = new Map<string, Conversation>();

  async findById(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.get(id);
    return conversation || null;
  }

  async save(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.id, conversation);
  }

  async delete(id: string): Promise<void> {
    this.conversations.delete(id);
  }
} 
import { Conversation } from './conversation.entity';

export interface IConversationRepository {
  findById(id: string): Promise<Conversation | null>;
  save(conversation: Conversation): Promise<void>;
  delete(id: string): Promise<void>;
} 
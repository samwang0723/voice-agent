import { Session } from '../../domain/session/session.entity';
import type { ISessionRepository } from '../../domain/session/session.repository';

export class InMemorySessionRepository implements ISessionRepository {
  private sessions = new Map<string, Session>();

  async findById(id: string): Promise<Session | null> {
    const session = this.sessions.get(id);
    return session || null;
  }

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }
} 
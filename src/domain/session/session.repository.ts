import { Session } from './session.entity';

export interface ISessionRepository {
  findById(id: string): Promise<Session | null>;
  save(session: Session): Promise<void>;
  delete(id: string): Promise<void>;
} 
import 'dotenv/config';
import { serverConfig } from './config';
import { GoogleLanguageModel } from './infrastructure/ai/google.service';
import {
  GroqTextToSpeechService,
  GroqTranscriptionService,
} from './infrastructure/ai/groq.service';
import { InMemoryConversationRepository } from './infrastructure/repositories/inMemoryConversation.repository';
import { InMemorySessionRepository } from './infrastructure/repositories/inMemorySession.repository';
import { VoiceAgentService } from './application/voiceAgent.service';
import { createServer } from './interfaces/http/server.ts';
import { WebSocketHandler } from './interfaces/websocket/websocket.handler';
import type { WebSocketData } from './interfaces/websocket/websocket.handler';
import logger from './infrastructure/logger';

// 1. Initialize repositories
const sessionRepository = new InMemorySessionRepository();
const conversationRepository = new InMemoryConversationRepository();

// 2. Initialize external services (AI, TTS, STT)
const languageModel = new GoogleLanguageModel();
const transcriptionService = new GroqTranscriptionService();
const ttsService = new GroqTextToSpeechService();

// 3. Initialize application service
const voiceAgentService = new VoiceAgentService(
  transcriptionService,
  ttsService,
  languageModel,
  conversationRepository
);

// 4. Initialize WebSocket handler
const webSocketHandler = new WebSocketHandler(
  voiceAgentService,
  sessionRepository
);

// 5. Create and configure the server
const { app, webSocketCallbacks } = createServer(webSocketHandler);

// 6. Start the server
const server = Bun.serve({
  fetch: app.fetch,
  port: serverConfig.port,
  websocket: webSocketCallbacks,
});

logger.info(`Server listening on http://localhost:${server.port}`);

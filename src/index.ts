import logger from './infrastructure/logger';
import { applyWebSocketPatches } from './infrastructure/patches/websocket.patch';

// Apply WebSocket patches for third-party library compatibility
applyWebSocketPatches();

import { serverConfig } from './config';
import { GoogleLanguageModel } from './infrastructure/ai/google.service';
import { InMemoryConversationRepository } from './infrastructure/repositories/inMemoryConversation.repository';
import { InMemorySessionRepository } from './infrastructure/repositories/inMemorySession.repository';
import { VoiceAgentService } from './application/voiceAgent.service';
import { createServer } from './interfaces/http/server.ts';
import { WebSocketHandler } from './interfaces/websocket/websocket.handler';

// 1. Initialize repositories
const sessionRepository = new InMemorySessionRepository();
const conversationRepository = new InMemoryConversationRepository();

// 2. Initialize external services (AI)
const languageModel = new GoogleLanguageModel();

// 3. Initialize application service
const voiceAgentService = new VoiceAgentService(
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

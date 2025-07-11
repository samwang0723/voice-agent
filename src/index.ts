import logger from './infrastructure/logger';
import { applyWebSocketPatches } from './infrastructure/patches/websocket.patch';

// Handle unhandled promise rejections for debugging
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection:', reason);
});

// Apply WebSocket patches for third-party library compatibility
applyWebSocketPatches();

import { serverConfig, agentSwarmConfig } from './config';
import { AgentSwarmService } from './infrastructure/ai/agentSwarm.service';
import { InMemoryConversationRepository } from './infrastructure/repositories/inMemoryConversation.repository';
import { InMemorySessionRepository } from './infrastructure/repositories/inMemorySession.repository';
import { VoiceAgentService } from './application/voiceAgent.service';
import { createServer } from './interfaces/http/server.ts';
import { WebSocketHandler } from './interfaces/websocket/websocket.handler';

// 1. Initialize repositories
const sessionRepository = new InMemorySessionRepository();
const conversationRepository = new InMemoryConversationRepository();

// 2. Initialize external services (AI) - Agent-Core Engine
const agentSwarmService = new AgentSwarmService();

logger.info(`Agent-Swarm API URL: ${agentSwarmConfig.baseURL}`);
logger.info(`Stream timeout: ${agentSwarmConfig.streamTimeout}ms`);
logger.info(`Max retries: ${agentSwarmConfig.maxRetries}`);
logger.info('Agent-Swarm AI initialized successfully');
logger.info(
  'Enhanced cancellation mechanism enabled for both AI streaming and TTS operations'
);

// 3. Initialize application service
const voiceAgentService = new VoiceAgentService(
  conversationRepository,
  agentSwarmService
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

// Graceful shutdown handling
const gracefulShutdown = (signal: string) => {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  // Cancel any active sessions
  try {
    // The session cleanup will be handled by the VoiceAgentService
    // when the process exits, but we log the shutdown attempt
    logger.info('Cleaning up active sessions...');
  } catch (error) {
    logger.error('Error during shutdown cleanup:', error);
  }

  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

logger.info(`Server listening on http://localhost:${server.port}`);

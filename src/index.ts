import logger from './infrastructure/logger';
import { applyWebSocketPatches } from './infrastructure/patches/websocket.patch';

// Apply WebSocket patches for third-party library compatibility
applyWebSocketPatches();

import {
  serverConfig,
  agentSwarmConfig,
  isAgentSwarmConfigured,
  getIntentDetectorMode,
} from './config';
import { GoogleLanguageModel } from './infrastructure/ai/google.service';
import { AgentSwarmService } from './infrastructure/ai/agentSwarm.service';
import { AgentSwarmLanguageModel } from './infrastructure/ai/agentSwarmLanguageModel.service';
import type { ILanguageModel } from './domain/ai/ai.service';
import { InMemoryConversationRepository } from './infrastructure/repositories/inMemoryConversation.repository';
import { InMemorySessionRepository } from './infrastructure/repositories/inMemorySession.repository';
import { VoiceAgentService } from './application/voiceAgent.service';
import { createServer } from './interfaces/http/server.ts';
import { WebSocketHandler } from './interfaces/websocket/websocket.handler';
import { KeywordIntentDetector } from './infrastructure/intent/keywordIntentDetector.service';
import { PatternIntentDetector } from './infrastructure/intent/patternIntentDetector.service';
import { CompositeIntentDetector } from './infrastructure/intent/compositeIntentDetector.service';
import type { IToolIntentDetector } from './domain/intent/intentDetector.service';

// 1. Initialize repositories
const sessionRepository = new InMemorySessionRepository();
const conversationRepository = new InMemoryConversationRepository();

// 2. Initialize external services (AI) - Dual-AI runtime
logger.info('Initializing dual-AI runtime...');

// Initialize local AI model
let localLanguageModel: ILanguageModel;
try {
  localLanguageModel = new GoogleLanguageModel();
  logger.info('Local AI (Google Language Model) initialized successfully');
} catch (error) {
  logger.error('Failed to initialize local AI:', error);
  process.exit(1);
}

// Initialize agent-swarm AI model
let agentSwarmLanguageModel: AgentSwarmLanguageModel;
try {
  // Check if agent-swarm is configured
  if (!isAgentSwarmConfigured()) {
    logger.warn('Agent-Swarm is not configured (missing AGENT_SWARM_API_URL)');
    logger.warn('External tool functionality will be limited');
  } else {
    logger.info(`Agent-Swarm API URL: ${agentSwarmConfig.baseURL}`);
    logger.info(`Stream timeout: ${agentSwarmConfig.streamTimeout}ms`);
    logger.info(`Max retries: ${agentSwarmConfig.maxRetries}`);
  }

  // Initialize agent-swarm services regardless of configuration
  // The AgentSwarmLanguageModel will handle missing config gracefully
  const agentSwarmService = new AgentSwarmService();
  agentSwarmLanguageModel = new AgentSwarmLanguageModel();
  logger.info('Agent-Swarm AI initialized successfully');
} catch (error) {
  logger.error('Failed to initialize agent-swarm AI:', error);
  process.exit(1);
}

// Initialize intent detector based on configuration
function createIntentDetector(): IToolIntentDetector {
  const mode = getIntentDetectorMode();
  
  switch (mode) {
    case 'keyword':
      logger.info('Initializing keyword-based intent detector');
      return new KeywordIntentDetector();
      
    case 'pattern':
      logger.info('Initializing pattern-based intent detector');
      return new PatternIntentDetector();
      
    case 'hybrid':
      logger.info('Initializing hybrid intent detector (keyword + pattern)');
      return new CompositeIntentDetector([
        new KeywordIntentDetector(),
        new PatternIntentDetector()
      ]);
      
    default:
      logger.warn(`Unknown intent detector mode '${mode}', falling back to keyword detector`);
      return new KeywordIntentDetector();
  }
}

const intentDetector = createIntentDetector();
logger.info(`Intent detector initialized in '${getIntentDetectorMode()}' mode`);

logger.info('Dual-AI runtime initialization complete');
logger.info(
  'AI selection will be dynamic based on user intent and authentication'
);

// 3. Initialize application service
const voiceAgentService = new VoiceAgentService(
  localLanguageModel,
  conversationRepository,
  agentSwarmLanguageModel,
  intentDetector
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
logger.info('Dual-AI runtime is active');
logger.info('Local AI: Available for general conversations');
logger.info(
  `Agent-Swarm AI: ${isAgentSwarmConfigured() ? 'Available' : 'Not configured'} for external tool requests`
);
logger.info('Authentication: Optional (required only for external tools)');
logger.info(
  'AI selection: Dynamic based on user intent and authentication status'
);

import logger from '../infrastructure/logger';

export const serverConfig = {
  port: process.env.PORT || 3000,
  logLevel: process.env.LOG_LEVEL || 'info',
};

export type ModelProvider =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'groq'
  | 'cartesia'
  | 'deepgram'
  | 'elevenlabs';

export type IntentDetectorMode = 'keyword' | 'pattern' | 'hybrid';

export interface ModelConfig {
  provider: ModelProvider;
  modelName: string;
  apiKey?: string;
  baseURL?: string;
}

export interface TranscriptionConfig extends ModelConfig {
  format?: 'wav' | 'webm';
  language?: string;
  encoding?: string;
  sampleRate?: number;
  inputType?: 'raw' | 'container';
}

// AI Model Configurations
export const modelConfigs: Record<string, ModelConfig> = {
  'gemini-1.5-flash': {
    provider: 'google',
    modelName: 'gemini-1.5-flash-latest',
    apiKey: process.env.GOOGLE_API_KEY,
  },
  'claude-3-haiku': {
    provider: 'anthropic',
    modelName: 'claude-3-haiku-20240307',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  'gpt-4o': {
    provider: 'openai',
    modelName: 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY,
  },
};

// Transcription Model Configurations
export const transcriptionConfigs: Record<string, TranscriptionConfig> = {
  groq: {
    provider: 'groq',
    modelName: 'whisper-large-v3-turbo',
    apiKey: process.env.GROQ_API_KEY,
    format: (process.env.GROQ_TRANSCRIPTION_FORMAT as 'wav' | 'webm') || 'wav',
    inputType: 'container',
  },
  cartesia: {
    provider: 'cartesia',
    modelName: 'ink-whisper',
    apiKey: process.env.CARTESIA_API_KEY,
    language: 'en',
    encoding: 'pcm_s16le',
    sampleRate: 16000,
    inputType: 'raw',
  },
  deepgram: {
    provider: 'deepgram',
    modelName: 'nova-2',
    apiKey: process.env.DEEPGRAM_API_KEY,
    language: 'en',
    inputType: 'container',
  },
};

export interface TextToSpeechConfig extends ModelConfig {
  voiceId?: string;
}

// Text-to-Speech Model Configurations
export const ttsConfigs: Record<string, TextToSpeechConfig> = {
  groq: {
    provider: 'groq',
    modelName: 'playai-tts',
    apiKey: process.env.GROQ_API_KEY,
  },
  cartesia: {
    provider: 'cartesia',
    modelName: 'sonic-2',
    apiKey: process.env.CARTESIA_API_KEY,
    voiceId: process.env.CARTESIA_VOICE_ID,
  },
  deepgram: {
    provider: 'deepgram',
    modelName: 'aura-2-iris-en',
    apiKey: process.env.DEEPGRAM_API_KEY,
  },
  elevenlabs: {
    provider: 'elevenlabs',
    modelName: process.env.ELEVENLABS_MODEL_NAME || 'eleven_multilingual_v2',
    apiKey: process.env.ELEVENLABS_API_KEY,
    voiceId: process.env.ELEVENLABS_VOICE_ID,
  },
};

// Agent-Swarm Configuration
export interface AgentSwarmConfig {
  baseURL: string;
  streamTimeout: number;
  maxRetries: number;
  retryDelay: number;
}

export interface IntentDetectorConfig {
  mode: IntentDetectorMode;
  confidenceThreshold: number;
}

export const agentSwarmConfig: AgentSwarmConfig = {
  baseURL: process.env.AGENT_SWARM_API_URL || 'http://localhost:8900/api/v1',
  streamTimeout: parseInt(process.env.AGENT_SWARM_STREAM_TIMEOUT || '30000'),
  maxRetries: parseInt(process.env.AGENT_SWARM_MAX_RETRIES || '3'),
  retryDelay: parseInt(process.env.AGENT_SWARM_RETRY_DELAY || '1000'),
};

// Intent Detector Configuration
export const intentDetectorConfig: IntentDetectorConfig = {
  mode: (process.env.INTENT_DETECTOR_MODE as IntentDetectorMode) || 'keyword',
  confidenceThreshold: parseFloat(
    process.env.INTENT_CONFIDENCE_THRESHOLD || '0.5'
  ),
};

// Function to get the current model from environment variables or a default
export const getCurrentModelKey = (): string => {
  return process.env.LLM_MODEL || 'gemini-1.5-flash';
};

export const getCurrentModelConfig = (): ModelConfig => {
  const modelKey = getCurrentModelKey();
  const config = modelConfigs[modelKey];
  if (!config) {
    throw new Error(`Invalid LLM_MODEL key: ${modelKey}`);
  }
  return config;
};

// Lazy validation helper function for agent-swarm configuration
export const isAgentSwarmConfigured = (): boolean => {
  return !!agentSwarmConfig.baseURL;
};

// Function to get the current intent detector mode
export const getIntentDetectorMode = (): IntentDetectorMode => {
  return intentDetectorConfig.mode;
};

// Log the current model configuration on startup
const currentModelInfo = getCurrentModelConfig();
logger.info(
  `Using LLM model: ${currentModelInfo.modelName} (Provider: ${currentModelInfo.provider})`
);

if (!currentModelInfo.apiKey) {
  logger.warn(
    `API key for ${currentModelInfo.provider} is not configured. AI features may not work.`
  );
}

// Log dual-AI runtime initialization
logger.info('Dual-AI runtime initialized');

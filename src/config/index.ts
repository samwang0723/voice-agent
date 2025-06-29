import 'dotenv/config';
import logger from '../infrastructure/logger';

export const serverConfig = {
  port: process.env.PORT || 3000,
  logLevel: process.env.LOG_LEVEL || 'info',
};

export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'groq';

export interface ModelConfig {
  provider: ModelProvider;
  modelName: string;
  apiKey?: string;
  baseURL?: string;
}

export interface TranscriptionConfig extends ModelConfig {
  format?: 'wav' | 'webm';
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
  },
};

// Text-to-Speech Model Configurations
export const ttsConfigs: Record<string, ModelConfig> = {
  groq: {
    provider: 'groq',
    modelName: 'playai-tts',
    apiKey: process.env.GROQ_API_KEY,
  },
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
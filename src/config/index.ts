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
  | 'elevenlabs'
  | 'azure'
  | 'minimax';

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
  azure: {
    provider: 'azure',
    modelName: 'azure-speech',
    apiKey: process.env.AZURE_SPEECH_API_KEY,
    language: 'en-US',
    inputType: 'container',
  },
};

export interface TextToSpeechConfig extends ModelConfig {
  voiceId?: string;
  groupId?: string; // Add Group ID for MiniMax
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
  azure: {
    provider: 'azure',
    modelName: 'azure-tts',
    apiKey: process.env.AZURE_SPEECH_API_KEY,
    voiceId: process.env.AZURE_TTS_VOICE_ID || 'en-GB-OllieMultilingualNeural',
  },
  minimax: {
    provider: 'minimax',
    modelName: process.env.MINIMAX_TTS_MODEL || 'speech-02-hd',
    apiKey: process.env.MINIMAX_API_KEY,
    voiceId: process.env.MINIMAX_VOICE_ID,
    groupId: process.env.MINIMAX_GROUP_ID,
    baseURL: 'https://api.minimaxi.chat',
  },
};

// Streaming Audio Configuration
export interface StreamingAudioConfig {
  chunkSize: number;
  sampleWidth: number;
}

export const streamingAudioConfig: StreamingAudioConfig = {
  chunkSize: 16000, // 16KB chunks for ~80ms at 16kHz mono PCM
  sampleWidth: 2, // bytes per 16-bit sample
};

// Agent-Swarm Configuration
export interface AgentSwarmConfig {
  baseURL: string;
  streamTimeout: number;
  maxRetries: number;
  retryDelay: number;
}

export const agentSwarmConfig: AgentSwarmConfig = {
  baseURL: process.env.AGENT_SWARM_API_URL || 'http://localhost:3030/api/v1',
  streamTimeout: parseInt(process.env.AGENT_SWARM_STREAM_TIMEOUT || '30000'),
  maxRetries: parseInt(process.env.AGENT_SWARM_MAX_RETRIES || '3'),
  retryDelay: parseInt(process.env.AGENT_SWARM_RETRY_DELAY || '1000'),
};

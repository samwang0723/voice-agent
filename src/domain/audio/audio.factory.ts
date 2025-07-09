import {
  GroqTranscriptionService,
  GroqTextToSpeechService,
} from '../../infrastructure/ai/groq.service';
import {
  CartesiaTranscriptionService,
  CartesiaTextToSpeechService,
} from '../../infrastructure/ai/cartesia.service';
import {
  DeepgramTranscriptionService,
  DeepgramTextToSpeechService,
} from '../../infrastructure/ai/deepgram.service';
import { ElevenLabsTextToSpeechService } from '../../infrastructure/ai/elevenlabs.service';
import { 
  AzureTranscriptionService,
  AzureTextToSpeechService 
} from '../../infrastructure/ai/azure.service';
import type {
  ITranscriptionService,
  ITextToSpeechService,
} from './audio.service';
import logger from '../../infrastructure/logger';

const transcriptionServices: Record<string, ITranscriptionService> = {
  groq: new GroqTranscriptionService(),
  cartesia: new CartesiaTranscriptionService(),
  deepgram: new DeepgramTranscriptionService(),
  azure: new AzureTranscriptionService(),
};

const ttsServices: Record<string, ITextToSpeechService> = {
  groq: new GroqTextToSpeechService(),
  cartesia: new CartesiaTextToSpeechService(),
  deepgram: new DeepgramTextToSpeechService(),
  elevenlabs: new ElevenLabsTextToSpeechService(),
  azure: new AzureTextToSpeechService(),
};

export function getTranscriptionService(
  provider: string
): ITranscriptionService {
  const service = transcriptionServices[provider];
  if (!service) {
    logger.warn(
      `Transcription provider '${provider}' not found. Defaulting to 'groq'.`
    );
    return transcriptionServices.groq as ITranscriptionService;
  }
  return service;
}

export function getTextToSpeechService(provider: string): ITextToSpeechService {
  const service = ttsServices[provider];
  if (!service) {
    logger.warn(
      `TTS provider '${provider}' not found. Defaulting to 'elevenlabs'.`
    );
    return ttsServices.elevenlabs as ITextToSpeechService;
  }
  return service;
}

import Groq from 'groq-sdk';
import { transcriptionConfigs, ttsConfigs } from '../../config';
import type {
  ITranscriptionService,
  ITextToSpeechService,
} from '../../domain/audio/audio.service';
import logger from '../logger';

// Helper function to get the Groq client
const getGroqClient = (apiKey: string | undefined) => {
  if (!apiKey) {
    logger.warn(
      'GROQ_API_KEY is not set. Groq services will not be available.'
    );
    return null;
  }
  return new Groq({ apiKey });
};

export class GroqTranscriptionService implements ITranscriptionService {
  async transcribe(audio: Buffer): Promise<string> {
    const config = transcriptionConfigs.groq;
    if (!config || !config.apiKey) {
      logger.error('Groq API key is not configured for transcription.');
      return '[Error: Groq API key not configured]';
    }

    const groq = getGroqClient(config.apiKey);
    if (!groq) return '[Error: Groq client not initialized]';

    try {
      const format = config.format || 'wav';
      const audioBlob = new Blob([audio], { type: `audio/${format}` });
      const audioFile = new File([audioBlob], `audio.${format}`, {
        type: `audio/${format}`,
      }) as any;

      const transcription = await groq.audio.transcriptions.create({
        file: audioFile,
        model: config.modelName,
        response_format: 'text',
        language: 'en',
        temperature: 0.0,
      });

      const result = (transcription as any)?.text ?? transcription;
      return result || '[No transcription available]';
    } catch (error) {
      logger.error('Groq transcription failed:', error);
      return '[Transcription failed]';
    }
  }
}

export class GroqTextToSpeechService implements ITextToSpeechService {
  async synthesize(
    text: string,
    abortSignal?: AbortSignal
  ): Promise<Buffer | null> {
    const config = ttsConfigs.groq;
    if (!config || !config.apiKey) {
      logger.error('Groq API key is not configured for TTS.');
      return null;
    }

    const groq = getGroqClient(config.apiKey);
    if (!groq) return null;

    if (text.startsWith('[') && text.endsWith(']')) {
      logger.info(`Skipping TTS for special message: ${text}`);
      return null;
    }

    try {
      if (abortSignal?.aborted) {
        logger.info('Groq TTS synthesis was cancelled');
        return null;
      }

      const response = await groq.audio.speech.create({
        model: config.modelName,
        voice: 'Basil-PlayAI', //Basil-PlayAI, Cheyenne-PlayAI
        input: text,
        response_format: 'wav',
      });

      // Check for cancellation before processing the response
      if (abortSignal?.aborted) {
        logger.info('Groq TTS cancelled before ArrayBuffer conversion');
        return null;
      }

      const arrayBuffer = await response.arrayBuffer();

      // Final check for cancellation after ArrayBuffer conversion
      if (abortSignal?.aborted) {
        logger.info('Groq TTS cancelled after ArrayBuffer conversion');
        return null;
      }

      return Buffer.from(arrayBuffer);
    } catch (error) {
      // Handle AbortError specifically
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('Groq TTS operation was cancelled');
        return null;
      }
      logger.error('Groq TTS failed:', error);
      return null;
    }
  }
}

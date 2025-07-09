import { CartesiaClient } from '@cartesia/cartesia-js';
import { transcriptionConfigs, ttsConfigs } from '../../config';
import type {
  ITranscriptionService,
  ITextToSpeechService,
} from '../../domain/audio/audio.service';
import type { TextToSpeechConfig } from '../../config';
import logger from '../logger';

const getCartesiaClient = (apiKey: string | undefined) => {
  if (!apiKey) {
    logger.warn(
      'CARTESIA_API_KEY is not set. Cartesia services will not be available.'
    );
    return null;
  }
  return new CartesiaClient({ apiKey });
};

export class CartesiaTranscriptionService implements ITranscriptionService {
  async transcribe(audio: Buffer): Promise<string> {
    const config = transcriptionConfigs.cartesia;
    if (!config || !config.apiKey) {
      logger.error('Cartesia API key is not configured for transcription.');
      return '[Error: Cartesia API key not configured]';
    }

    const cartesia = getCartesiaClient(config.apiKey);
    if (!cartesia) return '[Error: Cartesia client not initialized]';

    try {
      const sttWs = cartesia.stt.websocket({
        model: config.modelName,
        language: config.language,
        encoding: config.encoding as 'pcm_s16le',
        sampleRate: config.sampleRate,
      });

      const receiveTranscripts = (): Promise<string> => {
        return new Promise((resolve, reject) => {
          let fullTranscript = '';
          sttWs.onMessage((result) => {
            if (result.type === 'transcript') {
              if (result.isFinal) {
                fullTranscript += `${result.text} `;
              }
            } else if (result.type === 'done') {
              resolve(fullTranscript.trim());
            } else if (result.type === 'error') {
              logger.error(`Cartesia STT Error: ${result.message}`);
              reject(new Error(result.message));
            }
          });
        });
      };

      const sendAudio = async () => {
        const chunkSize = 3200; // ~100ms chunks at 16kHz 16-bit mono
        for (let i = 0; i < audio.length; i += chunkSize) {
          const chunk = audio.subarray(i, i + chunkSize);
          await sttWs.send(new Uint8Array(chunk).buffer);
        }
        await sttWs.finalize();
      };

      const [finalTranscript] = await Promise.all([
        receiveTranscripts(),
        sendAudio(),
      ]);

      sttWs.disconnect();
      return finalTranscript || '[No transcription available]';
    } catch (error) {
      logger.error('Cartesia transcription failed:', error);
      return '[Transcription failed]';
    }
  }
}

export class CartesiaTextToSpeechService implements ITextToSpeechService {
  async synthesize(
    text: string,
    abortSignal?: AbortSignal
  ): Promise<Buffer | null> {
    const config = ttsConfigs.cartesia as TextToSpeechConfig;
    if (!config || !config.apiKey || !config.voiceId) {
      logger.error('Cartesia API key or Voice ID is not configured for TTS.');
      return null;
    }

    const cartesia = getCartesiaClient(config.apiKey);
    if (!cartesia) return null;

    if (text.startsWith('[') && text.endsWith(']')) {
      logger.info(`Skipping TTS for special message: ${text}`);
      return null;
    }

    try {
      // Check if operation was cancelled before making the API call
      if (abortSignal?.aborted) {
        logger.info('Cartesia TTS operation was cancelled before API call');
        return null;
      }

      const response = await cartesia.tts.bytes({
        modelId: config.modelName,
        transcript: text,
        voice: {
          mode: 'id',
          id: config.voiceId,
        },
        outputFormat: {
          container: 'wav',
          encoding: 'pcm_s16le',
          sampleRate: 24000,
        },
      });

      // Check if operation was cancelled after the API call
      if (abortSignal?.aborted) {
        logger.info('Cartesia TTS operation was cancelled after API call');
        return null;
      }

      return Buffer.from(response as any);
    } catch (error) {
      // Handle AbortError gracefully
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('Cartesia TTS operation was cancelled');
        return null;
      }
      logger.error('Cartesia TTS failed:', error);
      return null;
    }
  }
}

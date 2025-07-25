import { ElevenLabsClient } from 'elevenlabs';
import { ttsConfigs } from '../../config';
import type { ITextToSpeechService } from '../../domain/audio/audio.service';
import type { TextToSpeechConfig } from '../../config';
import logger from '../logger';

const getElevenLabsClient = (apiKey: string | undefined) => {
  if (!apiKey) {
    logger.warn(
      'ELEVENLABS_API_KEY is not set. ElevenLabs services will not be available.'
    );
    return null;
  }
  return new ElevenLabsClient({ apiKey });
};

export class ElevenLabsTextToSpeechService implements ITextToSpeechService {
  async synthesize(
    text: string,
    abortSignal?: AbortSignal
  ): Promise<Buffer | null> {
    const config = ttsConfigs.elevenlabs as TextToSpeechConfig;
    if (!config || !config.apiKey || !config.voiceId) {
      logger.error('ElevenLabs API key or Voice ID is not configured for TTS.');
      return null;
    }

    const elevenlabs = getElevenLabsClient(config.apiKey);
    if (!elevenlabs) return null;

    if (text.startsWith('[') && text.endsWith(']')) {
      logger.info(`Skipping TTS for special message: ${text}`);
      return null;
    }

    try {
      // Check if operation was cancelled before starting
      if (abortSignal?.aborted) {
        logger.info('ElevenLabs TTS operation was cancelled before starting');
        return null;
      }

      const audioStream = await elevenlabs.textToSpeech.convert(
        config.voiceId,
        {
          text,
          model_id: config.modelName,
        }
      );

      const chunks: Buffer[] = [];
      for await (const chunk of audioStream) {
        // Check for cancellation during stream processing
        if (abortSignal?.aborted) {
          logger.info(
            'ElevenLabs TTS operation was cancelled during stream processing'
          );
          return null;
        }
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      // Handle AbortError specifically
      if (error instanceof Error && error.name === 'AbortError') {
        logger.info('ElevenLabs TTS operation was aborted');
        return null;
      }
      logger.error('ElevenLabs TTS failed:', error);
      return null;
    }
  }
}

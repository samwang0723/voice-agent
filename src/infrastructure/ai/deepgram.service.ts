import { createClient, DeepgramClient } from '@deepgram/sdk';
import { transcriptionConfigs, ttsConfigs } from '../../config';
import type {
  ITranscriptionService,
  ITextToSpeechService,
} from '../../domain/audio/audio.service';
import logger from '../logger';

const getDeepgramClient = (apiKey: string | undefined): DeepgramClient | null => {
  if (!apiKey) {
    logger.warn(
      'DEEPGRAM_API_KEY is not set. Deepgram services will not be available.',
    );
    return null;
  }
  return createClient(apiKey);
};

const getAudioBuffer = async (
  stream: ReadableStream<Uint8Array>,
): Promise<Buffer> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
    }
  }

  return Buffer.concat(chunks);
};

export class DeepgramTranscriptionService implements ITranscriptionService {
  async transcribe(audio: Buffer): Promise<string> {
    const config = transcriptionConfigs.deepgram;
    if (!config || !config.apiKey) {
      logger.error('Deepgram API key is not configured for transcription.');
      return '[Error: Deepgram API key not configured]';
    }

    const deepgram = getDeepgramClient(config.apiKey);
    if (!deepgram) return '[Error: Deepgram client not initialized]';

    try {
      const { result, error } =
        await deepgram.listen.prerecorded.transcribeFile(
          audio,
          {
            model: config.modelName,
            smart_format: true,
          },
        );

      if (error) {
        throw error;
      }

      const transcript =
        result?.results?.channels[0]?.alternatives[0]?.transcript;
      return transcript || '[No transcription available]';
    } catch (error) {
      logger.error('Deepgram transcription failed:', error);
      return '[Transcription failed]';
    }
  }
}

export class DeepgramTextToSpeechService implements ITextToSpeechService {
  async synthesize(text: string): Promise<Buffer | null> {
    const config = ttsConfigs.deepgram;
    if (!config || !config.apiKey) {
      logger.error('Deepgram API key is not configured for TTS.');
      return null;
    }

    const deepgram = getDeepgramClient(config.apiKey);
    if (!deepgram) return null;

    if (text.startsWith('[') && text.endsWith(']')) {
      logger.info(`Skipping TTS for special message: ${text}`);
      return null;
    }

    try {
      const response = await deepgram.speak.request(
        { text },
        {
          model: config.modelName,
          encoding: 'linear16',
          container: 'wav',
        },
      );

      const stream = await response.getStream();
      if (stream) {
        return getAudioBuffer(stream);
      }

      logger.error('Deepgram TTS failed: No stream received.');
      return null;
    } catch (error) {
      logger.error('Deepgram TTS failed:', error);
      return null;
    }
  }
} 
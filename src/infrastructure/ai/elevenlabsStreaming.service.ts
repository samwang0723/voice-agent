import { ElevenLabsClient } from 'elevenlabs';
import { ttsConfigs } from '../../config';
import type { IStreamingTextToSpeechService } from '../../domain/audio/audio.service';
import type { TextToSpeechConfig } from '../../config';
import logger from '../logger';

export class ElevenLabsStreamingTextToSpeechService
  implements IStreamingTextToSpeechService
{
  private elevenLabsClient: ElevenLabsClient | null = null;
  private chunkBuffer: Buffer = Buffer.alloc(0);
  private carryoverBuffer: Buffer = Buffer.alloc(0); // For handling odd-length chunks

  // Chunk buffering constants for consistent audio output
  private static readonly OUTPUT_CHUNK_SIZE = 16000; // 16KB chunks for ~80ms at 16kHz mono PCM
  private static readonly SAMPLE_WIDTH = 2; // 2 bytes per 16-bit sample

  private initializeElevenLabsClient(): ElevenLabsClient {
    if (this.elevenLabsClient) {
      return this.elevenLabsClient;
    }

    const config = ttsConfigs.elevenlabs as TextToSpeechConfig;
    if (!config || !config.apiKey) {
      throw new Error(
        'ElevenLabs API key is not configured for streaming TTS.'
      );
    }

    if (!config.voiceId) {
      throw new Error(
        'ElevenLabs Voice ID is not configured for streaming TTS.'
      );
    }

    this.elevenLabsClient = new ElevenLabsClient({
      apiKey: config.apiKey,
    });

    logger.info('ElevenLabs Streaming TTS configuration initialized');
    return this.elevenLabsClient;
  }

  async *synthesizeStream(
    textChunks: AsyncIterable<string>,
    abortSignal?: AbortSignal
  ): AsyncIterable<Buffer> {
    try {
      // Check if operation was cancelled before starting
      if (abortSignal?.aborted) {
        logger.info(
          'ElevenLabs Streaming TTS operation was cancelled before starting'
        );
        return;
      }

      // Reset buffers for new synthesis session
      this.chunkBuffer = Buffer.alloc(0);
      this.carryoverBuffer = Buffer.alloc(0);

      // Accumulate text chunks for synthesis
      let accumulatedText = '';
      const textBuffer: string[] = [];
      let isFirstChunk = true;

      // Collect text chunks
      for await (const textChunk of textChunks) {
        if (abortSignal?.aborted) {
          logger.info(
            'ElevenLabs Streaming TTS operation was cancelled during text collection'
          );
          return;
        }

        if (textChunk.trim()) {
          textBuffer.push(textChunk);
          accumulatedText += textChunk;

          // For streaming, we can start synthesis when we have enough text
          // or when we detect sentence boundaries
          const shouldSynthesize = this.shouldStartSynthesis(
            accumulatedText,
            isFirstChunk
          );

          if (shouldSynthesize) {
            // Synthesize accumulated text and yield audio chunks
            yield* this.synthesizeTextChunk(accumulatedText, abortSignal);

            // Reset for next chunk
            accumulatedText = '';
            isFirstChunk = false;
          }
        }
      }

      // Synthesize any remaining text
      if (accumulatedText.trim() && !abortSignal?.aborted) {
        yield* this.synthesizeTextChunk(accumulatedText, abortSignal);
      }

      // Flush any remaining buffered audio data
      if (this.chunkBuffer.length > 0 && !abortSignal?.aborted) {
        yield* this.flushRemainingBuffer();
      }

      // Clean up buffers
      this.chunkBuffer = Buffer.alloc(0);
      this.carryoverBuffer = Buffer.alloc(0);
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.info('ElevenLabs Streaming TTS operation was cancelled');
          return;
        }
        if (
          error.message.includes('ElevenLabs API key') ||
          error.message.includes('ElevenLabs Voice ID')
        ) {
          logger.error(error.message);
          return;
        }
      }
      logger.error('ElevenLabs Streaming TTS failed:', error);
      throw error;
    }
  }

  private shouldStartSynthesis(text: string, isFirstChunk: boolean): boolean {
    // Start synthesis on first chunk if we have some text
    if (isFirstChunk && text.trim().length > 10) {
      return true;
    }

    // Start synthesis when we hit sentence boundaries
    const sentenceEnders = /[.!?]\s/;
    if (sentenceEnders.test(text)) {
      return true;
    }

    // Start synthesis when we have accumulated enough text (to avoid too many small chunks)
    if (text.length > 100) {
      return true;
    }

    return false;
  }

  private async *synthesizeTextChunk(
    text: string,
    abortSignal?: AbortSignal
  ): AsyncIterable<Buffer> {
    if (!text.trim()) {
      return;
    }

    // Skip special messages
    if (text.startsWith('[') && text.endsWith(']')) {
      logger.info(`Skipping streaming TTS for special message: ${text}`);
      return;
    }

    try {
      const elevenLabsClient = this.initializeElevenLabsClient();
      const config = ttsConfigs.elevenlabs as TextToSpeechConfig;

      logger.debug(
        `ElevenLabs Streaming TTS starting PCM synthesis for text: "${text.substring(0, 50)}..."`
      );

      // Check if operation was cancelled before starting synthesis
      if (abortSignal?.aborted) {
        logger.info(
          'ElevenLabs Streaming TTS chunk synthesis was cancelled before starting'
        );
        return;
      }

      // Use ElevenLabs streaming API with PCM format for frontend compatibility
      const audioStream = await elevenLabsClient.textToSpeech.convertAsStream(
        config.voiceId!,
        {
          text,
          model_id: config.modelName || 'eleven_multilingual_v2',
          output_format: 'pcm_16000',
          voice_settings: {
            stability: 0.6,
            similarity_boost: 1.0,
            use_speaker_boost: true,
            style: 0.4,
            speed: 1.0,
          },
        }
      );

      logger.info(
        `ElevenLabs Streaming TTS synthesis started (PCM 16kHz format) for text: "${text.substring(0, 50)}..."`
      );

      // Iterate over the stream and yield chunks
      for await (const chunk of audioStream) {
        if (abortSignal?.aborted) {
          logger.info(
            'ElevenLabs Streaming TTS chunk synthesis was cancelled during streaming'
          );
          return;
        }

        let buffer = Buffer.from(chunk);
        logger.debug(
          `ElevenLabs Streaming TTS received PCM audio chunk: ${buffer.length} bytes`
        );

        // Validate input chunk
        if (buffer.length === 0) {
          logger.warn(
            'ElevenLabs Streaming TTS received zero-length chunk, skipping'
          );
          continue;
        }

        // Handle carryover from previous chunk if any
        if (this.carryoverBuffer.length > 0) {
          buffer = Buffer.concat([this.carryoverBuffer, buffer]);
          this.carryoverBuffer = Buffer.alloc(0);
          logger.debug(
            `ElevenLabs Streaming TTS merged carryover byte, new buffer size: ${buffer.length} bytes`
          );
        }

        // Check alignment and handle odd-length chunks
        if (
          buffer.length %
            ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH !==
          0
        ) {
          logger.debug(
            `ElevenLabs Streaming TTS handling odd-length chunk: ${buffer.length} bytes`
          );

          // Carry over the last byte to maintain alignment
          this.carryoverBuffer = buffer.subarray(buffer.length - 1);
          buffer = buffer.subarray(0, buffer.length - 1);

          logger.debug(
            `ElevenLabs Streaming TTS aligned chunk to ${buffer.length} bytes, carrying over 1 byte`
          );
        }

        // Process chunk through buffering logic
        yield* this.processAudioChunk(buffer);
      }

      // After all chunks are processed, handle any remaining carryover
      if (this.carryoverBuffer.length > 0) {
        logger.warn(
          `ElevenLabs Streaming TTS discarding ${this.carryoverBuffer.length} byte carryover at end of stream`
        );
        this.carryoverBuffer = Buffer.alloc(0);
      }

      logger.debug(
        `ElevenLabs Streaming TTS completed yielding all PCM chunks for text`
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'AbortError' || error.name === 'AbortError') {
          logger.info('ElevenLabs Streaming TTS chunk synthesis was cancelled');
          return;
        }
      }
      logger.error('ElevenLabs Streaming TTS chunk synthesis failed:', error);
      throw error;
    }
  }

  private *processAudioChunk(inputBuffer: Buffer): IterableIterator<Buffer> {
    // Append incoming buffer to chunk buffer
    this.chunkBuffer = Buffer.concat([this.chunkBuffer, inputBuffer]);

    // Yield consistent-sized chunks while we have enough data
    while (
      this.chunkBuffer.length >=
      ElevenLabsStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
    ) {
      // Extract exactly OUTPUT_CHUNK_SIZE bytes
      const outputChunk = this.chunkBuffer.subarray(
        0,
        ElevenLabsStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
      );

      // Ensure chunk is properly aligned for 16-bit PCM samples
      if (
        outputChunk.length %
          ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH !==
        0
      ) {
        logger.warn(
          `Output chunk alignment issue: ${outputChunk.length} bytes is not divisible by ${ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH}`
        );
        // Hold back the last byte to maintain alignment
        const alignedSize =
          Math.floor(
            outputChunk.length /
              ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH
          ) * ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH;
        const alignedChunk = outputChunk.subarray(0, alignedSize);
        this.chunkBuffer = Buffer.concat([
          outputChunk.subarray(alignedSize),
          this.chunkBuffer.subarray(
            ElevenLabsStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
          ),
        ]);

        if (alignedChunk.length > 0) {
          logger.debug(
            `ElevenLabs Streaming TTS yielding aligned PCM chunk: ${alignedChunk.length} bytes`
          );
          yield alignedChunk;
        }
      } else {
        // Update buffer to contain only remaining bytes
        this.chunkBuffer = this.chunkBuffer.subarray(
          ElevenLabsStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
        );

        logger.debug(
          `ElevenLabs Streaming TTS yielding consistent PCM chunk: ${outputChunk.length} bytes`
        );
        yield outputChunk;
      }
    }
  }

  private *flushRemainingBuffer(): IterableIterator<Buffer> {
    if (this.chunkBuffer.length === 0) {
      return;
    }

    // Ensure final chunk is properly aligned
    const alignedSize =
      Math.floor(
        this.chunkBuffer.length /
          ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH
      ) * ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH;

    if (alignedSize > 0) {
      const finalChunk = this.chunkBuffer.subarray(0, alignedSize);
      logger.debug(
        `ElevenLabs Streaming TTS flushing final PCM chunk: ${finalChunk.length} bytes`
      );
      yield finalChunk;
    }

    if (this.chunkBuffer.length > alignedSize) {
      logger.warn(
        `ElevenLabs Streaming TTS discarding ${this.chunkBuffer.length - alignedSize} unaligned bytes at end of stream`
      );
    }

    // Clear the buffer
    this.chunkBuffer = Buffer.alloc(0);
  }
}

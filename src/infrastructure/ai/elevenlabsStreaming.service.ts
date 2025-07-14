import { ElevenLabsClient } from 'elevenlabs';
import { ttsConfigs } from '../../config';
import type { IStreamingTextToSpeechService } from '../../domain/audio/audio.service';
import type { TextToSpeechConfig } from '../../config';
import logger from '../logger';

// Connection context for each streaming request
interface StreamingContext {
  elevenLabsClient: ElevenLabsClient | null;
  chunkBuffer: Buffer;
  carryoverBuffer: Buffer;
  sessionId: string;
}

export class ElevenLabsStreamingTextToSpeechService
  implements IStreamingTextToSpeechService
{
  // Chunk buffering constants for consistent audio output
  private static readonly OUTPUT_CHUNK_SIZE = 16000; // 16KB chunks for ~80ms at 16kHz mono PCM
  private static readonly SAMPLE_WIDTH = 2; // 2 bytes per 16-bit sample

  private createStreamingContext(): StreamingContext {
    return {
      elevenLabsClient: null,
      chunkBuffer: Buffer.alloc(0),
      carryoverBuffer: Buffer.alloc(0),
      sessionId: Math.random().toString(36).substring(2, 15),
    };
  }

  private initializeElevenLabsClient(
    context: StreamingContext
  ): ElevenLabsClient {
    if (context.elevenLabsClient) {
      return context.elevenLabsClient;
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

    context.elevenLabsClient = new ElevenLabsClient({
      apiKey: config.apiKey,
    });

    logger.info(
      `[${context.sessionId}] ElevenLabs Streaming TTS configuration initialized`
    );
    return context.elevenLabsClient;
  }

  async *synthesizeStream(
    textChunks: AsyncIterable<string>,
    abortSignal?: AbortSignal
  ): AsyncIterable<Buffer> {
    // Create a new context for this streaming request
    const context = this.createStreamingContext();

    try {
      // Check if operation was cancelled before starting
      if (abortSignal?.aborted) {
        logger.info(
          `[${context.sessionId}] ElevenLabs Streaming TTS operation was cancelled before starting`
        );
        return;
      }

      logger.info(
        `[${context.sessionId}] Starting new ElevenLabs streaming session`
      );

      // Accumulate text chunks for synthesis
      let accumulatedText = '';
      const textBuffer: string[] = [];
      let isFirstChunk = true;

      // Collect text chunks
      for await (const textChunk of textChunks) {
        if (abortSignal?.aborted) {
          logger.info(
            `[${context.sessionId}] ElevenLabs Streaming TTS operation was cancelled during text collection`
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
            yield* this.synthesizeTextChunk(
              context,
              accumulatedText,
              abortSignal
            );

            // Reset for next chunk
            accumulatedText = '';
            isFirstChunk = false;
          }
        }
      }

      // Synthesize any remaining text
      if (accumulatedText.trim() && !abortSignal?.aborted) {
        yield* this.synthesizeTextChunk(context, accumulatedText, abortSignal);
      }

      // Flush any remaining buffered audio data
      if (context.chunkBuffer.length > 0 && !abortSignal?.aborted) {
        yield* this.flushRemainingBuffer(context);
      }

      // Clean up buffers
      context.chunkBuffer = Buffer.alloc(0);
      context.carryoverBuffer = Buffer.alloc(0);
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.info(
            `[${context.sessionId}] ElevenLabs Streaming TTS operation was cancelled`
          );
          return;
        }
        if (
          error.message.includes('ElevenLabs API key') ||
          error.message.includes('ElevenLabs Voice ID')
        ) {
          logger.error(`[${context.sessionId}] ${error.message}`);
          return;
        }
      }
      logger.error(
        `[${context.sessionId}] ElevenLabs Streaming TTS failed:`,
        error
      );
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
    context: StreamingContext,
    text: string,
    abortSignal?: AbortSignal
  ): AsyncIterable<Buffer> {
    if (!text.trim()) {
      return;
    }

    // Skip special messages
    if (text.startsWith('[') && text.endsWith(']')) {
      logger.info(
        `[${context.sessionId}] Skipping streaming TTS for special message: ${text}`
      );
      return;
    }

    try {
      const elevenLabsClient = this.initializeElevenLabsClient(context);
      const config = ttsConfigs.elevenlabs as TextToSpeechConfig;

      logger.debug(
        `[${context.sessionId}] ElevenLabs Streaming TTS starting PCM synthesis for text: "${text.substring(0, 50)}..."`
      );

      // Check if operation was cancelled before starting synthesis
      if (abortSignal?.aborted) {
        logger.info(
          `[${context.sessionId}] ElevenLabs Streaming TTS chunk synthesis was cancelled before starting`
        );
        return;
      }

      // Use ElevenLabs streaming API with PCM format for frontend compatibility
      const audioStream = await elevenLabsClient.textToSpeech.convertAsStream(
        config.voiceId!,
        {
          text: text.replace(/\s+/g, ' ').trim(),
          model_id: config.modelName || 'eleven_multilingual_v2',
          output_format: 'pcm_16000',
          voice_settings: {
            stability: 0.2,
            similarity_boost: 1.0,
            use_speaker_boost: true,
            style: 0.4,
            speed: 1.0,
          },
        }
      );

      logger.info(
        `[${context.sessionId}] ElevenLabs Streaming TTS synthesis started (PCM 16kHz format) for text: "${text.substring(0, 50)}..."`
      );

      // Iterate over the stream and yield chunks
      for await (const chunk of audioStream) {
        if (abortSignal?.aborted) {
          logger.info(
            `[${context.sessionId}] ElevenLabs Streaming TTS chunk synthesis was cancelled during streaming`
          );
          return;
        }

        let buffer = Buffer.from(chunk);
        logger.debug(
          `[${context.sessionId}] ElevenLabs Streaming TTS received PCM audio chunk: ${buffer.length} bytes`
        );

        // Validate input chunk
        if (buffer.length === 0) {
          logger.warn(
            `[${context.sessionId}] ElevenLabs Streaming TTS received zero-length chunk, skipping`
          );
          continue;
        }

        // Handle carryover from previous chunk if any
        if (context.carryoverBuffer.length > 0) {
          buffer = Buffer.concat([context.carryoverBuffer, buffer]);
          context.carryoverBuffer = Buffer.alloc(0);
          logger.debug(
            `[${context.sessionId}] ElevenLabs Streaming TTS merged carryover byte, new buffer size: ${buffer.length} bytes`
          );
        }

        // Check alignment and handle odd-length chunks
        if (
          buffer.length %
            ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH !==
          0
        ) {
          logger.debug(
            `[${context.sessionId}] ElevenLabs Streaming TTS handling odd-length chunk: ${buffer.length} bytes`
          );

          // Carry over the last byte to maintain alignment
          context.carryoverBuffer = buffer.subarray(buffer.length - 1);
          buffer = buffer.subarray(0, buffer.length - 1);

          logger.debug(
            `[${context.sessionId}] ElevenLabs Streaming TTS aligned chunk to ${buffer.length} bytes, carrying over 1 byte`
          );
        }

        // Process chunk through buffering logic
        yield* this.processAudioChunk(context, buffer);
      }

      // After all chunks are processed, handle any remaining carryover
      if (context.carryoverBuffer.length > 0) {
        logger.warn(
          `[${context.sessionId}] ElevenLabs Streaming TTS discarding ${context.carryoverBuffer.length} byte carryover at end of stream`
        );
        context.carryoverBuffer = Buffer.alloc(0);
      }

      logger.debug(
        `[${context.sessionId}] ElevenLabs Streaming TTS completed yielding all PCM chunks for text`
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'AbortError' || error.name === 'AbortError') {
          logger.info(
            `[${context.sessionId}] ElevenLabs Streaming TTS chunk synthesis was cancelled`
          );
          return;
        }
      }
      logger.error(
        `[${context.sessionId}] ElevenLabs Streaming TTS chunk synthesis failed:`,
        error
      );
      throw error;
    }
  }

  private *processAudioChunk(
    context: StreamingContext,
    inputBuffer: Buffer
  ): IterableIterator<Buffer> {
    // Append incoming buffer to chunk buffer
    context.chunkBuffer = Buffer.concat([context.chunkBuffer, inputBuffer]);

    // Yield consistent-sized chunks while we have enough data
    while (
      context.chunkBuffer.length >=
      ElevenLabsStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
    ) {
      // Extract exactly OUTPUT_CHUNK_SIZE bytes
      const outputChunk = context.chunkBuffer.subarray(
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
          `[${context.sessionId}] Output chunk alignment issue: ${outputChunk.length} bytes is not divisible by ${ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH}`
        );
        // Hold back the last byte to maintain alignment
        const alignedSize =
          Math.floor(
            outputChunk.length /
              ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH
          ) * ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH;
        const alignedChunk = outputChunk.subarray(0, alignedSize);
        context.chunkBuffer = Buffer.concat([
          outputChunk.subarray(alignedSize),
          context.chunkBuffer.subarray(
            ElevenLabsStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
          ),
        ]);

        if (alignedChunk.length > 0) {
          logger.debug(
            `[${context.sessionId}] ElevenLabs Streaming TTS yielding aligned PCM chunk: ${alignedChunk.length} bytes`
          );
          yield alignedChunk;
        }
      } else {
        // Update buffer to contain only remaining bytes
        context.chunkBuffer = context.chunkBuffer.subarray(
          ElevenLabsStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
        );

        logger.debug(
          `[${context.sessionId}] ElevenLabs Streaming TTS yielding consistent PCM chunk: ${outputChunk.length} bytes`
        );
        yield outputChunk;
      }
    }
  }

  private *flushRemainingBuffer(
    context: StreamingContext
  ): IterableIterator<Buffer> {
    if (context.chunkBuffer.length === 0) {
      return;
    }

    // Ensure final chunk is properly aligned
    const alignedSize =
      Math.floor(
        context.chunkBuffer.length /
          ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH
      ) * ElevenLabsStreamingTextToSpeechService.SAMPLE_WIDTH;

    if (alignedSize > 0) {
      const finalChunk = context.chunkBuffer.subarray(0, alignedSize);
      logger.debug(
        `[${context.sessionId}] ElevenLabs Streaming TTS flushing final PCM chunk: ${finalChunk.length} bytes`
      );
      yield finalChunk;
    }

    if (context.chunkBuffer.length > alignedSize) {
      logger.warn(
        `[${context.sessionId}] ElevenLabs Streaming TTS discarding ${context.chunkBuffer.length - alignedSize} unaligned bytes at end of stream`
      );
    }

    // Clear the buffer
    context.chunkBuffer = Buffer.alloc(0);
  }
}

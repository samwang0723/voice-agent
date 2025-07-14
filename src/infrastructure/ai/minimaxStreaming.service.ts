import { ttsConfigs } from '../../config';
import type { IStreamingTextToSpeechService } from '../../domain/audio/audio.service';
import type { TextToSpeechConfig } from '../../config';
import logger from '../logger';

interface MinimaxVoiceSettings {
  voice_id: string;
  speed: number;
  vol: number;
  pitch: number;
  emotion: string;
}

interface MinimaxAudioSettings {
  sample_rate: number;
  bitrate: number;
  format: string;
  channel: number;
}

interface MinimaxTaskResponse {
  event: string;
  data?: {
    audio?: string;
  };
  is_final?: boolean;
}

// Connection context for each streaming request
interface StreamingContext {
  ws: WebSocket | null;
  chunkBuffer: Buffer;
  carryoverBuffer: Buffer;
  isTaskStarted: boolean;
  sessionId: string;
}

export class MinimaxStreamingTextToSpeechService
  implements IStreamingTextToSpeechService
{
  // Audio processing constants - matching ElevenLabs for consistency
  // raw-16khz-16bit-mono-pcm
  private static readonly OUTPUT_CHUNK_SIZE = 16000; // 16KB chunks for ~80ms at 16kHz mono PCM
  private static readonly SAMPLE_WIDTH = 2; // 2 bytes per 16-bit PCM sample
  private static readonly WS_URL = 'wss://api.minimax.io/ws/v1/t2a_v2';

  private readonly defaultVoiceSettings: MinimaxVoiceSettings = {
    voice_id:
      ttsConfigs.minimax?.voiceId ||
      'moss_audio_73457c58-5ee8-11f0-ba28-7e51ceb5ef24',
    speed: 1,
    vol: 1,
    pitch: 0,
    emotion: 'happy',
  };

  private readonly defaultAudioSettings: MinimaxAudioSettings = {
    sample_rate: 16000, // Client expects 16kHz (matching VAD and audio player)
    bitrate: 128000,
    format: 'pcm',
    channel: 1,
  };

  private createStreamingContext(): StreamingContext {
    return {
      ws: null,
      chunkBuffer: Buffer.alloc(0),
      carryoverBuffer: Buffer.alloc(0),
      isTaskStarted: false,
      sessionId: Math.random().toString(36).substring(2, 15),
    };
  }

  private async initializeWebSocketConnection(
    context: StreamingContext
  ): Promise<WebSocket> {
    if (context.ws && context.ws.readyState === WebSocket.OPEN) {
      return context.ws;
    }

    const config = ttsConfigs.minimax as TextToSpeechConfig;
    if (!config || !config.apiKey) {
      throw new Error('Minimax API key is not configured for streaming TTS.');
    }

    return new Promise((resolve, reject) => {
      try {
        context.ws = new WebSocket(MinimaxStreamingTextToSpeechService.WS_URL, {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
        });

        const connectionTimeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
        }, 10000);

        context.ws.onopen = () => {
          logger.debug(
            `[${context.sessionId}] Minimax WebSocket connection opened`
          );
        };

        context.ws.onmessage = (event) => {
          try {
            const response = JSON.parse(event.data);
            if (response.event === 'connected_success') {
              clearTimeout(connectionTimeout);
              logger.info(
                `[${context.sessionId}] Minimax Streaming TTS WebSocket connection established`
              );
              resolve(context.ws!);
            }
          } catch (error) {
            logger.error(
              `[${context.sessionId}] Failed to parse WebSocket connection response:`,
              error
            );
            reject(error);
          }
        };

        context.ws.onerror = (error) => {
          clearTimeout(connectionTimeout);
          logger.error(
            `[${context.sessionId}] Minimax WebSocket connection error:`,
            error
          );
          reject(new Error('WebSocket connection failed'));
        };

        context.ws.onclose = (event) => {
          logger.debug(
            `[${context.sessionId}] Minimax WebSocket connection closed: ${event.code} ${event.reason}`
          );
          context.ws = null;
          context.isTaskStarted = false;
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private async startTask(context: StreamingContext): Promise<void> {
    // Ensure WebSocket connection is ready
    if (!context.ws || context.ws.readyState !== WebSocket.OPEN) {
      logger.warn(
        `[${context.sessionId}] WebSocket not ready, re-establishing connection...`
      );
      await this.initializeWebSocketConnection(context);
    }

    if (context.isTaskStarted) {
      return;
    }

    const config = ttsConfigs.minimax as TextToSpeechConfig;
    const voiceSettings = { ...this.defaultVoiceSettings };
    const audioSettings = { ...this.defaultAudioSettings };

    // Apply config overrides
    if (config.voiceId) {
      voiceSettings.voice_id = config.voiceId;
    }

    const startMessage = {
      event: 'task_start',
      model: config.modelName || 'speech-02-hd',
      voice_setting: voiceSettings,
      audio_setting: audioSettings,
    };

    return new Promise((resolve, reject) => {
      if (!context.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      // Check WebSocket state before sending
      if (context.ws.readyState !== WebSocket.OPEN) {
        reject(
          new Error(
            `WebSocket not ready for task start. State: ${context.ws.readyState}`
          )
        );
        return;
      }

      // Store reference to current WebSocket to avoid null access issues
      const currentWs = context.ws;
      let isResolved = false;

      const messageHandler = (event: MessageEvent) => {
        try {
          const response = JSON.parse(event.data);
          if (response.event === 'task_started') {
            currentWs.removeEventListener('message', messageHandler);
            context.isTaskStarted = true;
            logger.debug(
              `[${context.sessionId}] Minimax TTS task started successfully`
            );
            if (!isResolved) {
              isResolved = true;
              resolve();
            }
          } else if (response.event === 'error') {
            currentWs.removeEventListener('message', messageHandler);
            if (!isResolved) {
              isResolved = true;
              reject(
                new Error(
                  `Task start failed: ${response.message || 'Unknown error'}`
                )
              );
            }
          }
        } catch (error) {
          currentWs.removeEventListener('message', messageHandler);
          if (!isResolved) {
            isResolved = true;
            reject(error);
          }
        }
      };

      currentWs.addEventListener('message', messageHandler);

      try {
        currentWs.send(JSON.stringify(startMessage));
      } catch (error) {
        currentWs.removeEventListener('message', messageHandler);
        if (!isResolved) {
          isResolved = true;
          reject(new Error(`Failed to send task start message: ${error}`));
        }
        return;
      }

      // Add timeout for task start
      const timeoutId = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          currentWs.removeEventListener('message', messageHandler);
          reject(new Error('Task start timeout'));
        }
      }, 5000);

      // Clean up timeout if promise resolves before timeout
      const originalResolve = resolve;
      const originalReject = reject;

      resolve = (...args) => {
        clearTimeout(timeoutId);
        originalResolve(...args);
      };

      reject = (...args) => {
        clearTimeout(timeoutId);
        originalReject(...args);
      };
    });
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
          `[${context.sessionId}] Minimax Streaming TTS operation was cancelled before starting`
        );
        return;
      }

      logger.info(
        `[${context.sessionId}] Starting new Minimax streaming session`
      );

      // Initialize WebSocket connection for this context
      await this.initializeWebSocketConnection(context);

      // Start the task first
      await this.startTask(context);

      try {
        // Process text chunks incrementally for better real-time performance
        let accumulatedText = '';
        let isFirstChunk = true;

        for await (const textChunk of textChunks) {
          if (abortSignal?.aborted) {
            logger.info(
              `[${context.sessionId}] Minimax Streaming TTS operation was cancelled during text collection`
            );
            break;
          }

          if (textChunk.trim() && !textChunk.startsWith('[')) {
            accumulatedText += textChunk;

            // Check if we should start synthesis for accumulated text
            const shouldSynthesize = this.shouldStartSynthesis(
              accumulatedText,
              isFirstChunk
            );

            if (shouldSynthesize) {
              logger.info(
                `[${context.sessionId}] Starting Minimax TTS synthesis for text: "${accumulatedText.substring(0, 50)}..." (${accumulatedText.length} chars)`
              );

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
          logger.info(
            `[${context.sessionId}] Synthesizing remaining text: "${accumulatedText.substring(0, 50)}..." (${accumulatedText.length} chars)`
          );
          yield* this.synthesizeTextChunk(
            context,
            accumulatedText,
            abortSignal
          );
        }

        // Send task_finish after all text chunks have been processed
        await this.finishTask(context);

        // Handle any remaining carryover
        yield* this.flushRemainingBuffer(context);
      } finally {
        // Cleanup is handled in closeConnection()
      }

      // Clean up buffers
      context.chunkBuffer = Buffer.alloc(0);
      context.carryoverBuffer = Buffer.alloc(0);
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.info(
            `[${context.sessionId}] Minimax Streaming TTS operation was cancelled`
          );
          return;
        }
        if (
          error.message.includes('Minimax API key') ||
          error.message.includes('WebSocket')
        ) {
          logger.error(`[${context.sessionId}] ${error.message}`);
          return;
        }
      }
      logger.error(
        `[${context.sessionId}] Minimax Streaming TTS failed:`,
        error
      );
      throw error;
    } finally {
      await this.closeConnection(context);
    }
  }

  private async sendTextChunk(
    context: StreamingContext,
    text: string
  ): Promise<void> {
    if (!context.ws || context.ws.readyState !== WebSocket.OPEN) {
      logger.warn(
        `[${context.sessionId}] WebSocket connection not available for sending text chunk`
      );
      return; // Don't throw, just skip this chunk
    }

    const continueMessage = {
      event: 'task_continue',
      text: text.replace(/\s+/g, ' ').trim(),
    };

    logger.debug(
      `[${context.sessionId}] Minimax Streaming TTS sending text chunk:`,
      continueMessage
    );

    try {
      context.ws.send(JSON.stringify(continueMessage));
    } catch (error) {
      logger.error(`[${context.sessionId}] Failed to send text chunk:`, error);
      // Don't throw, just log the error to prevent breaking the stream
    }
  }

  private async finishTask(context: StreamingContext): Promise<void> {
    if (!context.ws || context.ws.readyState !== WebSocket.OPEN) {
      logger.warn(
        `[${context.sessionId}] WebSocket connection not available for finishing task`
      );
      return; // Don't throw, just skip finishing
    }

    const finishMessage = {
      event: 'task_finish',
    };

    logger.debug(
      `[${context.sessionId}] Minimax Streaming TTS sending task_finish`
    );

    try {
      context.ws.send(JSON.stringify(finishMessage));
    } catch (error) {
      logger.error(
        `[${context.sessionId}] Failed to send task_finish message:`,
        error
      );
      // Don't throw, just log the error
    }
  }

  private hexToBuffer(hexString: string): Buffer {
    if (hexString.length % 2 !== 0) {
      logger.warn('Odd-length hex string received, padding with zero');
      hexString = '0' + hexString;
    }

    const buffer = Buffer.from(hexString, 'hex');
    logger.debug(
      `Converted hex string (${hexString.length} chars) to buffer (${buffer.length} bytes)`
    );

    return buffer;
  }

  private shouldStartSynthesis(text: string, isFirstChunk: boolean): boolean {
    // Start synthesis on first chunk if we have some text
    if (isFirstChunk && text.trim().length > 5) {
      return true;
    }

    // Start synthesis when we hit sentence boundaries
    const sentenceEnders = /[.!?]\s/;
    if (sentenceEnders.test(text)) {
      return true;
    }

    // Start synthesis when we have accumulated enough text (optimized for streaming)
    if (text.length > 50) {
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
      logger.debug(
        `[${context.sessionId}] Minimax Streaming TTS starting synthesis for text chunk: "${text.substring(0, 50)}..."`
      );

      // Check if operation was cancelled before starting synthesis
      if (abortSignal?.aborted) {
        logger.info(
          `[${context.sessionId}] Minimax Streaming TTS chunk synthesis was cancelled before starting`
        );
        return;
      }

      // Set up audio chunk collection for this text chunk
      const audioChunkQueue: Buffer[] = [];
      let audioCollectionFinished = false;
      let audioCollectionError: Error | null = null;

      // Store reference to current WebSocket
      if (!context.ws || context.ws.readyState !== 1) {
        logger.warn(
          `[${context.sessionId}] WebSocket not ready for chunk synthesis, re-establishing...`
        );
        await this.initializeWebSocketConnection(context);
        await this.startTask(context);
      }

      const currentWs = context.ws;
      if (!currentWs) {
        logger.error(
          `[${context.sessionId}] Failed to establish WebSocket connection for chunk synthesis`
        );
        return;
      }

      // Track audio statistics for this chunk
      let audioMessageCount = 0;
      let totalAudioBytesReceived = 0;

      // Set up message handler for this specific text chunk
      const messageHandler = (event: MessageEvent) => {
        try {
          if (abortSignal?.aborted) {
            return;
          }

          const response: MinimaxTaskResponse = JSON.parse(event.data);

          logger.debug(
            `[${context.sessionId}] Minimax chunk message: ${response.event}${response.is_final ? ' (final)' : ''}`
          );

          if (response.data?.audio) {
            audioMessageCount++;
            const hexAudio = response.data.audio;
            const audioBuffer = this.hexToBuffer(hexAudio);
            totalAudioBytesReceived += audioBuffer.length;

            logger.debug(
              `[${context.sessionId}] Chunk audio message #${audioMessageCount}: ${audioBuffer.length} bytes`
            );

            // Process the audio chunk and add to queue
            for (const chunk of this.processAudioChunk(context, audioBuffer)) {
              audioChunkQueue.push(chunk);
            }
          }

          // Check for errors
          if (response.event === 'error') {
            logger.error(
              `[${context.sessionId}] Minimax chunk error: ${JSON.stringify(response)}`
            );
            audioCollectionError = new Error(
              `Minimax chunk error: ${JSON.stringify(response)}`
            );
          }

          if (response.is_final) {
            logger.info(
              `[${context.sessionId}] Minimax chunk final message received. Audio messages: ${audioMessageCount}, bytes: ${totalAudioBytesReceived}`
            );
            audioCollectionFinished = true;
          }
        } catch (error) {
          logger.error(
            `[${context.sessionId}] Error processing chunk audio message:`,
            error
          );
          audioCollectionError = error as Error;
        }
      };

      // Add message listener for this chunk
      currentWs.addEventListener('message', messageHandler);

      try {
        // Send the text chunk
        await this.sendTextChunk(context, text);

        // Wait for and yield audio chunks as they arrive
        logger.debug(
          `[${context.sessionId}] Text chunk sent, collecting audio...`
        );

        let waitingLoops = 0;
        let totalChunksYielded = 0;

        // Continue yielding audio chunks until we get the final message for this chunk
        while (
          !audioCollectionFinished &&
          !audioCollectionError &&
          !abortSignal?.aborted
        ) {
          waitingLoops++;

          // Yield any available audio chunks immediately
          while (audioChunkQueue.length > 0) {
            const chunk = audioChunkQueue.shift()!;
            yield chunk;
            totalChunksYielded++;
            logger.debug(
              `[${context.sessionId}] Yielded chunk ${totalChunksYielded}: ${chunk.length} bytes`
            );
          }

          // Check if WebSocket closed unexpectedly
          if ((currentWs.readyState as number) === WebSocket.CLOSED) {
            logger.warn(
              `[${context.sessionId}] WebSocket closed unexpectedly while waiting for chunk audio`
            );
            break;
          }

          // Wait a bit for more audio chunks
          await new Promise((resolve) => setTimeout(resolve, 10));

          // Timeout after reasonable wait (30 seconds)
          if (waitingLoops > 3000) {
            logger.warn(
              `[${context.sessionId}] Timeout waiting for chunk audio completion`
            );
            break;
          }
        }

        // Yield any remaining audio chunks in the queue
        while (audioChunkQueue.length > 0) {
          const chunk = audioChunkQueue.shift()!;
          yield chunk;
        }

        logger.debug(
          `[${context.sessionId}] Completed text chunk synthesis. Total chunks yielded: ${totalChunksYielded}`
        );

        if (audioCollectionError) {
          throw audioCollectionError;
        }
      } finally {
        // Remove message listener for this chunk
        if (
          currentWs &&
          (currentWs.readyState as number) !== WebSocket.CLOSED
        ) {
          currentWs.removeEventListener('message', messageHandler);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.info(
            `[${context.sessionId}] Minimax Streaming TTS chunk synthesis was cancelled`
          );
          return;
        }
      }
      logger.error(
        `[${context.sessionId}] Minimax Streaming TTS chunk synthesis failed:`,
        error
      );
      throw error;
    }
  }

  private *processAudioChunk(
    context: StreamingContext,
    inputBuffer: Buffer
  ): IterableIterator<Buffer> {
    logger.debug(
      `[${context.sessionId}] Processing audio chunk: ${inputBuffer.length} bytes`
    );

    // Handle carryover from previous chunk if any
    if (context.carryoverBuffer.length > 0) {
      inputBuffer = Buffer.concat([context.carryoverBuffer, inputBuffer]);
      context.carryoverBuffer = Buffer.alloc(0);
      logger.debug(
        `[${context.sessionId}] Merged carryover, new buffer size: ${inputBuffer.length} bytes`
      );
    }

    // Check alignment and handle odd-length chunks
    if (
      inputBuffer.length % MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH !==
      0
    ) {
      logger.debug(
        `[${context.sessionId}] Handling odd-length chunk: ${inputBuffer.length} bytes`
      );

      // Carry over the last byte to maintain alignment
      context.carryoverBuffer = inputBuffer.subarray(inputBuffer.length - 1);
      inputBuffer = inputBuffer.subarray(0, inputBuffer.length - 1);

      logger.debug(
        `[${context.sessionId}] Aligned chunk to ${inputBuffer.length} bytes, carrying over 1 byte`
      );
    }

    // Append incoming buffer to chunk buffer
    context.chunkBuffer = Buffer.concat([context.chunkBuffer, inputBuffer]);

    // Yield consistent-sized chunks while we have enough data
    while (
      context.chunkBuffer.length >=
      MinimaxStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
    ) {
      // Extract exactly OUTPUT_CHUNK_SIZE bytes
      const outputChunk = context.chunkBuffer.subarray(
        0,
        MinimaxStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
      );

      // Ensure chunk is properly aligned for 16-bit PCM samples
      if (
        outputChunk.length %
          MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH !==
        0
      ) {
        logger.warn(
          `[${context.sessionId}] Output chunk alignment issue: ${outputChunk.length} bytes is not divisible by ${MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH}`
        );
        // Hold back the last byte to maintain alignment
        const alignedSize =
          Math.floor(
            outputChunk.length /
              MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH
          ) * MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH;
        const alignedChunk = outputChunk.subarray(0, alignedSize);
        context.chunkBuffer = Buffer.concat([
          outputChunk.subarray(alignedSize),
          context.chunkBuffer.subarray(
            MinimaxStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
          ),
        ]);

        if (alignedChunk.length > 0) {
          logger.debug(
            `[${context.sessionId}] Yielding aligned PCM chunk: ${alignedChunk.length} bytes`
          );
          yield alignedChunk;
        }
      } else {
        // Update buffer to contain only remaining bytes
        context.chunkBuffer = context.chunkBuffer.subarray(
          MinimaxStreamingTextToSpeechService.OUTPUT_CHUNK_SIZE
        );

        logger.debug(
          `[${context.sessionId}] Yielding consistent PCM chunk: ${outputChunk.length} bytes`
        );
        yield outputChunk;
      }
    }
  }

  private *flushRemainingBuffer(
    context: StreamingContext
  ): IterableIterator<Buffer> {
    // Handle any remaining carryover first
    if (context.carryoverBuffer.length > 0) {
      logger.warn(
        `[${context.sessionId}] Discarding ${context.carryoverBuffer.length} byte carryover at end of stream`
      );
      context.carryoverBuffer = Buffer.alloc(0);
    }

    // Flush remaining buffered data
    if (context.chunkBuffer.length === 0) {
      return;
    }

    // Ensure final chunk is properly aligned
    const alignedSize =
      Math.floor(
        context.chunkBuffer.length /
          MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH
      ) * MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH;

    if (alignedSize > 0) {
      const finalChunk = context.chunkBuffer.subarray(0, alignedSize);
      logger.debug(
        `[${context.sessionId}] Flushing final PCM chunk: ${finalChunk.length} bytes`
      );
      yield finalChunk;
    }

    if (context.chunkBuffer.length > alignedSize) {
      logger.warn(
        `[${context.sessionId}] Discarding ${context.chunkBuffer.length - alignedSize} unaligned bytes at end of stream`
      );
    }

    // Clear the buffer
    context.chunkBuffer = Buffer.alloc(0);
  }

  private async closeConnection(context: StreamingContext): Promise<void> {
    if (context.ws && context.ws.readyState === WebSocket.OPEN) {
      try {
        // Give some time for any pending messages to process
        await new Promise((resolve) => setTimeout(resolve, 100));

        context.ws.close();
        logger.info(
          `[${context.sessionId}] Minimax Streaming TTS WebSocket connection closed`
        );
      } catch (error) {
        logger.error(
          `[${context.sessionId}] Error closing Minimax WebSocket connection:`,
          error
        );
      }
    }

    context.ws = null;
    context.isTaskStarted = false;

    // Clean up buffers
    context.chunkBuffer = Buffer.alloc(0);
    context.carryoverBuffer = Buffer.alloc(0);
  }
}

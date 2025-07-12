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

export class MinimaxStreamingTextToSpeechService
  implements IStreamingTextToSpeechService
{
  private ws: WebSocket | null = null;
  private carryoverBuffer: Buffer = Buffer.alloc(0);
  private isTaskStarted: boolean = false;

  // Audio processing constants
  private static readonly SAMPLE_WIDTH = 2; // 2 bytes per 16-bit PCM sample
  private static readonly WS_URL = 'wss://api.minimax.io/ws/v1/t2a_v2';

  private readonly defaultVoiceSettings: MinimaxVoiceSettings = {
    voice_id:
      ttsConfigs.minimax?.voiceId ||
      'moss_audio_73457c58-5ee8-11f0-ba28-7e51ceb5ef24',
    speed: 1,
    vol: 2,
    pitch: 0,
    emotion: 'happy',
  };

  private readonly defaultAudioSettings: MinimaxAudioSettings = {
    sample_rate: 16000, // Client expects 16kHz (matching VAD and audio player)
    bitrate: 128000,
    format: 'pcm',
    channel: 1,
  };

  private async initializeWebSocketConnection(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this.ws;
    }

    const config = ttsConfigs.minimax as TextToSpeechConfig;
    if (!config || !config.apiKey) {
      throw new Error('Minimax API key is not configured for streaming TTS.');
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(MinimaxStreamingTextToSpeechService.WS_URL, {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
        });

        const connectionTimeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
        }, 10000);

        this.ws.onopen = () => {
          logger.debug('Minimax WebSocket connection opened');
        };

        this.ws.onmessage = (event) => {
          try {
            const response = JSON.parse(event.data);
            if (response.event === 'connected_success') {
              clearTimeout(connectionTimeout);
              logger.info(
                'Minimax Streaming TTS WebSocket connection established'
              );
              resolve(this.ws!);
            }
          } catch (error) {
            logger.error(
              'Failed to parse WebSocket connection response:',
              error
            );
            reject(error);
          }
        };

        this.ws.onerror = (error) => {
          clearTimeout(connectionTimeout);
          logger.error('Minimax WebSocket connection error:', error);
          reject(new Error('WebSocket connection failed'));
        };

        this.ws.onclose = (event) => {
          logger.debug(
            `Minimax WebSocket connection closed: ${event.code} ${event.reason}`
          );
          this.ws = null;
          this.isTaskStarted = false;
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private async startTask(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection not established');
    }

    if (this.isTaskStarted) {
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
      if (!this.ws) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      // Store reference to current WebSocket to avoid null access issues
      const currentWs = this.ws;
      let isResolved = false;

      const messageHandler = (event: MessageEvent) => {
        try {
          const response = JSON.parse(event.data);
          if (response.event === 'task_started') {
            currentWs.removeEventListener('message', messageHandler);
            this.isTaskStarted = true;
            logger.debug('Minimax TTS task started successfully');
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
      currentWs.send(JSON.stringify(startMessage));

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
    try {
      // Check if operation was cancelled before starting
      if (abortSignal?.aborted) {
        logger.info(
          'Minimax Streaming TTS operation was cancelled before starting'
        );
        return;
      }

      // Reset buffers for new synthesis session
      this.carryoverBuffer = Buffer.alloc(0);
      this.isTaskStarted = false;

      // Initialize WebSocket connection
      await this.initializeWebSocketConnection();

      // Start the task first
      await this.startTask();

      // Set up audio chunk collection
      const audioChunkQueue: Buffer[] = [];
      let audioCollectionFinished = false;
      let audioCollectionError: Error | null = null;

      // Store reference to current WebSocket to avoid null access issues
      const currentWs = this.ws;
      if (!currentWs) {
        throw new Error('WebSocket not available');
      }

      // Track audio statistics
      let audioMessageCount = 0;
      let totalAudioBytesReceived = 0;

      // Set up message handler for audio chunks
      const messageHandler = (event: MessageEvent) => {
        try {
          if (abortSignal?.aborted) {
            return;
          }

          const response: MinimaxTaskResponse = JSON.parse(event.data);

          // Log all messages for debugging
          logger.debug(
            `Minimax message: ${response.event}${response.is_final ? ' (final)' : ''}`
          );

          if (response.data?.audio) {
            audioMessageCount++;
            const hexAudio = response.data.audio;
            const audioBuffer = this.hexToBuffer(hexAudio);
            totalAudioBytesReceived += audioBuffer.length;

            logger.debug(
              `Audio message #${audioMessageCount}: ${audioBuffer.length} bytes (hex: ${hexAudio.length} chars, total received: ${totalAudioBytesReceived} bytes)`
            );

            // Process the audio chunk and add to queue
            let chunksProduced = 0;
            for (const chunk of this.processAudioChunk(audioBuffer)) {
              audioChunkQueue.push(chunk);
              chunksProduced++;
            }

            logger.debug(
              `Produced ${chunksProduced} chunks, queue size: ${audioChunkQueue.length}`
            );
          }

          // Check for errors
          if (response.event === 'error') {
            logger.error(`Minimax error: ${JSON.stringify(response)}`);
            audioCollectionError = new Error(
              `Minimax error: ${JSON.stringify(response)}`
            );
          }

          if (response.is_final) {
            logger.info(
              `Minimax final message received. Total audio messages: ${audioMessageCount}, bytes: ${totalAudioBytesReceived}`
            );
            audioCollectionFinished = true;
          }
        } catch (error) {
          logger.error('Error processing audio message:', error);
          audioCollectionError = error as Error;
        }
      };

      // Add message listener
      currentWs.addEventListener('message', messageHandler);

      try {
        // Accumulate all text chunks first (like Python example)
        const allText: string[] = [];

        for await (const textChunk of textChunks) {
          if (abortSignal?.aborted) {
            logger.info(
              'Minimax Streaming TTS operation was cancelled during text collection'
            );
            break;
          }

          if (textChunk.trim() && !textChunk.startsWith('[')) {
            allText.push(textChunk);
          }
        }

        // Send all text as one chunk
        if (allText.length > 0) {
          const fullText = allText.join(' ').trim();
          logger.info(
            `Sending full text to Minimax TTS: ${fullText.length} characters`
          );
          await this.sendTextChunk(fullText);
        }

        // Now wait for and yield audio chunks as they arrive
        logger.debug('Text sent, starting audio collection...');

        // Give Minimax a moment to start generating audio
        await new Promise((resolve) => setTimeout(resolve, 100));

        let waitingLoops = 0;
        let totalChunksYielded = 0;

        // Continue yielding audio chunks until we get the final message
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
              `Yielded chunk ${totalChunksYielded}: ${chunk.length} bytes`
            );
          }

          // Check if WebSocket closed unexpectedly
          if (currentWs.readyState === WebSocket.CLOSED) {
            logger.warn(
              'WebSocket closed unexpectedly while waiting for audio'
            );
            break;
          }

          // Wait a bit for more audio chunks
          await new Promise((resolve) => setTimeout(resolve, 10));

          // Log progress every 100 loops (1 second)
          if (waitingLoops % 100 === 0) {
            logger.debug(
              `Still waiting for audio... (${waitingLoops / 100}s elapsed, ${totalChunksYielded} chunks yielded)`
            );
          }
        }

        logger.info(
          `Audio collection finished. Total chunks yielded: ${totalChunksYielded}`
        );

        // Yield any remaining audio chunks in the queue
        let finalChunks = 0;
        while (audioChunkQueue.length > 0) {
          const chunk = audioChunkQueue.shift()!;
          yield chunk;
          finalChunks++;
        }

        if (finalChunks > 0) {
          logger.debug(`Yielded ${finalChunks} final chunks from queue`);
        }

        // Send task_finish after audio collection is complete
        await this.finishTask();

        // Handle any remaining carryover
        yield* this.flushRemainingBuffer();

        if (audioCollectionError) {
          throw audioCollectionError;
        }
      } finally {
        // Remove message listener
        if (currentWs && currentWs.readyState !== WebSocket.CLOSED) {
          currentWs.removeEventListener('message', messageHandler);
        }
      }

      // Clean up buffers
      this.carryoverBuffer = Buffer.alloc(0);
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.info('Minimax Streaming TTS operation was cancelled');
          return;
        }
        if (
          error.message.includes('Minimax API key') ||
          error.message.includes('WebSocket')
        ) {
          logger.error(error.message);
          return;
        }
      }
      logger.error('Minimax Streaming TTS failed:', error);
      throw error;
    } finally {
      await this.closeConnection();
    }
  }

  private async sendTextChunk(text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('WebSocket connection not available for sending text chunk');
      return; // Don't throw, just skip this chunk
    }

    const continueMessage = {
      event: 'task_continue',
      text: text.replace(/\s+/g, ' ').trim(),
    };

    logger.debug(`Minimax Streaming TTS sending text chunk:`, continueMessage);

    try {
      this.ws.send(JSON.stringify(continueMessage));
    } catch (error) {
      logger.error('Failed to send text chunk:', error);
      // Don't throw, just log the error to prevent breaking the stream
    }
  }

  private async finishTask(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('WebSocket connection not available for finishing task');
      return; // Don't throw, just skip finishing
    }

    const finishMessage = {
      event: 'task_finish',
    };

    logger.debug('Minimax Streaming TTS sending task_finish');

    try {
      this.ws.send(JSON.stringify(finishMessage));
    } catch (error) {
      logger.error('Failed to send task_finish message:', error);
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

  private *processAudioChunk(inputBuffer: Buffer): IterableIterator<Buffer> {
    // Minimal buffering to reduce chunk boundaries and noise
    // This helps prevent clicks/pops from too many small chunks

    logger.debug(`Processing audio chunk: ${inputBuffer.length} bytes`);

    // Handle any carryover from previous chunk for alignment
    if (this.carryoverBuffer.length > 0) {
      inputBuffer = Buffer.concat([this.carryoverBuffer, inputBuffer]);
      this.carryoverBuffer = Buffer.alloc(0);
      logger.debug(`Merged carryover, new size: ${inputBuffer.length} bytes`);
    }

    // Define minimum chunk size to reduce audio artifacts
    // 4KB provides ~125ms at 16kHz which balances latency vs quality
    const MIN_CHUNK_SIZE = 4096;

    // If we have less than minimum, save it for next time
    if (inputBuffer.length < MIN_CHUNK_SIZE) {
      this.carryoverBuffer = inputBuffer;
      logger.debug(
        `Buffering ${inputBuffer.length} bytes (below minimum ${MIN_CHUNK_SIZE})`
      );
      return; // Don't yield yet
    }

    // Process chunks of at least MIN_CHUNK_SIZE
    while (inputBuffer.length >= MIN_CHUNK_SIZE) {
      // Take a chunk (up to 16KB for consistent sizing)
      const chunkSize = Math.min(inputBuffer.length, 16384);

      // Ensure alignment for 16-bit samples
      const alignedChunkSize =
        Math.floor(
          chunkSize / MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH
        ) * MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH;

      const chunk = inputBuffer.subarray(0, alignedChunkSize);
      inputBuffer = inputBuffer.subarray(alignedChunkSize);

      logger.debug(`Yielding audio chunk: ${chunk.length} bytes`);
      yield chunk;
    }

    // Save any remaining data for next time
    if (inputBuffer.length > 0) {
      this.carryoverBuffer = inputBuffer;
      logger.debug(`Saving ${inputBuffer.length} bytes for next chunk`);
    }
  }

  private *flushRemainingBuffer(): IterableIterator<Buffer> {
    // Flush any remaining buffered data at the end of the stream
    if (this.carryoverBuffer.length > 0) {
      // Ensure alignment for final chunk
      const alignedLength =
        Math.floor(
          this.carryoverBuffer.length /
            MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH
        ) * MinimaxStreamingTextToSpeechService.SAMPLE_WIDTH;

      if (alignedLength > 0) {
        const finalChunk = this.carryoverBuffer.subarray(0, alignedLength);
        logger.debug(`Flushing final audio chunk: ${finalChunk.length} bytes`);
        yield finalChunk;
      }

      if (this.carryoverBuffer.length > alignedLength) {
        logger.warn(
          `Discarding ${this.carryoverBuffer.length - alignedLength} unaligned bytes at end of stream`
        );
      }

      this.carryoverBuffer = Buffer.alloc(0);
    }
  }

  private async closeConnection(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        // Give some time for any pending messages to process
        await new Promise((resolve) => setTimeout(resolve, 100));

        this.ws.close();
        logger.info('Minimax Streaming TTS WebSocket connection closed');
      } catch (error) {
        logger.error('Error closing Minimax WebSocket connection:', error);
      }
    }

    this.ws = null;
    this.isTaskStarted = false;
  }
}

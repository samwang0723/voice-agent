import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { ttsConfigs } from '../../config';
import type { IStreamingTextToSpeechService } from '../../domain/audio/audio.service';
import type { TextToSpeechConfig } from '../../config';
import logger from '../logger';

// Connection context for each streaming request
interface StreamingContext {
  speechConfig: sdk.SpeechConfig | null;
  sessionId: string;
}

export class AzureStreamingTextToSpeechService
  implements IStreamingTextToSpeechService
{
  private createStreamingContext(): StreamingContext {
    return {
      speechConfig: null,
      sessionId: Math.random().toString(36).substring(2, 15),
    };
  }

  private initializeSpeechConfig(context: StreamingContext): sdk.SpeechConfig {
    if (context.speechConfig) {
      return context.speechConfig;
    }

    const config = ttsConfigs.azure as TextToSpeechConfig;
    if (!config || !config.apiKey) {
      throw new Error(
        'Azure Speech API key is not configured for streaming TTS.'
      );
    }

    const region = process.env.AZURE_SPEECH_REGION;
    if (!region) {
      throw new Error(
        'Azure Speech region is not configured for streaming TTS.'
      );
    }

    // Use standard Speech SDK configuration for better compatibility
    context.speechConfig = sdk.SpeechConfig.fromSubscription(
      config.apiKey,
      region
    );

    // Set the voice name
    context.speechConfig.speechSynthesisVoiceName =
      config.voiceId || 'en-GB-OllieMultilingualNeural';

    // Set output format to high-quality PCM for streaming
    context.speechConfig.speechSynthesisOutputFormat =
      sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm;

    logger.info(
      `[${context.sessionId}] Azure Streaming TTS configuration initialized`
    );
    return context.speechConfig;
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
          `[${context.sessionId}] Azure Streaming TTS operation was cancelled before starting`
        );
        return;
      }

      logger.info(
        `[${context.sessionId}] Starting new Azure streaming session`
      );

      // Accumulate text chunks for synthesis
      let accumulatedText = '';
      const textBuffer: string[] = [];
      let isFirstChunk = true;

      // Collect text chunks
      for await (const textChunk of textChunks) {
        if (abortSignal?.aborted) {
          logger.info(
            `[${context.sessionId}] Azure Streaming TTS operation was cancelled during text collection`
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
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          logger.info(
            `[${context.sessionId}] Azure Streaming TTS operation was cancelled`
          );
          return;
        }
        if (
          error.message.includes('Azure Speech API key') ||
          error.message.includes('Azure Speech region')
        ) {
          logger.error(`[${context.sessionId}] ${error.message}`);
          return;
        }
      }
      logger.error(`[${context.sessionId}] Azure Streaming TTS failed:`, error);
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
      const speechConfig = this.initializeSpeechConfig(context);
      logger.debug(
        `[${context.sessionId}] Azure Streaming TTS starting synthesis for text: "${text.substring(0, 50)}..."`
      );

      // Use a simple approach: synthesize to audio data and yield it in chunks
      // This is more reliable than trying to stream from Azure Speech SDK pull streams
      const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

      const result = await new Promise<sdk.SpeechSynthesisResult>(
        (resolve, reject) => {
          if (abortSignal?.aborted) {
            reject(new Error('AbortError'));
            return;
          }

          logger.debug(
            `[${context.sessionId}] Azure Streaming TTS calling speakTextAsync...`
          );
          synthesizer.speakTextAsync(
            text.replace(/\s+/g, ' ').trim(),
            (result) => {
              logger.debug(
                `[${context.sessionId}] Azure Streaming TTS synthesis callback - reason: ${result.reason}, audioData length: ${result.audioData ? result.audioData.byteLength : 'null'}`
              );
              synthesizer.close();
              resolve(result);
            },
            (error) => {
              logger.error(
                `[${context.sessionId}] Azure Streaming TTS synthesis error callback: ${error}`
              );
              synthesizer.close();

              if (abortSignal?.aborted) {
                reject(new Error('AbortError'));
                return;
              }

              reject(
                new Error(`Azure Streaming TTS synthesis failed: ${error}`)
              );
            }
          );
        }
      );

      if (abortSignal?.aborted) {
        logger.info(
          `[${context.sessionId}] Azure Streaming TTS chunk synthesis was cancelled`
        );
        return;
      }

      logger.debug(
        `[${context.sessionId}] Azure Streaming TTS synthesis result reason: ${result.reason}`
      );

      if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
        const audioData = result.audioData;
        logger.debug(
          `[${context.sessionId}] Azure Streaming TTS audioData: ${audioData ? `${audioData.byteLength} bytes` : 'null'}`
        );

        if (audioData && audioData.byteLength > 0) {
          // Split the audio data into chunks for streaming effect
          const buffer = Buffer.from(audioData);
          const chunkSize = 16000; // 16KB chunks (approximately 80ms of 16kHz mono PCM audio)

          logger.info(
            `[${context.sessionId}] Azure Streaming TTS synthesis completed for text: "${text.substring(0, 50)}..." - ${buffer.length} bytes total`
          );

          // Yield the audio in chunks to simulate streaming
          for (let i = 0; i < buffer.length; i += chunkSize) {
            if (abortSignal?.aborted) {
              logger.info(
                `[${context.sessionId}] Azure Streaming TTS chunk synthesis was cancelled during chunking`
              );
              return;
            }

            const chunk = buffer.slice(i, i + chunkSize);
            logger.debug(
              `[${context.sessionId}] Azure Streaming TTS received audio chunk: ${chunk.length} bytes`
            );
            yield chunk;
          }

          logger.debug(
            `[${context.sessionId}] Azure Streaming TTS completed yielding all chunks for text`
          );
        } else {
          logger.warn(
            `[${context.sessionId}] Azure Streaming TTS synthesis completed but no audio data received for text: "${text.substring(0, 50)}..."`
          );
        }
      } else if (result.reason === sdk.ResultReason.Canceled) {
        const cancellation = sdk.CancellationDetails.fromResult(result);
        logger.error(
          `[${context.sessionId}] Azure Streaming TTS synthesis canceled: ${cancellation.errorDetails}`
        );
        throw new Error(
          `Azure Streaming TTS synthesis canceled: ${cancellation.errorDetails}`
        );
      } else {
        logger.error(
          `[${context.sessionId}] Azure Streaming TTS synthesis failed with reason: ${result.reason}`
        );
        throw new Error(
          `Azure Streaming TTS synthesis failed with reason: ${result.reason}`
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'AbortError' || error.name === 'AbortError') {
          logger.info(
            `[${context.sessionId}] Azure Streaming TTS chunk synthesis was cancelled`
          );
          return;
        }
      }
      logger.error(
        `[${context.sessionId}] Azure Streaming TTS chunk synthesis failed:`,
        error
      );
      throw error;
    }
  }
}

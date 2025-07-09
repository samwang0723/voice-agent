import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { transcriptionConfigs, ttsConfigs } from '../../config';
import type {
  ITranscriptionService,
  ITextToSpeechService,
} from '../../domain/audio/audio.service';
import type { TextToSpeechConfig } from '../../config';
import logger from '../logger';

/**
 * Azure Speech Services transcription implementation.
 * 
 * Uses single-shot recognition by default, which is optimal for voice agent scenarios
 * where VAD (Voice Activity Detection) provides complete audio chunks. This approach:
 * - Eliminates the "stuck" behavior with longer phrases
 * - Provides faster response times (no 30-second timeout)
 * - Is more reliable for discrete voice commands
 * - Matches the pattern used by other transcription services (Groq, Deepgram)
 */
export class AzureTranscriptionService implements ITranscriptionService {
  private speechConfig: sdk.SpeechConfig | null = null;

  private initializeSpeechConfig(): sdk.SpeechConfig {
    if (this.speechConfig) {
      return this.speechConfig;
    }

    const config = transcriptionConfigs.azure;
    if (!config || !config.apiKey) {
      throw new Error('Azure Speech API key is not configured for transcription.');
    }

    const region = process.env.AZURE_SPEECH_REGION;
    if (!region) {
      throw new Error('Azure Speech region is not configured.');
    }

    this.speechConfig = sdk.SpeechConfig.fromSubscription(config.apiKey, region);
    this.speechConfig.speechRecognitionLanguage = config.language || 'en-US';
    
    // Set recognition mode for better performance
    this.speechConfig.setProperty(
      sdk.PropertyId.SpeechServiceConnection_RecoMode,
      'Interactive'
    );

    logger.info('Azure Speech configuration initialized and cached');
    return this.speechConfig;
  }

  async transcribe(audio: Buffer): Promise<string> {
    // Use single-shot recognition for voice agent scenarios where we have complete audio chunks
    // This is much faster and more reliable than continuous recognition for discrete commands
    return this.transcribeOneShot(audio);
  }

  // Continuous recognition method for scenarios requiring real-time streaming transcription
  async transcribeContinuous(audio: Buffer): Promise<string> {
    try {
      // Get or initialize cached speech config
      const speechConfig = this.initializeSpeechConfig();

      // Create audio config from buffer
      const audioConfig = this.createAudioConfigFromBuffer(audio);

      // Create the speech recognizer (we create new instance for each transcription
      // as each transcription has different audio config)
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      return new Promise((resolve, reject) => {
        let transcription = '';

        // Handle recognition events
        recognizer.recognizing = (sender, e) => {
          logger.debug(`Azure Speech recognizing: ${e.result.text}`);
        };

        recognizer.recognized = (sender, e) => {
          if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
            transcription += e.result.text + ' ';
            logger.debug(`Azure Speech recognized: ${e.result.text}`);
          } else if (e.result.reason === sdk.ResultReason.NoMatch) {
            logger.debug('Azure Speech: No speech could be recognized');
          }
        };

        recognizer.canceled = (sender, e) => {
          logger.debug(`Azure Speech recognition canceled: ${e.reason}`);
          recognizer.close();
          if (e.reason === sdk.CancellationReason.Error) {
            reject(new Error(`Azure Speech recognition error: ${e}`));
          } else {
            resolve(transcription.trim() || '[No transcription available]');
          }
        };

        recognizer.sessionStopped = (sender, e) => {
          logger.debug('Azure Speech session stopped');
          recognizer.close();
          resolve(transcription.trim() || '[No transcription available]');
        };

        // Start continuous recognition
        recognizer.startContinuousRecognitionAsync(
          () => {
            logger.debug('Azure Speech recognition started');
          },
          (error) => {
            logger.error('Azure Speech recognition failed to start:', error);
            recognizer.close();
            reject(new Error(`Failed to start Azure Speech recognition: ${error}`));
          }
        );

        // Stop recognition after a reasonable timeout (30 seconds)
        setTimeout(() => {
          recognizer.stopContinuousRecognitionAsync(
            () => {
              logger.debug('Azure Speech recognition stopped');
            },
            (error) => {
              logger.error('Error stopping Azure Speech recognition:', error);
            }
          );
        }, 30000);
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('Azure Speech API key') || error.message.includes('Azure Speech region')) {
          logger.error(error.message);
          return `[Error: ${error.message}]`;
        }
      }
      logger.error('Azure Speech transcription failed:', error);
      return '[Transcription failed]';
    }
  }

  private createAudioConfigFromBuffer(audioBuffer: Buffer): sdk.AudioConfig {
    try {
      // Azure Speech SDK expects specific audio format
      // For best results, audio should be:
      // - 16 kHz sample rate
      // - 16-bit samples
      // - Single channel (mono)
      // - WAV format with proper headers

      // Create a push audio input stream
      const pushStream = sdk.AudioInputStream.createPushStream();
      
      // Write the audio buffer to the stream (convert Buffer to ArrayBuffer)
      const arrayBuffer = new ArrayBuffer(audioBuffer.length);
      const uint8Array = new Uint8Array(arrayBuffer);
      uint8Array.set(audioBuffer);
      pushStream.write(arrayBuffer);
      pushStream.close();

      // Create audio config from the stream
      return sdk.AudioConfig.fromStreamInput(pushStream);
    } catch (error) {
      logger.error('Failed to create Azure audio config from buffer:', error);
      throw error;
    }
  }

  // Single-shot recognition method (optimal for voice agent with VAD)
  async transcribeOneShot(audio: Buffer): Promise<string> {
    try {
      const startTime = Date.now();
      logger.debug(`Azure Speech starting single-shot recognition for ${audio.length} bytes`);

      // Get or initialize cached speech config
      const speechConfig = this.initializeSpeechConfig();

      // Create audio config from buffer
      const audioConfig = this.createAudioConfigFromBuffer(audio);

      // Create the speech recognizer
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      return new Promise((resolve, reject) => {
        recognizer.recognizeOnceAsync(
          (result) => {
            const duration = Date.now() - startTime;
            recognizer.close();
            
            if (result.reason === sdk.ResultReason.RecognizedSpeech) {
              logger.debug(`Azure Speech recognition completed in ${duration}ms: "${result.text}"`);
              resolve(result.text || '[No transcription available]');
            } else if (result.reason === sdk.ResultReason.NoMatch) {
              logger.debug(`Azure Speech no match found in ${duration}ms`);
              resolve('[No speech could be recognized]');
            } else if (result.reason === sdk.ResultReason.Canceled) {
              const cancellation = sdk.CancellationDetails.fromResult(result);
              logger.warn(`Azure Speech recognition canceled in ${duration}ms: ${cancellation.errorDetails}`);
              
              // Don't treat certain cancellation reasons as errors
              if (cancellation.reason === sdk.CancellationReason.EndOfStream) {
                resolve('[No transcription available]');
              } else {
                reject(new Error(`Azure Speech recognition canceled: ${cancellation.errorDetails}`));
              }
            } else {
              logger.debug(`Azure Speech recognition finished with reason ${result.reason} in ${duration}ms`);
              resolve('[No transcription available]');
            }
          },
          (error) => {
            const duration = Date.now() - startTime;
            recognizer.close();
            logger.error(`Azure Speech one-shot recognition failed after ${duration}ms:`, error);
            reject(new Error(`Azure Speech one-shot recognition failed: ${error}`));
          }
        );
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('Azure Speech API key') || error.message.includes('Azure Speech region')) {
          logger.error(error.message);
          return `[Error: ${error.message}]`;
        }
      }
      logger.error('Azure Speech one-shot transcription failed:', error);
      return '[Transcription failed]';
    } 
  }
}

export class AzureTextToSpeechService implements ITextToSpeechService {
  private speechConfig: sdk.SpeechConfig | null = null;
  private speechSynthesizer: sdk.SpeechSynthesizer | null = null;

  private initializeSpeechConfig(): sdk.SpeechConfig {
    if (this.speechConfig) {
      return this.speechConfig;
    }

    const config = ttsConfigs.azure as TextToSpeechConfig;
    if (!config || !config.apiKey) {
      throw new Error('Azure Speech API key is not configured for TTS.');
    }

    const region = process.env.AZURE_SPEECH_REGION;
    if (!region) {
      throw new Error('Azure Speech region is not configured for TTS.');
    }

    this.speechConfig = sdk.SpeechConfig.fromSubscription(config.apiKey, region);
    
    // Set the voice name - using en-GB-OllieMultilingualNeural
    this.speechConfig.speechSynthesisVoiceName = config.voiceId || 'en-GB-OllieMultilingualNeural';
    
    // Set output format to high-quality MP3
    this.speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;

    logger.info('Azure TTS configuration initialized and cached');
    return this.speechConfig;
  }

  private getSpeechSynthesizer(): sdk.SpeechSynthesizer {
    if (!this.speechSynthesizer) {
      const speechConfig = this.initializeSpeechConfig();
      this.speechSynthesizer = new sdk.SpeechSynthesizer(speechConfig);
      logger.info('Azure SpeechSynthesizer instance created and cached');
    }
    return this.speechSynthesizer;
  }

  private cleanup(): void {
    if (this.speechSynthesizer) {
      this.speechSynthesizer.close();
      this.speechSynthesizer = null;
    }
    // Note: We keep speechConfig as it's reusable and lightweight
  }

  async synthesize(
    text: string,
    abortSignal?: AbortSignal
  ): Promise<Buffer | null> {
    if (text.startsWith('[') && text.endsWith(']')) {
      logger.info(`Skipping TTS for special message: ${text}`);
      return null;
    }

    try {
      // Check if operation was cancelled before starting
      if (abortSignal?.aborted) {
        logger.info('Azure TTS operation was cancelled before starting');
        return null;
      }

      // Get or initialize cached speech synthesizer
      const synthesizer = this.getSpeechSynthesizer();

      return new Promise((resolve, reject) => {
        // Handle cancellation during synthesis
        const checkCancellation = () => {
          if (abortSignal?.aborted) {
            // Note: We don't close the synthesizer here as it's cached for reuse
            logger.info('Azure TTS operation was cancelled during synthesis');
            resolve(null);
            return true;
          }
          return false;
        };

        synthesizer.speakTextAsync(
          text,
          (result) => {
            // Note: We don't close the synthesizer here as it's cached for reuse

            // Check for cancellation after synthesis
            if (checkCancellation()) return;

            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
              // Convert ArrayBuffer to Buffer
              const audioData = result.audioData;
              if (audioData) {
                const buffer = Buffer.from(audioData);
                logger.debug(`Azure TTS synthesis completed, audio length: ${buffer.length} bytes`);
                resolve(buffer);
              } else {
                logger.warn('Azure TTS synthesis completed but no audio data received');
                resolve(null);
              }
            } else if (result.reason === sdk.ResultReason.Canceled) {
              const cancellation = sdk.CancellationDetails.fromResult(result);
              logger.error(`Azure TTS synthesis canceled: ${cancellation.errorDetails}`);
              if (cancellation.reason === sdk.CancellationReason.Error) {
                reject(new Error(`Azure TTS synthesis error: ${cancellation.errorDetails}`));
              } else {
                resolve(null);
              }
            } else {
              logger.warn(`Azure TTS synthesis failed with reason: ${result.reason}`);
              resolve(null);
            }
          },
          (error) => {
            // Note: We don't close the synthesizer here as it's cached for reuse
            
            // Handle AbortError specifically
            if (error && typeof error === 'object' && (error as any).name === 'AbortError') {
              logger.info('Azure TTS operation was aborted');
              resolve(null);
              return;
            }
            
            logger.error('Azure TTS synthesis failed:', error);
            reject(new Error(`Azure TTS synthesis failed: ${error}`));
          }
        );
      });
    } catch (error) {
      if (error instanceof Error) {
        // Handle AbortError specifically
        if (error.name === 'AbortError') {
          logger.info('Azure TTS operation was cancelled');
          return null;
        }
        // Handle configuration errors
        if (error.message.includes('Azure Speech API key') || error.message.includes('Azure Speech region')) {
          logger.error(error.message);
          return null;
        }
      }
      logger.error('Azure TTS failed:', error);
      return null;
    } 
  }
} 
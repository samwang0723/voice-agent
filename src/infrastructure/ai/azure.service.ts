import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { transcriptionConfigs } from '../../config';
import type { ITranscriptionService } from '../../domain/audio/audio.service';
import logger from '../logger';

export class AzureTranscriptionService implements ITranscriptionService {
  async transcribe(audio: Buffer): Promise<string> {
    const config = transcriptionConfigs.azure;
    if (!config || !config.apiKey) {
      logger.error('Azure Speech API key is not configured for transcription.');
      return '[Error: Azure Speech API key not configured]';
    }

    // Azure Speech SDK requires a region in addition to API key
    const region = process.env.AZURE_SPEECH_REGION;
    if (!region) {
      logger.error('Azure Speech region is not configured.');
      return '[Error: Azure Speech region not configured]';
    }

    try {
      // Create speech config
      const speechConfig = sdk.SpeechConfig.fromSubscription(config.apiKey, region);
      speechConfig.speechRecognitionLanguage = config.language || 'en-US';
      
      // Set recognition mode for better performance
      speechConfig.setProperty(
        sdk.PropertyId.SpeechServiceConnection_RecoMode,
        'Interactive'
      );

      // Create audio config from buffer
      // Azure SDK expects audio in specific format - convert buffer to proper format
      const audioConfig = this.createAudioConfigFromBuffer(audio);

      // Create the speech recognizer
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

  // Alternative method for single-shot recognition (faster for short audio)
  async transcribeOneShot(audio: Buffer): Promise<string> {
    const config = transcriptionConfigs.azure;
    if (!config || !config.apiKey) {
      logger.error('Azure Speech API key is not configured for transcription.');
      return '[Error: Azure Speech API key not configured]';
    }

    const region = process.env.AZURE_SPEECH_REGION;
    if (!region) {
      logger.error('Azure Speech region is not configured.');
      return '[Error: Azure Speech region not configured]';
    }

    try {
      // Create speech config
      const speechConfig = sdk.SpeechConfig.fromSubscription(config.apiKey, region);
      speechConfig.speechRecognitionLanguage = config.language || 'en-US';

      // Create audio config from buffer
      const audioConfig = this.createAudioConfigFromBuffer(audio);

      // Create the speech recognizer
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

      return new Promise((resolve, reject) => {
        recognizer.recognizeOnceAsync(
          (result) => {
            recognizer.close();
            
            if (result.reason === sdk.ResultReason.RecognizedSpeech) {
              resolve(result.text || '[No transcription available]');
            } else if (result.reason === sdk.ResultReason.NoMatch) {
              resolve('[No speech could be recognized]');
            } else if (result.reason === sdk.ResultReason.Canceled) {
              const cancellation = sdk.CancellationDetails.fromResult(result);
              logger.error(`Azure Speech recognition canceled: ${cancellation.errorDetails}`);
              reject(new Error(`Azure Speech recognition canceled: ${cancellation.errorDetails}`));
            } else {
              resolve('[No transcription available]');
            }
          },
          (error) => {
            recognizer.close();
            logger.error('Azure Speech one-shot recognition failed:', error);
            reject(new Error(`Azure Speech one-shot recognition failed: ${error}`));
          }
        );
      });
    } catch (error) {
      logger.error('Azure Speech one-shot transcription failed:', error);
      return '[Transcription failed]';
    }
  }
} 
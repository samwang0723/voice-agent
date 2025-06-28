import { RealTimeVAD } from '@ericedouard/vad-node-realtime';
import Groq from 'groq-sdk';

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || '', // You'll need to set this environment variable
});

// Worker message types
interface AudioProcessMessage {
  type: 'process-audio';
  id: string;
  audioData: Float32Array;
}

interface TranscribeMessage {
  type: 'transcribe';
  id: string;
  audioData: Float32Array;
}

interface InitMessage {
  type: 'init';
  sampleRate: number;
}

type WorkerMessage = AudioProcessMessage | TranscribeMessage | InitMessage;

interface SpeechEndResponse {
  type: 'speech-end';
  id: string;
  transcript: string;
}

interface InitResponse {
  type: 'init-complete';
  success: boolean;
  error?: string;
}

interface ErrorResponse {
  type: 'error';
  id: string;
  error: string;
}

type WorkerResponse = SpeechEndResponse | InitResponse | ErrorResponse;

// Global VAD instance
let vad: RealTimeVAD | null = null;

// Fallback speech detection
let audioBuffer: Float32Array[] = [];
let lastSpeechTime = 0;
let speechDetectionTimer: any = null;
const SPEECH_TIMEOUT = 3000; // 3 seconds of silence triggers transcription
const MAX_BUFFER_SIZE = 160000; // Max ~10 seconds at 16kHz

// Send message back to main thread
function sendMessage(message: WorkerResponse) {
  // @ts-ignore - Bun worker global
  self.postMessage(message);
}

// Initialize VAD
async function initializeVAD(sampleRate: number): Promise<void> {
  try {
    vad = await RealTimeVAD.new({
      sampleRate,
      // Reduce VAD sensitivity for better speech detection
      positiveSpeechThreshold: 0.6, // Lower threshold (default: 0.8)
      negativeSpeechThreshold: 0.35, // Lower threshold (default: 0.5)
      redemptionFrames: 3, // Fewer frames to wait (default: 8)
      frameSamples: 512, // Smaller frame size for faster detection
      preSpeechPadFrames: 2, // Fewer padding frames
      onSpeechEnd: async (audio: Float32Array) => {
        console.log(
          `🗣️ Speech ended, processing ${audio.length} samples for transcription`
        );
        const transcript = await transcribeWithWhisper(audio);
        console.log(`📝 Transcription result: "${transcript}"`);
        // Send transcription result back to main thread
        sendMessage({
          type: 'speech-end',
          id: 'speech-detection', // We could make this more specific if needed
          transcript,
        });
      },
      onSpeechStart: () => {
        console.log('🎤 Speech started detected by VAD');
      },
    });

    sendMessage({
      type: 'init-complete',
      success: true,
    });
  } catch (error) {
    sendMessage({
      type: 'init-complete',
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// Process audio chunk through VAD
function processAudioChunk(audioData: Float32Array): void {
  if (!vad) {
    throw new Error('VAD not initialized');
  }

  const maxAmplitude = Math.max(...audioData);
  console.log(
    `🔊 Worker processing audio: ${audioData.length} samples, max: ${maxAmplitude}`
  );

  // Run primary VAD
  vad.processAudio(audioData);

  // Fallback speech detection
  const currentTime = Date.now();
  const hasSpeech = maxAmplitude > 0.005; // Adjust threshold as needed

  if (hasSpeech) {
    lastSpeechTime = currentTime;
    audioBuffer.push(new Float32Array(audioData));
    console.log(
      `🎙️ Speech detected (fallback), buffer size: ${audioBuffer.length} chunks`
    );

    // Clear existing timer
    if (speechDetectionTimer) {
      clearTimeout(speechDetectionTimer);
    }

    // Set new timer for speech end detection
    speechDetectionTimer = setTimeout(() => {
      if (audioBuffer.length > 0) {
        console.log(
          `⏰ Speech timeout reached, transcribing ${audioBuffer.length} chunks`
        );
        transcribeBufferedAudio();
      }
    }, SPEECH_TIMEOUT);

    // Prevent buffer from getting too large
    if (audioBuffer.length > MAX_BUFFER_SIZE / 128) {
      console.log(`📦 Buffer full, forcing transcription`);
      transcribeBufferedAudio();
    }
  }
}

// Transcribe buffered audio (fallback method)
async function transcribeBufferedAudio(): Promise<void> {
  if (audioBuffer.length === 0) return;

  // Concatenate all audio chunks
  const totalLength = audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
  const combinedAudio = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of audioBuffer) {
    combinedAudio.set(chunk, offset);
    offset += chunk.length;
  }

  console.log(`🔗 Transcribing ${totalLength} samples from fallback detection`);

  // Clear buffer
  audioBuffer = [];
  if (speechDetectionTimer) {
    clearTimeout(speechDetectionTimer);
    speechDetectionTimer = null;
  }

  // Transcribe
  const transcript = await transcribeWithWhisper(combinedAudio);
  console.log(`📝 Fallback transcription result: "${transcript}"`);

  // Send result
  sendMessage({
    type: 'speech-end',
    id: 'fallback-detection',
    transcript,
  });
}

// Convert Float32Array to WAV buffer
function float32ArrayToWav(
  audioData: Float32Array,
  sampleRate: number = 16000
): Buffer {
  const length = audioData.length;
  const arrayBuffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(arrayBuffer);

  // WAV header
  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, length * 2, true);

  // Convert float32 to int16
  const int16Array = new Int16Array(arrayBuffer, 44);
  for (let i = 0; i < length; i++) {
    int16Array[i] = Math.max(
      -32768,
      Math.min(32767, (audioData[i] ?? 0) * 32767)
    );
  }

  return Buffer.from(arrayBuffer);
}

// Transcribe audio using Groq
async function transcribeWithWhisper(audio: Float32Array): Promise<string> {
  try {
    if (!process.env.GROQ_API_KEY) {
      console.error('GROQ_API_KEY environment variable not set');
      return '[API key not configured]';
    }

    // Convert Float32Array to WAV format
    const wavBuffer = float32ArrayToWav(audio, 16000);

    // Create a Blob that Groq SDK can consume
    const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });

    // Create a File from the Blob with required properties
    const audioFile = new File([audioBlob], 'audio.wav', {
      type: 'audio/wav',
    }) as any; // Type assertion to work around SDK type limitations

    // Create transcription using Groq
    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3-turbo',
      response_format: 'text', // Get plain text response
      language: 'en', // Optional: specify language
      temperature: 0.0, // Lower temperature for more consistent results
    });

    // Handle the response - extract text from Transcription object
    const result = (transcription as any)?.text ?? transcription;
    return result || '[No transcription available]';
  } catch (error) {
    console.error('Groq transcription failed:', error);

    // Provide more specific error messages
    if (error instanceof Error) {
      if (error.message.includes('401')) {
        return '[Authentication failed - check API key]';
      } else if (error.message.includes('429')) {
        return '[Rate limit exceeded - try again later]';
      } else if (error.message.includes('network')) {
        return '[Network error - check connection]';
      }
      return `[Transcription error: ${error.message}]`;
    }

    return '[Transcription failed - unknown error]';
  }
}

// Handle messages from main thread
// @ts-ignore - Bun worker global
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  try {
    switch (message.type) {
      case 'init':
        await initializeVAD(message.sampleRate);
        break;

      case 'process-audio':
        processAudioChunk(message.audioData);
        break;

      case 'transcribe':
        const transcript = await transcribeWithWhisper(message.audioData);
        sendMessage({
          type: 'speech-end',
          id: message.id,
          transcript,
        });
        break;

      default:
        console.warn('Unknown message type:', message);
    }
  } catch (error) {
    sendMessage({
      type: 'error',
      id: 'id' in message ? message.id : 'unknown',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

console.log('Audio worker initialized');

import Groq from 'groq-sdk';

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || '', // You'll need to set this environment variable
});

// Worker message types
interface AudioTranscribeMessage {
  type: 'transcribe-audio';
  id: string;
  audioData: Float32Array;
}

type WorkerMessage = AudioTranscribeMessage;

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

// Send message back to main thread
function sendMessage(message: WorkerResponse) {
  // @ts-ignore - Bun worker global
  self.postMessage(message);
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
      case 'transcribe-audio':
        const transcript = await transcribeWithWhisper(message.audioData);
        sendMessage({
          type: 'speech-end',
          id: message.id,
          transcript,
        });
        break;

      default:
        // This is a type error and should not happen with TypeScript
        console.warn('Unknown message type:', (message as any)?.type);
    }
  } catch (error) {
    sendMessage({
      type: 'error',
      id: 'id' in message ? message.id : 'unknown',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

// Signal that the worker is ready (no async initialization needed anymore)
sendMessage({
  type: 'init-complete',
  success: true,
});

console.log('✅ Audio worker ready for transcription.');

import Groq from 'groq-sdk';
import { generateText } from 'ai';
import { createModelByKey } from './model';
import logger from './logger';

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || '', // You'll need to set this environment variable
});

// Initialize AI model
let aiModel: ReturnType<typeof createModelByKey>;

// Conversation history storage
interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

let conversationHistory: ConversationMessage[] = [];

// --- Configuration ---
interface VoiceEngineConfig {
  sttEngine: 'groq'; // Future: | 'openai' | 'azure' | etc.
  ttsEngine: 'groq'; // Future: | 'elevenlabs' | 'azure' | etc.
}

let config: VoiceEngineConfig = {
  sttEngine: 'groq',
  ttsEngine: 'groq',
};
// --------------------

// Default sample rate, can be updated via 'init' message
let sampleRate = 16000;

// Worker message types
interface InitMessage {
  type: 'init';
  sampleRate: number;
}

interface SetConfigMessage {
  type: 'setConfig';
  config: Partial<VoiceEngineConfig>;
}

interface AudioTranscribeMessage {
  type: 'transcribe-audio';
  sessionId: string;
  audioData: Int16Array;
  context?: {
    datetime: string;
    location?: string;
  };
}

type WorkerMessage = AudioTranscribeMessage | InitMessage | SetConfigMessage;

interface SpeechEndResponse {
  type: 'speech-end';
  sessionId: string;
  transcript: string;
  aiResponse: string;
  speechAudio?: ArrayBuffer; // TTS audio data
}

interface InitResponse {
  type: 'init-complete';
  success: boolean;
  error?: string;
}

interface ErrorResponse {
  type: 'error';
  sessionId: string;
  error: string;
}

type WorkerResponse = SpeechEndResponse | InitResponse | ErrorResponse;

// Send message back to main thread
function sendMessage(message: WorkerResponse) {
  // @ts-ignore - Bun worker global
  self.postMessage(message);
}

// Convert Int16Array to WAV buffer
function int16ArrayToWav(
  audioData: Int16Array,
  targetSampleRate: number = 16000
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
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, length * 2, true);

  // Copy Int16 data directly
  const pcm = new Int16Array(arrayBuffer, 44);
  pcm.set(audioData);

  return Buffer.from(arrayBuffer);
}

// --- Service Abstractions ---
interface TranscriptionService {
  transcribe(audio: Int16Array): Promise<string>;
}

interface TextToSpeechService {
  generateSpeech(text: string): Promise<ArrayBuffer | null>;
}

/*
 * How to add new engines in the future:
 *
 * 1. Update VoiceEngineConfig interface to include new engine types
 * 2. Add new implementation functions (e.g., transcribeWithOpenAI, generateSpeechWithElevenLabs)
 * 3. Update the service factory switch statements to handle new engines
 * 4. Update server validation in src/index.ts to accept new engine names
 * 5. Optionally add UI controls in the frontend
 *
 * Example:
 * - Add 'openai' to sttEngine type
 * - Implement async function transcribeWithOpenAI(audio: Float32Array): Promise<string>
 * - Add case 'openai': return { transcribe: transcribeWithOpenAI }; to getTranscriptionService()
 */
// -------------------------

// --- Groq Implementations ---

// Transcribe audio using Groq
async function transcribeWithGroq(audio: Int16Array): Promise<string> {
  try {
    if (!process.env.GROQ_API_KEY) {
      logger.error('GROQ_API_KEY environment variable not set');
      return '[API key not configured]';
    }

    // Convert Int16Array to WAV format
    const wavBuffer = int16ArrayToWav(audio, sampleRate);

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
    logger.error('Groq transcription failed:', error);

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

// Generate speech from text using Groq TTS
async function generateSpeechWithGroq(
  text: string
): Promise<ArrayBuffer | null> {
  try {
    if (!process.env.GROQ_API_KEY) {
      logger.error('GROQ_API_KEY environment variable not set for TTS');
      return null;
    }

    // Skip TTS for error messages (those wrapped in brackets)
    if (text.startsWith('[') && text.endsWith(']')) {
      logger.info(`Skipping TTS for error message: ${text}`);
      return null;
    }

    // Limit text length for TTS (Groq has 10K character limit)
    const truncatedText =
      text.length > 1000 ? text.substring(0, 1000) + '...' : text;

    logger.info(`🎵 Generating speech for: "${truncatedText}"`);

    // Create speech using Groq TTS
    const response = await groq.audio.speech.create({
      model: 'playai-tts',
      voice: 'Cheyenne-PlayAI', // Using a pleasant female voice
      input: truncatedText,
      response_format: 'wav',
    });

    // Convert response to ArrayBuffer
    const audioBuffer = await response.arrayBuffer();
    logger.info(`🎵 Generated speech audio: ${audioBuffer.byteLength} bytes`);

    return audioBuffer;
  } catch (error) {
    logger.error('TTS generation failed:', error);

    if (error instanceof Error) {
      if (error.message.includes('401')) {
        logger.error('TTS authentication failed - check API key');
      } else if (error.message.includes('429')) {
        logger.error('TTS rate limit exceeded - try again later');
      } else if (error.message.includes('network')) {
        logger.error('TTS network error - check connection');
      }
    }

    return null;
  }
}

// --- Service Factory ---
function getTranscriptionService(): TranscriptionService {
  switch (config.sttEngine) {
    case 'groq':
    default:
      logger.debug('Using Groq for STT');
      return { transcribe: transcribeWithGroq };
    // Future engines can be added here:
    // case 'openai':
    //   logger.debug('Using OpenAI for STT');
    //   return { transcribe: transcribeWithOpenAI };
  }
}

function getTextToSpeechService(): TextToSpeechService {
  switch (config.ttsEngine) {
    case 'groq':
    default:
      logger.debug('Using Groq for TTS');
      return { generateSpeech: generateSpeechWithGroq };
    // Future engines can be added here:
    // case 'elevenlabs':
    //   logger.debug('Using ElevenLabs for TTS');
    //   return { generateSpeech: generateSpeechWithElevenLabs };
  }
}

// Generate AI response using the configured model
async function generateAIResponse(
  userMessage: string,
  context?: { datetime: string; location?: string }
): Promise<string> {
  try {
    if (!aiModel) {
      logger.error('AI model not initialized');
      return '[AI model not available]';
    }

    // Enhance user message with context if available
    let enhancedUserMessage = userMessage;
    if (context) {
      let contextInfo = `[Context: ${context.datetime}`;
      if (context.location) {
        contextInfo += `, Location: ${context.location}`;
      }
      contextInfo += `]`;
      enhancedUserMessage = `${userMessage}\n\n${contextInfo}`;
    }

    // Prepare messages for the conversation
    const messages = [
      {
        role: 'system' as const,
        content:
          'You are a helpful voice assistant named Sandy. Provide concise, natural responses suitable for voice interaction. Keep responses conversational and brief unless more detail is specifically requested.',
      },
      // Include conversation history
      ...conversationHistory.map((msg) => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })),
      // Add the current user message with context
      {
        role: 'user' as const,
        content: enhancedUserMessage,
      },
    ];

    const result = await generateText({
      model: aiModel,
      messages,
      temperature: 0.7,
      maxTokens: 500, // Keep responses reasonably short for voice interaction
    });

    // logger.info(`🤖 history: ${JSON.stringify(messages)}`);
    // logger.info(`🤖 result: ${JSON.stringify(result)}`);

    return result.text || '[No response generated]';
  } catch (error) {
    logger.error('AI response generation failed:', error);

    if (error instanceof Error) {
      if (error.message.includes('401') || error.message.includes('api key')) {
        return '[AI authentication failed - check API key]';
      } else if (error.message.includes('429')) {
        return '[AI rate limit exceeded - try again later]';
      } else if (error.message.includes('network')) {
        return '[AI network error - check connection]';
      }
      return `[AI error: ${error.message}]`;
    }

    return '[AI response failed - unknown error]';
  }
}

// Add message to conversation history
function addToHistory(role: 'user' | 'assistant', content: string) {
  conversationHistory.push({
    role,
    content,
    timestamp: Date.now(),
  });

  // Keep history manageable (last 20 messages = 10 conversation pairs)
  if (conversationHistory.length > 20) {
    conversationHistory = conversationHistory.slice(-20);
  }
}

// Handle messages from main thread
// @ts-ignore - Bun worker global
self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  // logger.debug(`Worker received message: ${message.type}`);

  try {
    switch (message.type) {
      case 'init':
        sampleRate = message.sampleRate;
        try {
          aiModel = createModelByKey('gemini-2.5-flash'); // or 'openai' based on config
          logger.debug(
            `Worker initialized with sample rate: ${sampleRate} and AI model`
          );
          sendMessage({ type: 'init-complete', success: true });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          logger.error('Worker initialization failed:', errorMessage);
          sendMessage({
            type: 'init-complete',
            success: false,
            error: errorMessage,
          });
        }
        break;

      case 'setConfig':
        config = { ...config, ...message.config };
        logger.info(`Worker config updated: ${JSON.stringify(config)}`);
        break;

      case 'transcribe-audio':
        await transcribeAndProcess(
          message.sessionId,
          message.audioData,
          message.context
        );
        break;
    }
  } catch (error) {
    logger.error('Error in worker message handler:', error);

    // Check if it's a transcription message to send a specific error
    if (message.type === 'transcribe-audio') {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown processing error';
      sendMessage({
        type: 'error',
        sessionId: message.sessionId,
        error: errorMessage,
      });
    }
  }
};

// Transcribe audio, generate response, and send back to main thread
async function transcribeAndProcess(
  sessionId: string,
  audioData: Int16Array,
  context?: { datetime: string; location?: string }
) {
  try {
    // Step 1: Transcribe audio to text
    const transcript = await getTranscriptionService().transcribe(audioData);
    logger.debug(`Transcription result: "${transcript}"`);

    // Check if transcription produced a meaningful result
    if (
      !transcript ||
      transcript.toLowerCase().startsWith('[') ||
      transcript.trim().length < 2
    ) {
      logger.warn(
        `Skipping AI response due to empty or non-meaningful transcript: "${transcript}"`
      );
      // Even if we don't generate an AI response, we can send the transcript back
      sendMessage({
        type: 'speech-end',
        sessionId,
        transcript,
        aiResponse: '',
      });
      return;
    }

    // Add user's transcribed message to history
    addToHistory('user', transcript);

    // Step 2: Generate AI response
    const aiResponse = await generateAIResponse(transcript, context);
    logger.debug(`AI response: "${aiResponse}"`);

    // Add AI's response to history
    addToHistory('assistant', aiResponse);

    // Step 3: Generate TTS for the AI response
    const speechAudioNullable =
      await getTextToSpeechService().generateSpeech(aiResponse);
    const speechAudio =
      speechAudioNullable === null ? undefined : speechAudioNullable;

    // Step 4: Send all results back to the main thread
    sendMessage({
      type: 'speech-end',
      sessionId,
      transcript,
      aiResponse,
      speechAudio,
    });
  } catch (error) {
    logger.error('Error during transcription and processing:', error);

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown transcription error';

    // Send error message back to main thread
    sendMessage({
      type: 'error',
      sessionId,
      error: errorMessage,
    });
  }
}

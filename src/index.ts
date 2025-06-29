import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { serveStatic } from 'hono/bun';
import type { ServerWebSocket } from 'bun';
import logger from './logger';

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
const app = new Hono();

// Serve static files
app.use('/*', serveStatic({ root: './public' }));

const topic = 'voice-stream';

// Worker instance for audio processing
let audioWorker: Worker | null = null;
let server: any = null;
let workerReady = false;

// Worker message types (matching worker file)
interface WorkerResponse {
  type: 'speech-end' | 'init-complete' | 'error';
  id?: string;
  transcript?: string;
  aiResponse?: string;
  speechAudio?: ArrayBuffer;
  success?: boolean;
  error?: string;
}

// Initialize audio worker
function initializeWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      audioWorker = new Worker('./src/audio-worker.ts');

      audioWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;

        switch (message.type) {
          case 'init-complete':
            if (message.success) {
              workerReady = true;
              logger.debug('✅ Audio worker initialized successfully');
              resolve();
            } else {
              logger.error('❌ Worker initialization failed:', message.error);
              reject(
                new Error(message.error || 'Worker initialization failed')
              );
            }
            break;

          case 'speech-end':
            logger.debug(
              `🎤 Speech processed, transcript: "${message.transcript}"`
            );
            if (message.transcript && server) {
              // Send transcript message
              const transcriptMessage = {
                type: 'transcript',
                transcript: message.transcript,
                timestamp: new Date().toISOString(),
              };
              logger.debug(
                `📢 Broadcasting transcript: ${JSON.stringify(transcriptMessage)}`
              );
              server.publish(topic, JSON.stringify(transcriptMessage));

              // Send AI response message if available
              if (message.aiResponse) {
                const aiMessage = {
                  type: 'agent',
                  message: message.aiResponse,
                  speechAudio: message.speechAudio
                    ? Buffer.from(message.speechAudio).toString('base64')
                    : undefined,
                  timestamp: new Date().toISOString(),
                };
                logger.debug(
                  `🤖 Broadcasting AI response: ${JSON.stringify({ ...aiMessage, speechAudio: aiMessage.speechAudio ? `[${Buffer.from(message.speechAudio!).length} bytes]` : undefined })}`
                );
                logger.info(`🤖 AI Response content: "${message.aiResponse}"`);
                if (message.speechAudio) {
                  logger.debug(
                    `🎵 TTS Audio size: ${message.speechAudio.byteLength} bytes`
                  );
                }
                server.publish(topic, JSON.stringify(aiMessage));
              }
            } else {
              logger.warn('⚠️ No transcript generated from audio');
            }
            break;

          case 'error':
            logger.error('❌ Worker error:', message.error);
            if (server) {
              const errorMessage = {
                type: 'error',
                message: message.error,
                timestamp: new Date().toISOString(),
              };
              server.publish(topic, JSON.stringify(errorMessage));
            }
            break;

          default:
            logger.warn('❓ Unknown worker message:', message);
        }
      };

      audioWorker.onerror = (error) => {
        logger.error('❌ Worker error:', error);
        reject(error);
      };

      // Initialize the worker with sample rate
      audioWorker.postMessage({
        type: 'init',
        sampleRate: 16000,
      });
    } catch (error) {
      reject(error);
    }
  });
}

// WebSocket endpoint
app.get(
  '/ws',
  upgradeWebSocket((_) => ({
    onMessage(event, ws) {
      const rawWs = ws.raw as ServerWebSocket;

      // Handle both binary audio data and JSON context messages
      if (typeof event.data === 'string') {
        try {
          const contextData = JSON.parse(event.data);
          if (contextData.type === 'audio-context') {
            // Store context for the next audio chunk
            (rawWs as any).audioContext = contextData.context;
            logger.info('📍 Received audio context:', contextData.context);
            return;
          }
        } catch (e) {
          logger.warn('⚠️ Invalid JSON message:', event.data);
          return;
        }
      }

      // Handle binary audio data
      if (!workerReady || !audioWorker) {
        logger.warn('⚠️ Audio worker not ready yet');
        return;
      }

      const audioBuffer = Buffer.from(event.data as ArrayBuffer);
      logger.debug(`🎵 Received speech segment: ${audioBuffer.length} bytes`);

      // Get stored context (if any)
      const context = (rawWs as any).audioContext || null;
      processSpeechSegment(rawWs, audioBuffer, context);
    },
    onOpen(_, ws) {
      (ws.raw as ServerWebSocket).subscribe(topic);
      logger.info('🔌 WebSocket connection opened');

      // Send welcome message
      ws.send(
        JSON.stringify({
          type: 'agent',
          message: 'Hello! how may I assist you today?',
          workerReady,
          timestamp: new Date().toISOString(),
        })
      );
    },
    onClose(_, ws) {
      (ws.raw as ServerWebSocket).unsubscribe(topic);
      logger.info('🔌 WebSocket connection closed');
    },
  }))
);

function processSpeechSegment(
  ws: ServerWebSocket,
  chunk: Buffer,
  context: any = null
) {
  if (!audioWorker || !workerReady) {
    logger.warn('⚠️ Audio worker not available');
    return;
  }

  // The frontend now sends complete Float32Array segments.
  // We assume the data is in this format.
  const float32Audio = new Float32Array(
    chunk.buffer,
    chunk.byteOffset,
    chunk.length / 4
  );

  // Quick validation: check if audio has actual content (not just silence)
  const maxAmplitude = Math.max(...float32Audio.map(Math.abs));
  if (maxAmplitude < 0.01) {
    logger.debug('🔇 Audio segment too quiet, skipping transcription');
    return;
  }

  // Send audio data to worker for transcription
  const id = crypto.randomUUID();
  logger.debug(
    `📤 Sending speech to worker for transcription: ${float32Audio.length} samples`
  );

  const message = {
    type: 'transcribe-audio',
    id,
    audioData: float32Audio,
    context,
  };

  if (context) {
    logger.debug('📍 Including context in worker message:', context);
  }

  audioWorker.postMessage(message);
}

// Health check endpoint
app.get('/api/health', (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      worker: {
        ready: workerReady,
        active: audioWorker !== null,
      },
      websocket: {
        active: server !== null,
      },
    },
    version: '2.0.0',
  });
});

// Manual transcription endpoint (for testing)
app.post('/api/transcribe', async (c) => {
  if (!audioWorker || !workerReady) {
    return c.json(
      {
        error: 'Audio worker not ready',
        timestamp: new Date().toISOString(),
      },
      503
    );
  }

  try {
    const body = await c.req.json();
    const audioData = new Float32Array(body.audioData);

    // Send transcription request to worker
    const id = crypto.randomUUID();
    audioWorker.postMessage({
      type: 'transcribe-audio',
      id,
      audioData,
    });

    return c.json({
      message: 'Transcription request sent',
      id,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return c.json(
      {
        error: 'Invalid request format',
        timestamp: new Date().toISOString(),
      },
      400
    );
  }
});

// Initialize and start server
async function startServer() {
  try {
    logger.info('🚀 Starting Voice Agent Server...');

    // Initialize audio worker first
    logger.info('🔄 Initializing audio worker...');
    await initializeWorker();

    // Start the server
    server = Bun.serve({
      port: 3000,
      fetch: app.fetch,
      websocket,
    });

    logger.info(`🌟 Voice Agent Server running at http://localhost:3000`);
    logger.info(`🎤 Audio worker ready for speech-to-text processing`);
    logger.info(`📡 WebSocket endpoint: ws://localhost:3000/ws`);
  } catch (error) {
    logger.error('💥 Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('🛑 Shutting down gracefully...');
  if (audioWorker) {
    audioWorker.terminate();
  }
  if (server) {
    server.stop();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('🛑 Received SIGINT, shutting down gracefully...');
  if (audioWorker) {
    audioWorker.terminate();
  }
  if (server) {
    server.stop();
  }
  process.exit(0);
});

// Start the server
startServer().catch(logger.error);

import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { serveStatic } from 'hono/bun';
import type { ServerWebSocket } from 'bun';
import logger from './logger';
import { randomUUID } from 'crypto';

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
const app = new Hono();

// Serve static files
app.use('/*', serveStatic({ root: './public' }));

// Map to store sessions
interface SessionData {
  ws: ServerWebSocket;
  context?: any;
}
const sessions = new Map<string, SessionData>();

// Worker instance for audio processing
let audioWorker: Worker | null = null;
let server: any = null;
let workerReady = false;

// Worker message types (matching worker file)
interface WorkerResponse {
  type: 'speech-end' | 'init-complete' | 'error';
  sessionId?: string;
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
      audioWorker = new Worker('./src/worker.ts');

      audioWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        const session = message.sessionId
          ? sessions.get(message.sessionId)
          : undefined;

        if (!session && message.type !== 'init-complete') {
          logger.warn(
            `⚠️ Received worker message for unknown or missing session ID: ${message.sessionId}`
          );
          return;
        }

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
              `🎤 Speech processed for session ${message.sessionId}, transcript: "${message.transcript}"`
            );
            if (message.transcript && session) {
              // Send transcript message
              const transcriptMessage = {
                type: 'transcript',
                transcript: message.transcript,
                timestamp: new Date().toISOString(),
              };
              logger.debug(
                `📢 Sending transcript to session ${message.sessionId}: ${JSON.stringify(
                  transcriptMessage
                )}`
              );
              session.ws.send(JSON.stringify(transcriptMessage));

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
                  `🤖 Broadcasting AI response to session ${message.sessionId}`
                );
                logger.info(
                  `🤖 AI Response content for session ${message.sessionId}: "${message.aiResponse}"`
                );
                if (message.speechAudio) {
                  logger.debug(
                    `🎵 TTS Audio size for session ${message.sessionId}: ${message.speechAudio.byteLength} bytes`
                  );
                }
                session.ws.send(JSON.stringify(aiMessage));
              }
            } else {
              logger.warn(
                `⚠️ No transcript generated from audio for session ${message.sessionId}`
              );
            }
            break;

          case 'error':
            logger.error(
              `❌ Worker error for session ${message.sessionId}:`,
              message.error
            );
            if (session) {
              const errorMessage = {
                type: 'error',
                message: message.error,
                timestamp: new Date().toISOString(),
              };
              session.ws.send(JSON.stringify(errorMessage));
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
  upgradeWebSocket((c) => ({
    onMessage(event, ws) {
      const rawWs = ws.raw as ServerWebSocket & { sessionId: string };
      const sessionId = rawWs.sessionId;
      const session = sessions.get(sessionId);

      if (!session) {
        logger.error(
          `⚠️ Received message for unknown session ID: ${sessionId}`
        );
        return;
      }

      // Handle both binary audio data and JSON context messages
      if (typeof event.data === 'string') {
        try {
          const contextData = JSON.parse(event.data);
          if (contextData.type === 'audio-context') {
            // Store context for the next audio chunk
            session.context = contextData.context;
            logger.info(
              `📍 Received audio context for session ${sessionId}:`,
              contextData.context
            );
            return;
          }
        } catch (e) {
          logger.warn(
            `⚠️ Invalid JSON message from session ${sessionId}:`,
            event.data
          );
          return;
        }
      }

      // Handle binary audio data
      if (!workerReady || !audioWorker) {
        logger.warn('⚠️ Audio worker not ready yet');
        return;
      }

      const audioBuffer = Buffer.from(event.data as ArrayBuffer);
      logger.debug(
        `🎵 Received speech segment from session ${sessionId}: ${audioBuffer.length} bytes`
      );

      // Get stored context (if any)
      processSpeechSegment(sessionId, audioBuffer, session.context);
    },
    onOpen(event, ws) {
      const rawWs = ws.raw as ServerWebSocket & { sessionId: string };
      const sessionId = randomUUID();
      rawWs.sessionId = sessionId;
      sessions.set(sessionId, { ws: rawWs });

      logger.info(`🔌 WebSocket connection opened, session ID: ${sessionId}`);

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
    onClose(event, ws) {
      const rawWs = ws.raw as ServerWebSocket & { sessionId: string };
      const sessionId = rawWs.sessionId;
      if (sessionId) {
        sessions.delete(sessionId);
        logger.info(`🔌 WebSocket connection closed, session ID: ${sessionId}`);
      }
    },
    onError(event: Event, ws) {
      const rawWs = ws.raw as ServerWebSocket & { sessionId: string };
      const sessionId = rawWs.sessionId;
      if (sessionId) {
        sessions.delete(sessionId);
        logger.error(
          `🔌 WebSocket error for session ${sessionId}:`,
          (event as ErrorEvent).error
        );
      }
    },
  }))
);

function processSpeechSegment(
  sessionId: string,
  chunk: Buffer,
  context: any = null
) {
  if (!audioWorker || !workerReady) {
    logger.warn('⚠️ Audio worker not available');
    return;
  }

  // The frontend now sends 16-bit PCM audio data.
  const int16Audio = new Int16Array(
    chunk.buffer,
    chunk.byteOffset,
    chunk.length / 2 // 2 bytes per Int16 sample
  );

  // Quick validation: check if audio has actual content (not just silence)
  let maxAmplitude = 0;
  for (let i = 0; i < int16Audio.length; i++) {
    const amp = Math.abs(int16Audio[i]!);
    if (amp > maxAmplitude) {
      maxAmplitude = amp;
    }
  }

  // An absolute amplitude of 100 out of 32767 is very quiet.
  if (maxAmplitude < 100) {
    logger.debug(
      `🔇 Audio segment from session ${sessionId} too quiet (max amp: ${maxAmplitude}), skipping transcription`
    );
    return;
  }

  // Send audio data to worker for transcription
  logger.debug(
    `📤 Sending speech to worker for transcription from session ${sessionId}: ${int16Audio.length} samples`
  );

  const message = {
    type: 'transcribe-audio',
    sessionId,
    audioData: int16Audio,
    context,
  };

  if (context) {
    logger.debug(
      `📍 Including context in worker message for session ${sessionId}:`,
      context
    );
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

// Configuration endpoints for voice engines
app.get('/config', (c) => {
  // Return current config (default values since worker state isn't exposed)
  const currentConfig = {
    sttEngine: 'groq',
    ttsEngine: 'groq',
  };
  return c.json({ config: currentConfig });
});

app.post('/config', async (c) => {
  if (!workerReady || !audioWorker) {
    return c.json({ error: 'Worker not ready' }, 503);
  }

  try {
    const newConfig = await c.req.json();
    logger.info('⚙️ Received new config from client:', newConfig);

    // Validate config format (currently only groq is supported)
    // Future: Add validation for other engines like 'openai', 'elevenlabs', etc.
    const validConfig: any = {};
    if (newConfig.sttEngine === 'groq') {
      validConfig.sttEngine = 'groq';
    }
    if (newConfig.ttsEngine === 'groq') {
      validConfig.ttsEngine = 'groq';
    }

    // Forward config to the worker
    audioWorker.postMessage({
      type: 'setConfig',
      config: validConfig,
    });

    return c.json({ success: true, newConfig: validConfig });
  } catch (error) {
    logger.error('❌ Failed to update config:', error);
    return c.json({ error: 'Invalid configuration format' }, 400);
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

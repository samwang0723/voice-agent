import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { serveStatic } from 'hono/bun';
import type { ServerWebSocket } from 'bun';

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
              console.log('✅ Audio worker initialized successfully');
              resolve();
            } else {
              console.error('❌ Worker initialization failed:', message.error);
              reject(
                new Error(message.error || 'Worker initialization failed')
              );
            }
            break;

          case 'speech-end':
            console.log(
              `🎤 Speech processed, transcript: "${message.transcript}"`
            );
            if (message.transcript && server) {
              // Send transcript message
              const transcriptMessage = {
                type: 'transcript',
                transcript: message.transcript,
                timestamp: new Date().toISOString(),
              };
              console.log(
                `📢 Broadcasting transcript: ${JSON.stringify(transcriptMessage)}`
              );
              server.publish(topic, JSON.stringify(transcriptMessage));

              // Send AI response message if available
              if (message.aiResponse) {
                const aiMessage = {
                  type: 'agent',
                  message: message.aiResponse,
                  timestamp: new Date().toISOString(),
                };
                console.log(
                  `🤖 Broadcasting AI response: ${JSON.stringify(aiMessage)}`
                );
                console.log(`🤖 AI Response content: "${message.aiResponse}"`);
                server.publish(topic, JSON.stringify(aiMessage));
              }
            } else {
              console.warn('⚠️ No transcript generated from audio');
            }
            break;

          case 'error':
            console.error('❌ Worker error:', message.error);
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
            console.warn('❓ Unknown worker message:', message);
        }
      };

      audioWorker.onerror = (error) => {
        console.error('❌ Worker error:', error);
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
      if (typeof event.data === 'string') return;
      if (!workerReady || !audioWorker) {
        console.warn('⚠️ Audio worker not ready yet');
        return;
      }

      const rawWs = ws.raw as ServerWebSocket;
      const audioBuffer = Buffer.from(event.data as ArrayBuffer);
      console.log(`🎵 Received speech segment: ${audioBuffer.length} bytes`);
      processSpeechSegment(rawWs, audioBuffer);
    },
    onOpen(_, ws) {
      (ws.raw as ServerWebSocket).subscribe(topic);
      console.log('🔌 WebSocket connection opened');

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
      console.log('🔌 WebSocket connection closed');
    },
  }))
);

function processSpeechSegment(ws: ServerWebSocket, chunk: Buffer) {
  if (!audioWorker || !workerReady) {
    console.warn('⚠️ Audio worker not available');
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
    console.log('🔇 Audio segment too quiet, skipping transcription');
    return;
  }

  // Send audio data to worker for transcription
  const id = crypto.randomUUID();
  console.log(
    `📤 Sending speech to worker for transcription: ${float32Audio.length} samples`
  );
  audioWorker.postMessage({
    type: 'transcribe-audio',
    id,
    audioData: float32Audio,
  });
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
    console.log('🚀 Starting Voice Agent Server...');

    // Initialize audio worker first
    console.log('🔄 Initializing audio worker...');
    await initializeWorker();

    // Start the server
    server = Bun.serve({
      port: 3000,
      fetch: app.fetch,
      websocket,
    });

    console.log(`🌟 Voice Agent Server running at http://localhost:3000`);
    console.log(`🎤 Audio worker ready for speech-to-text processing`);
    console.log(`📡 WebSocket endpoint: ws://localhost:3000/ws`);
  } catch (error) {
    console.error('💥 Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  if (audioWorker) {
    audioWorker.terminate();
  }
  if (server) {
    server.stop();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  if (audioWorker) {
    audioWorker.terminate();
  }
  if (server) {
    server.stop();
  }
  process.exit(0);
});

// Start the server
startServer().catch(console.error);

import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { serveStatic } from 'hono/bun';
import { RealTimeVAD } from '@ericedouard/vad-node-realtime';
import type { ServerWebSocket } from 'bun';

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
const app = new Hono();

// Serve static files
app.use('/*', serveStatic({ root: './public' }));

const topic = 'voice-stream';

// Global VAD instance - will be initialized asynchronously
let vad: RealTimeVAD | null = null;
let server: any = null;

// Initialize VAD
async function initializeVAD() {
  try {
    vad = await RealTimeVAD.new({
      sampleRate: 16000,
      onSpeechEnd: (audio) => transcribeAndBroadcast(audio),
    });
    console.log('VAD initialized successfully');
  } catch (error) {
    console.error('Failed to initialize VAD:', error);
  }
}

// WebSocket endpoint
app.get(
  '/ws',
  upgradeWebSocket((_) => ({
    onMessage(event, ws) {
      if (typeof event.data === 'string') return;
      if (!vad) {
        console.warn('VAD not initialized yet');
        return;
      }

      const rawWs = ws.raw as ServerWebSocket;
      const audioBuffer = Buffer.from(event.data as ArrayBuffer);
      processAudioChunk(rawWs, audioBuffer);
    },
    onOpen(_, ws) {
      (ws.raw as ServerWebSocket).subscribe(topic);
      console.log('WebSocket connection opened');
    },
    onClose(_, ws) {
      (ws.raw as ServerWebSocket).unsubscribe(topic);
      console.log('WebSocket connection closed');
    },
  }))
);

function processAudioChunk(ws: ServerWebSocket, chunk: Buffer) {
  if (!vad) return;

  const float32Audio = convertToFloat32(chunk);
  vad.processAudio(float32Audio);
}

async function transcribeAndBroadcast(audio: Float32Array) {
  const transcript = await transcribeWithWhisper(audio);
  if (server) {
    server.publish(topic, transcript);
  }
}

// Audio utilities
const convertToFloat32 = (buffer: Buffer) => {
  const int16 = new Int16Array(buffer.buffer);
  return new Float32Array(int16.map((v) => v / 32768.0));
};

const transcribeWithWhisper = async (audio: Float32Array) => {
  // Implement Whisper API/local inference
  return 'Transcribed text'; // Placeholder
};

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    vadInitialized: vad !== null,
  });
});

// Initialize and start server
async function startServer() {
  // Initialize VAD first
  await initializeVAD();

  // Start the server
  server = Bun.serve({
    port: 3000,
    fetch: app.fetch,
    websocket,
  });

  console.log(`🚀 Server running at http://localhost:3000`);
}

// Start the server
startServer().catch(console.error);

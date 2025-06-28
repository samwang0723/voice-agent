import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { serveStatic } from 'hono/bun';
import type { ServerWebSocket } from 'bun';

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
const app = new Hono();

// Serve static files
app.use('/*', serveStatic({ root: './public' }));

// Ensure audio worklet is served with correct MIME type
app.get('/audio-processor.js', (c) => {
  return c.text(
    `class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;
    
    this.port.onmessage = (event) => {
      if (event.data.type === 'start') {
        this.isRecording = true;
      } else if (event.data.type === 'stop') {
        this.isRecording = false;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    
    if (input && input.length > 0 && this.isRecording) {
      const inputChannel = input[0];
      
      if (inputChannel && inputChannel.length > 0) {
        // Check if there's actual audio data (not just silence)
        const hasAudio = inputChannel.some(sample => Math.abs(sample) > 0.001);
        
        if (hasAudio) {
          // Send audio data to main thread
          this.port.postMessage({
            type: 'audiodata',
            audioData: inputChannel,
            length: inputChannel.length,
            max: Math.max(...inputChannel)
          });
        }
      }
    }

    return true; // Keep the processor alive
  }
}

registerProcessor('audio-processor', AudioProcessor);`,
    {
      headers: {
        'Content-Type': 'application/javascript',
      },
    }
  );
});

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
              console.log('Audio worker initialized successfully');
              resolve();
            } else {
              console.error('Worker initialization failed:', message.error);
              reject(
                new Error(message.error || 'Worker initialization failed')
              );
            }
            break;

          case 'speech-end':
            console.log(
              `🎤 Speech detected, transcript: "${message.transcript}"`
            );
            if (message.transcript && server) {
              const transcriptMessage = {
                type: 'transcript',
                transcript: message.transcript,
                timestamp: new Date().toISOString(),
              };
              console.log(
                `📢 Publishing transcript: ${JSON.stringify(transcriptMessage)}`
              );
              server.publish(topic, JSON.stringify(transcriptMessage));
            } else {
              console.warn('⚠️ No transcript or server not available');
            }
            break;

          case 'error':
            console.error('Worker error:', message.error);
            break;

          default:
            console.warn('Unknown worker message:', message);
        }
      };

      audioWorker.onerror = (error) => {
        console.error('Worker error:', error);
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
        console.warn('Audio worker not ready yet');
        return;
      }

      const rawWs = ws.raw as ServerWebSocket;
      const audioBuffer = Buffer.from(event.data as ArrayBuffer);
      console.log(`📡 Received audio chunk: ${audioBuffer.length} bytes`);
      processAudioChunk(rawWs, audioBuffer);
    },
    onOpen(_, ws) {
      (ws.raw as ServerWebSocket).subscribe(topic);
      console.log('WebSocket connection opened');

      // Send welcome message
      ws.send(
        JSON.stringify({
          type: 'connected',
          message: 'Voice agent ready',
          workerReady,
        })
      );
    },
    onClose(_, ws) {
      (ws.raw as ServerWebSocket).unsubscribe(topic);
      console.log('WebSocket connection closed');
    },
  }))
);

function processAudioChunk(ws: ServerWebSocket, chunk: Buffer) {
  if (!audioWorker || !workerReady) return;

  // Check if the data is already Float32Array (from Web Audio API)
  let float32Audio: Float32Array;

  if (chunk.length % 4 === 0 && chunk.length >= 4) {
    // Assume it's Float32Array data from Web Audio API
    float32Audio = new Float32Array(
      chunk.buffer,
      chunk.byteOffset,
      chunk.length / 4
    );
    console.log(`🎵 Processing Float32Array: ${float32Audio.length} samples`);
  } else {
    // Fallback to old conversion for 16-bit PCM data
    float32Audio = convertToFloat32(chunk);
    console.log(
      `🎵 Converted PCM to Float32Array: ${float32Audio.length} samples`
    );
  }

  // Send audio data to worker for processing
  const id = crypto.randomUUID();
  console.log(`📤 Sending audio to worker: ${id}`);
  audioWorker.postMessage({
    type: 'process-audio',
    id,
    audioData: float32Audio,
  });
}

// Audio utilities
const convertToFloat32 = (buffer: Buffer) => {
  // Ensure buffer length is even (for 16-bit samples)
  const length = Math.floor(buffer.length / 2);
  const int16Array = new Int16Array(length);

  // Manually read 16-bit values from buffer
  for (let i = 0; i < length; i++) {
    int16Array[i] = buffer.readInt16LE(i * 2);
  }

  return new Float32Array(int16Array.map((v) => v / 32768.0));
};

app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    workerReady,
    audioWorkerActive: audioWorker !== null,
  });
});

// Manual transcription endpoint (for testing)
app.post('/api/transcribe', async (c) => {
  if (!audioWorker || !workerReady) {
    return c.json({ error: 'Audio worker not ready' }, 503);
  }

  try {
    const body = await c.req.json();
    const audioData = new Float32Array(body.audioData);

    // Send transcription request to worker
    const id = crypto.randomUUID();
    audioWorker.postMessage({
      type: 'transcribe',
      id,
      audioData,
    });

    return c.json({
      message: 'Transcription request sent',
      id,
    });
  } catch (error) {
    return c.json({ error: 'Invalid request' }, 400);
  }
});

// Initialize and start server
async function startServer() {
  try {
    // Initialize audio worker first
    await initializeWorker();

    // Start the server
    server = Bun.serve({
      port: 3000,
      fetch: app.fetch,
      websocket,
    });

    console.log(`🚀 Server running at http://localhost:3000`);
    console.log(`🎤 Audio worker ready for voice processing`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  if (audioWorker) {
    audioWorker.terminate();
  }
  process.exit(0);
});

// Start the server
startServer().catch(console.error);

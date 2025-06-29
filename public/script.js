// Global variables
let ws = null;
let vadInstance = null;
let isListening = false;
let isConnected = false;
let isUserDisconnected = false; // Track if user manually disconnected
let isVadReady = false; // Track if VAD is initialized and ready
let audioContext = null;
let currentAudioSource = null; // Use for Web Audio API source node

// DOM elements
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');

const clearBtn = document.getElementById('clearBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connectBtn = document.getElementById('connectBtn');
const messagesEl = document.getElementById('messages');
const messagesContainer = document.querySelector('.messages-container');
const ttsEngineSelect = document.getElementById('tts-engine-select');

// Configure ONNX Runtime for maximum browser compatibility
function configureONNXRuntime() {
  if (typeof ort !== 'undefined') {
    // Use unpkg for better reliability
    ort.env.wasm.wasmPaths = 'https://unpkg.com/onnxruntime-web@1.14.0/dist/';

    // Conservative settings for maximum compatibility
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = false;
    ort.env.wasm.proxy = false;

    // Force CPU backend as fallback
    ort.env.executionProviders = ['cpu'];

    // Minimal logging
    ort.env.logLevel = 'error';

    console.log('ONNX Runtime configured for compatibility mode');
  }
}

// Add message to the messages area
function addMessage(content, type = 'info') {
  console.log(`💬 Adding message - Content: "${content}", Type: "${type}"`);

  const messageEl = document.createElement('div');
  messageEl.className = `message ${type}`;

  if (type === 'system') {
    messageEl.innerHTML = `<span class="content">• ${content}</span>`;
  } else {
    messageEl.innerHTML = `
      <span class="content">${content}</span>
      <span class="timestamp">${new Date().toLocaleTimeString()}</span>
    `;
  }

  console.log(
    `💬 Created message element with class: "${messageEl.className}"`
  );
  console.log(`💬 Message HTML: ${messageEl.innerHTML}`);

  messagesEl.appendChild(messageEl);

  // Auto-scroll to bottom to show the latest message
  if (messagesContainer) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

// Check if both conditions are met and auto-start listening
async function checkAndAutoStartListening() {
  if (isConnected && isVadReady && !isListening) {
    console.log('Both WebSocket and VAD ready - auto-starting listening');
    await startListening(true);
  }
}

// Start listening (extracted from toggle function)
async function startListening(isAutoStart = false) {
  if (!vadInstance) {
    addMessage('Voice detection not initialized', 'error');
    return false;
  }

  if (!isConnected) {
    addMessage(
      'Cannot start voice detection - not connected to server',
      'error'
    );
    return false;
  }

  try {
    console.log('Starting VAD...');
    await vadInstance.start();
    isListening = true;

    updateStatus(isConnected);
    return true;
  } catch (error) {
    console.error('Failed to start VAD:', error);
    addMessage(`Failed to start: ${error.message}`, 'error');
    return false;
  }
}

// Stop listening
function stopListening() {
  if (vadInstance) {
    console.log('Stopping VAD and releasing microphone...');
    vadInstance.destroy(); // Use destroy() to release the microphone
    vadInstance = null;
    isListening = false;
    isVadReady = false; // VAD is no longer ready
    updateStatus(isConnected);
  }
}

// Update connection status and UI
function updateStatus(connected) {
  isConnected = connected;
  const appContainer = document.querySelector('.app-container');

  if (connected && isVadReady) {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = 'Ready to listen';
    appContainer.classList.add('is-animating');

    // Show disconnect button, hide connect button
    disconnectBtn.classList.remove('hidden');
    connectBtn.classList.add('hidden');
  } else if (connected && !isVadReady) {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = 'Initializing voice detection...';
    appContainer.classList.remove('is-animating');

    // Show disconnect button, hide connect button
    disconnectBtn.classList.remove('hidden');
    connectBtn.classList.add('hidden');
  } else {
    statusIndicator.className = 'status-indicator';
    statusText.textContent = 'Disconnected';
    appContainer.classList.remove('is-animating');

    // Show connect button, hide disconnect button
    disconnectBtn.classList.add('hidden');
    connectBtn.classList.remove('hidden');
  }
}

// Play TTS audio from base64 data using Web Audio API
async function playTTSAudio(base64AudioData) {
  if (!audioContext) {
    console.error('AudioContext not available.');
    addMessage('Cannot play audio: AudioContext not initialized.', 'error');
    return;
  }

  // Resume context if it's suspended (e.g., after long inactivity or on first play)
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
      console.log('AudioContext resumed for playback.');
    } catch (e) {
      console.error('🎵 Failed to resume AudioContext:', e);
      addMessage(
        'Could not start audio. Please click the page to enable.',
        'error'
      );
      return;
    }
  }

  try {
    if (currentAudioSource) {
      currentAudioSource.stop();
      currentAudioSource = null;
    }

    // Find the most recent agent message to add visual indicator
    const agentMessages = document.querySelectorAll('.message.agent');
    const lastAgentMessage = agentMessages[agentMessages.length - 1];

    // Convert base64 to ArrayBuffer
    const binaryString = atob(base64AudioData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Decode audio data using Web Audio API
    const audioBuffer = await audioContext.decodeAudioData(bytes.buffer);

    // Create and play audio source
    currentAudioSource = audioContext.createBufferSource();
    currentAudioSource.buffer = audioBuffer;
    currentAudioSource.connect(audioContext.destination);

    // Add visual indicator when audio starts playing
    if (lastAgentMessage) {
      lastAgentMessage.classList.add('speaking');
    }

    currentAudioSource.onended = () => {
      // Remove visual indicator when audio ends
      if (lastAgentMessage) {
        lastAgentMessage.classList.remove('speaking');
      }
      console.log('🎵 TTS audio playback finished');
      currentAudioSource = null;
    };

    console.log('🎵 Playing TTS audio...');
    currentAudioSource.start();
  } catch (error) {
    console.error('🎵 Failed to play TTS audio:', error);
    // Ensure visual indicator is removed on error
    const agentMessages = document.querySelectorAll('.message.agent.speaking');
    agentMessages.forEach((msg) => msg.classList.remove('speaking'));
    currentAudioSource = null;
  }
}

// WebSocket connection management
function connectWebSocket() {
  if (isConnected) {
    console.log('Already connected.');
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    console.log('WebSocket connected');
    addMessage('Connected to websocket', 'system');

    // Send configuration to the server
    const sttEngine = document.getElementById('stt-engine-select').value;
    const ttsEngine = document.getElementById('tts-engine-select').value;
    ws.send(
      JSON.stringify({
        type: 'config',
        sttEngine,
        ttsEngine,
      })
    );
    addMessage(`Using STT: ${sttEngine}, TTS: ${ttsEngine}`, 'system');

    updateStatus(true);
    isUserDisconnected = false; // Reset flag when successfully connected

    // Check if we can auto-start listening
    await checkAndAutoStartListening();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('📥 Received WebSocket message:', data);

      switch (data.type) {
        case 'connected':
          addMessage(`${data.message}`, 'system');
          break;
        case 'transcript':
          console.log('📝 Adding transcript message:', data.transcript);
          addMessage(`${data.transcript}`, 'transcript');
          break;
        case 'agent':
          console.log('🤖 Adding agent message:', data.message);
          addMessage(`${data.message}`, 'agent');

          // Play TTS audio if available
          if (data.speechAudio) {
            console.log('🎵 Agent message includes TTS audio, playing...');
            playTTSAudio(data.speechAudio);
          }
          break;
        case 'error':
          addMessage(`${data.message}`, 'error');
          break;
        default:
          console.log(
            '❓ Unknown message type, adding as default:',
            event.data
          );
          addMessage(`${event.data}`);
      }
    } catch (e) {
      console.error('❌ Error parsing WebSocket message:', e);
      addMessage(`${event.data}`);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');

    // Stop voice listening
    stopListening();
    addMessage('Voice detection stopped (connection lost)', 'system');

    updateStatus(false);
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);

    // Only show error message if it's not a user-initiated disconnect
    if (!isUserDisconnected) {
      addMessage('Connection error.', 'error');
    }

    // Stop voice listening on connection error
    stopListening();
    addMessage('Voice detection stopped (connection error)', 'system');

    updateStatus(false);
  };
}

// Initialize Voice Activity Detection (VAD)
async function initializeVAD() {
  try {
    console.log('Initializing VAD...');
    addMessage('Initializing voice detection...', 'system');

    // Wait for ONNX Runtime to be fully loaded and check availability
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify ONNX Runtime is properly loaded
    if (typeof ort === 'undefined') {
      throw new Error('ONNX Runtime not loaded');
    }

    // Check if VAD library is loaded
    if (typeof vad === 'undefined') {
      throw new Error('VAD library not loaded');
    }

    console.log('ONNX Runtime version:', ort.version || 'unknown');
    console.log('VAD library loaded successfully');

    // Try multiple configurations for better compatibility
    const vadConfigs = [
      {
        model: 'v5',
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        userSpeakingThreshold: 0.6,
        redemptionFrames: 3,
        preSpeechPadFrames: 1,
        minSpeechFrames: 9,
        redemptionFrames: 24,
        frameSamples: 512,
      },
      // Simplest configuration first
      {
        model: 'legacy',
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        preSpeechPadFrames: 1,
        minSpeechFrames: 3,
      },
      // More detailed legacy config
      {
        model: 'legacy',
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.4,
        redemptionFrames: 8,
        preSpeechPadFrames: 1,
        minSpeechFrames: 4,
        frameSamples: 1536,
      },
    ];

    let vadInitialized = false;

    for (const config of vadConfigs) {
      try {
        console.log(`Trying VAD with ${config.model} model...`);
        vadInstance = await vad.MicVAD.new({
          onSpeechStart: () => {
            console.log('Speech started');
            updateStatus(isConnected);
          },
          onSpeechEnd: async (audio) => {
            console.log('Speech ended, audio length:', audio.length);
            updateStatus(isConnected);

            if (ws && ws.readyState === WebSocket.OPEN) {
              // Step 1: Gather context information
              const datetime = getCurrentDateTime();

              const context = {
                datetime: datetime.readable,
              };

              // Step 2: Send context first
              console.log('📍 Sending context:', context);
              ws.send(
                JSON.stringify({
                  type: 'audio-context',
                  context: context,
                })
              );

              // Step 3: Convert to 16-bit PCM and send audio data.
              // This reduces payload size by 50% compared to Float32.
              const int16Array = new Int16Array(audio.length);
              for (let i = 0; i < audio.length; i++) {
                const s = Math.max(-1, Math.min(1, audio[i]));
                int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
              }

              console.log(
                'Sending audio data as Int16:',
                int16Array.byteLength,
                'bytes'
              );
              ws.send(int16Array.buffer);
              addMessage(
                `Audio sent (${audio.length} samples as 16-bit PCM)`,
                'system'
              );

              // Show context info to user
              addMessage(`📍 Context: ${context.datetime}`, 'system');
            } else {
              addMessage('Not connected to server', 'error');
            }
          },
          onVADMisfire: () => {
            console.log('VAD misfire');
            updateStatus(isConnected);
          },
          ...config,
        });

        console.log(`VAD initialized successfully with ${config.model} model`);
        addMessage(`Voice detection ready (${config.model} model)`, 'system');
        vadInitialized = true;
        isVadReady = true;

        // Check if we can auto-start listening now that VAD is ready
        await checkAndAutoStartListening();
        break;
      } catch (modelError) {
        console.warn(
          `Failed to initialize with ${config.model} model:`,
          modelError
        );
        continue;
      }
    }

    if (!vadInitialized) {
      throw new Error('All VAD models failed to initialize');
    }
  } catch (error) {
    console.error('VAD initialization failed:', error);
    addMessage(`Voice detection failed: ${error.message}`, 'error');
    addMessage(
      'Try refreshing the page or check browser compatibility',
      'system'
    );
  }
}

// Clear all messages
function clearMessages() {
  messagesEl.innerHTML = '';
  addMessage('Messages cleared', 'system');
}

// Disconnect from server
function disconnect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    // Stop voice listening first
    stopListening();

    // Mark as user-initiated disconnect to prevent auto-reconnect
    isUserDisconnected = true;

    // Close connection
    ws.close();
    addMessage('Disconnected by user', 'system');

    // Update UI immediately
    updateStatus(false);
  } else {
    addMessage('No active connection to disconnect', 'system');
  }
}

// Connect to server
async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    addMessage('Already connected', 'system');
    return;
  }

  // Reset user disconnect flag when manually connecting
  isUserDisconnected = false;

  addMessage('Connecting to server...', 'system');

  // Re-initialize VAD if it's not ready
  if (!isVadReady) {
    await initializeVAD();
  }

  connectWebSocket();
}

// Check browser compatibility
function checkBrowserCompatibility() {
  const isCompatible = {
    webAssembly: typeof WebAssembly !== 'undefined',
    audioContext:
      typeof AudioContext !== 'undefined' ||
      typeof webkitAudioContext !== 'undefined',
    mediaDevices: navigator.mediaDevices && navigator.mediaDevices.getUserMedia,
    webWorkers: typeof Worker !== 'undefined',
    webSockets: typeof WebSocket !== 'undefined',
    requestAnimationFrame: typeof requestAnimationFrame !== 'undefined',
  };

  const incompatible = Object.entries(isCompatible)
    .filter(([_, supported]) => !supported)
    .map(([feature, _]) => feature);

  if (incompatible.length > 0) {
    addMessage(`Browser missing features: ${incompatible.join(', ')}`, 'error');
    addMessage(
      'Try using Chrome, Firefox, or Safari for best compatibility',
      'system'
    );
    return false;
  }

  addMessage('Browser compatibility check passed', 'system');
  return true;
}

// Check if running in secure context (HTTPS)
function checkSecureContext() {
  const isSecure = window.isSecureContext;
  const protocol = window.location.protocol;

  console.log('🔒 Protocol:', protocol);
  console.log('🔒 Secure context:', isSecure);
  console.log('🔒 Location:', window.location.href);

  if (
    !isSecure &&
    protocol !== 'https:' &&
    !window.location.hostname.includes('localhost')
  ) {
    addMessage('⚠️ Features require HTTPS in production', 'system');
    addMessage('🔒 Current protocol: ' + protocol, 'system');
    return false;
  }

  return true;
}

// Main initialization function
async function initializeApp() {
  console.log('🚀 Initializing application...');

  // Configure ONNX for compatibility before anything else
  configureONNXRuntime();

  checkBrowserCompatibility();

  if (checkSecureContext()) {
    // Set initial config on the backend, then initialize VAD and connect
    await initializeVAD();
    connectWebSocket(); // This will also trigger auto-start listening when ready
  } else {
    updateStatus(false);
  }
}

// Event listeners setup
function setupEventListeners() {
  clearBtn.addEventListener('click', clearMessages);
  disconnectBtn.addEventListener('click', disconnect);
  connectBtn.addEventListener('click', connect);

  // Add event listeners for engine selection changes
  const sttEngineSelect = document.getElementById('stt-engine-select');
  const ttsEngineSelect = document.getElementById('tts-engine-select');

  const sendConfig = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const sttEngine = sttEngineSelect.value;
      const ttsEngine = ttsEngineSelect.value;
      ws.send(
        JSON.stringify({
          type: 'config',
          sttEngine,
          ttsEngine,
        })
      );
      addMessage(
        `Configuration updated - STT: ${sttEngine}, TTS: ${ttsEngine}`,
        'system'
      );
    }
  };

  sttEngineSelect.addEventListener('change', sendConfig);
  ttsEngineSelect.addEventListener('change', sendConfig);
}

// Initialize everything when DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
  configureONNXRuntime();
  initializeAudioContext();
  setupEventListeners();
});

// Initialize app when page is fully loaded
window.addEventListener('load', initializeApp);

// Get formatted current datetime
function getCurrentDateTime() {
  const now = new Date();

  const options = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  };

  return {
    iso: now.toISOString(),
    readable: now.toLocaleDateString('en-US', options),
    timestamp: now.getTime(),
  };
}

// Initialize the Web Audio API context
function initializeAudioContext() {
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === 'suspended') {
      addMessage('🔊 Click anywhere on the page to enable audio', 'system');
      document.body.addEventListener('click', resumeAudioContext, {
        once: true,
      });
      document.body.addEventListener('touchstart', resumeAudioContext, {
        once: true,
      });
    }
  } catch (e) {
    console.error('Web Audio API is not supported in this browser.', e);
    addMessage('Audio playback is not supported by your browser.', 'error');
  }
}

// Resume AudioContext after a user gesture
function resumeAudioContext() {
  if (audioContext && audioContext.state === 'suspended') {
    audioContext
      .resume()
      .then(() => {
        console.log('AudioContext resumed successfully.');
        addMessage('🔊 Audio enabled', 'system');
      })
      .catch((e) => console.error('Failed to resume AudioContext', e));
  }
}

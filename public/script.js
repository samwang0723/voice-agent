// Global variables
let ws = null;
let vadInstance = null;
let isListening = false;
let isConnected = false;
let isUserDisconnected = false; // Track if user manually disconnected
let isVadReady = false; // Track if VAD is initialized and ready

// DOM elements
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');

const clearBtn = document.getElementById('clearBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connectBtn = document.getElementById('connectBtn');
const messagesEl = document.getElementById('messages');
const messagesContainer = document.querySelector('.messages-container');

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

  messagesEl.appendChild(messageEl);

  // Auto-scroll to bottom with a small delay to ensure DOM is updated
  setTimeout(() => {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  }, 10);
}

// Check if both conditions are met and auto-start listening
async function checkAndAutoStartListening() {
  if (isConnected && isVadReady && !isListening) {
    console.log('Both WebSocket and VAD ready - auto-starting listening');
    addMessage('Auto-starting voice detection...', 'system');
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

    if (isAutoStart) {
      addMessage('Voice detection started automatically', 'system');
    } else {
      addMessage('Voice detection started manually', 'system');
    }

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
  if (vadInstance && isListening) {
    console.log('Stopping VAD...');
    vadInstance.pause();
    isListening = false;
    updateStatus(isConnected);
    addMessage('Voice detection stopped', 'system');
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

// WebSocket connection management
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    console.log('WebSocket connected');
    addMessage('Connected to voice agent', 'system');
    updateStatus(true);
    isUserDisconnected = false; // Reset flag when successfully connected

    // Check if we can auto-start listening
    await checkAndAutoStartListening();
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'connected':
          addMessage(`${data.message}`, 'system');
          break;
        case 'transcript':
          addMessage(`${data.transcript}`, 'transcript');
          break;
        case 'error':
          addMessage(`${data.message}`, 'error');
          break;
        default:
          addMessage(`${event.data}`);
      }
    } catch (e) {
      addMessage(`${event.data}`);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket disconnected');

    // Only show "Disconnected from server" if it wasn't user-initiated
    if (!isUserDisconnected) {
      addMessage('Disconnected from server', 'system');
    }

    // Stop voice listening if it's currently active
    if (isListening) {
      stopListening();
      addMessage('Voice detection stopped (connection lost)', 'system');
    }

    updateStatus(false);

    // Only auto-reconnect if it wasn't a user-initiated disconnect
    if (!isUserDisconnected) {
      addMessage('Reconnecting in 3 seconds...', 'system');
      setTimeout(connectWebSocket, 3000);
    }
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);

    // Only show error message if it's not a user-initiated disconnect
    if (!isUserDisconnected) {
      addMessage('Connection error - retrying...', 'error');
    }

    // Stop voice listening on connection error
    if (isListening) {
      stopListening();
      addMessage('Voice detection stopped (connection error)', 'system');
    }
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
        addMessage(`Trying ${config.model} model...`, 'system');

        vadInstance = await vad.MicVAD.new({
          onSpeechStart: () => {
            console.log('Speech started');
            updateStatus(isConnected);
          },
          onSpeechEnd: (audio) => {
            console.log('Speech ended, audio length:', audio.length);
            updateStatus(isConnected);

            if (ws && ws.readyState === WebSocket.OPEN) {
              // Send audio data as Float32Array buffer
              const buffer = new ArrayBuffer(audio.length * 4);
              const view = new Float32Array(buffer);
              view.set(audio);

              console.log('Sending audio data:', audio.length, 'samples');
              ws.send(buffer);
              addMessage(`Audio sent (${audio.length} samples)`, 'system');
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
        addMessage(`${config.model} model failed, trying next...`, 'system');
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
    if (isListening) {
      stopListening();
    }

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
function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    addMessage('Already connected', 'system');
    return;
  }

  // Reset user disconnect flag when manually connecting
  isUserDisconnected = false;

  addMessage('Connecting to server...', 'system');
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

// Main initialization function
async function initializeApp() {
  addMessage('Initializing voice agent...', 'system');

  // Check browser compatibility first
  if (!checkBrowserCompatibility()) {
    addMessage('Browser not compatible with voice detection', 'error');
    return;
  }

  // Connect WebSocket first
  connectWebSocket();

  // Initialize VAD with retry logic
  let initAttempts = 0;
  const maxAttempts = 3;

  while (initAttempts < maxAttempts && !vadInstance) {
    initAttempts++;
    addMessage(
      `Initialization attempt ${initAttempts}/${maxAttempts}`,
      'system'
    );
    await initializeVAD();

    if (!vadInstance && initAttempts < maxAttempts) {
      addMessage('Waiting before retry...', 'system');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  if (vadInstance) {
    addMessage(
      'Ready! Voice detection will start automatically when connected',
      'system'
    );
  } else {
    addMessage(
      'Failed to initialize voice detection after all attempts',
      'error'
    );
    addMessage(
      'Try refreshing the page or check browser compatibility',
      'system'
    );
  }
}

// Event listeners setup
function setupEventListeners() {
  clearBtn.addEventListener('click', clearMessages);
  disconnectBtn.addEventListener('click', disconnect);
  connectBtn.addEventListener('click', connect);
}

// Initialize everything when DOM is loaded
window.addEventListener('DOMContentLoaded', () => {
  configureONNXRuntime();
  setupEventListeners();
});

// Initialize app when page is fully loaded
window.addEventListener('load', initializeApp);

// Global variables
let ws = null;
let vadInstance = null;
let isListening = false;
let isConnected = false;
let isUserDisconnected = false; // Track if user manually disconnected
let isVadReady = false; // Track if VAD is initialized and ready
let currentAudio = null; // Track currently playing TTS audio
let userLocation = null; // Cache user location
let locationPermissionGranted = false;

// DOM elements
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');

const clearBtn = document.getElementById('clearBtn');
const locationBtn = document.getElementById('locationBtn');
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

// Play TTS audio from base64 data
async function playTTSAudio(base64AudioData) {
  try {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
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

    // Create blob and object URL
    const audioBlob = new Blob([bytes], { type: 'audio/wav' });
    const audioUrl = URL.createObjectURL(audioBlob);

    // Create and play audio
    currentAudio = new Audio(audioUrl);

    // Add visual indicator when audio starts playing
    if (lastAgentMessage) {
      lastAgentMessage.classList.add('speaking');
    }

    currentAudio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
      // Remove visual indicator when audio ends
      if (lastAgentMessage) {
        lastAgentMessage.classList.remove('speaking');
      }
      console.log('🎵 TTS audio playback finished');
    };

    currentAudio.onerror = (error) => {
      console.error('🎵 TTS audio playback error:', error);
      URL.revokeObjectURL(audioUrl);
      currentAudio = null;
      // Remove visual indicator on error
      if (lastAgentMessage) {
        lastAgentMessage.classList.remove('speaking');
      }
    };

    console.log('🎵 Playing TTS audio...');
    await currentAudio.play();
  } catch (error) {
    console.error('🎵 Failed to play TTS audio:', error);
    if (currentAudio) {
      currentAudio = null;
    }
    // Remove visual indicator on exception
    const agentMessages = document.querySelectorAll('.message.agent.speaking');
    agentMessages.forEach((msg) => msg.classList.remove('speaking'));
  }
}

// WebSocket connection management
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    console.log('WebSocket connected');
    addMessage('Connected to websocket', 'system');
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
  };

  ws.onerror = (error) => {
    console.error('WebSocket error:', error);

    // Only show error message if it's not a user-initiated disconnect
    if (!isUserDisconnected) {
      addMessage('Connection error.', 'error');
    }

    // Stop voice listening on connection error
    if (isListening) {
      stopListening();
      addMessage('Voice detection stopped (connection error)', 'system');
    }

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
              // const location = await getCurrentLocation();

              const context = {
                datetime: datetime.readable,
                // location: location ? location.readable : undefined,
              };

              // Step 2: Send context first
              console.log('📍 Sending context:', context);
              ws.send(
                JSON.stringify({
                  type: 'audio-context',
                  context: context,
                })
              );

              // Step 3: Send audio data as Float32Array buffer
              const buffer = new ArrayBuffer(audio.length * 4);
              const view = new Float32Array(buffer);
              view.set(audio);

              console.log('Sending audio data:', audio.length, 'samples');
              ws.send(buffer);
              addMessage(`Audio sent (${audio.length} samples)`, 'system');

              // Show context info to user
              if (context.location) {
                addMessage(
                  `📍 Context: ${context.datetime}, ${context.location}`,
                  'system'
                );
              } else {
                addMessage(`📍 Context: ${context.datetime}`, 'system');
              }
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
    addMessage('⚠️ Location requires HTTPS in production', 'system');
    addMessage('🔒 Current protocol: ' + protocol, 'system');
    return false;
  }

  return true;
}

// Handle location permission request
async function requestLocationPermission() {
  console.log('📍 Manual location permission request triggered');

  // Check current permission status first
  if ('permissions' in navigator) {
    try {
      const permission = await navigator.permissions.query({
        name: 'geolocation',
      });
      console.log('📍 Current permission state:', permission.state);

      if (permission.state === 'denied') {
        addMessage('📍 Location permission was previously denied', 'system');
        addMessage(
          '📍 To enable: Click the 🔒/🌐 icon in your address bar → Location → Allow',
          'system'
        );
        addMessage('📍 Then refresh the page and try again', 'system');
        // Offer manual location input
        setTimeout(() => {
          promptManualLocation();
        }, 1000);
        return;
      } else if (permission.state === 'granted') {
        addMessage(
          '📍 Location permission already granted, getting location...',
          'system'
        );
      } else {
        addMessage('📍 Requesting location permission...', 'system');
      }
    } catch (e) {
      console.log(
        '📍 Permission API not available, proceeding with geolocation request'
      );
      addMessage('📍 Requesting location permission...', 'system');
    }
  } else {
    addMessage('📍 Requesting location permission...', 'system');
  }

  const location = await getCurrentLocation();
  updateLocationButtonState(location !== null);

  if (location) {
    addMessage(`📍 Location access granted: ${location.readable}`, 'system');
  } else {
    addMessage('📍 Location access denied or unavailable', 'system');
    addMessage('📍 💡 To enable location:', 'system');
    addMessage('📍 1. Click the 🔒 or 🌐 icon in your address bar', 'system');
    addMessage('📍 2. Find "Location" and set it to "Allow"', 'system');
    addMessage('📍 3. Refresh the page and try again', 'system');
    // Offer manual location input as fallback
    setTimeout(() => {
      promptManualLocation();
    }, 1000);
  }
}

// Prompt user for manual location input
function promptManualLocation() {
  const location = prompt(
    '📍 Alternatively, enter your location manually (e.g., "San Francisco, CA"):'
  );

  if (location && location.trim()) {
    userLocation = {
      readable: location.trim(),
      manual: true,
    };
    locationPermissionGranted = true;
    updateLocationButtonState(true);
    addMessage(`📍 Manual location set: ${location.trim()}`, 'system');
    console.log('📍 Manual location set:', userLocation);
  } else if (location === '') {
    addMessage('📍 Manual location cancelled', 'system');
  }
}

// Update location button state
function updateLocationButtonState(granted) {
  if (granted) {
    locationBtn.classList.add('granted');
    locationBtn.querySelector('span').textContent = 'Located';
  } else {
    locationBtn.classList.remove('granted');
    locationBtn.querySelector('span').textContent = 'Location';
  }
}

// Main initialization function
async function initializeApp() {
  addMessage('Initializing voice agent...', 'system');

  // Check browser compatibility first
  if (!checkBrowserCompatibility()) {
    addMessage('Browser not compatible with voice detection', 'error');
    return;
  }

  // Check secure context for geolocation
  const isSecure = checkSecureContext();

  // Show location button for manual permission
  if (navigator.geolocation && isSecure) {
    locationBtn.classList.remove('hidden');
    addMessage(
      '📍 Click the location button to enable location context (optional)',
      'system'
    );
  } else if (navigator.geolocation && !isSecure) {
    addMessage(
      '📍 Location unavailable: requires HTTPS or localhost',
      'system'
    );
  } else {
    addMessage('📍 Geolocation not supported by browser', 'system');
  }

  // Connect WebSocket first
  connectWebSocket();

  // Initialize VAD with retry logic
  let initAttempts = 0;
  const maxAttempts = 3;

  while (initAttempts < maxAttempts && !vadInstance) {
    initAttempts++;
    await initializeVAD();

    if (!vadInstance && initAttempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  if (vadInstance) {
    addMessage('Voice detection ready', 'system');
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
  locationBtn.addEventListener('click', requestLocationPermission);
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

// Get user's current location
async function getCurrentLocation() {
  console.log('📍 getCurrentLocation called');

  if (!navigator.geolocation) {
    console.log('📍 Geolocation not supported by browser');
    return null;
  }

  console.log('📍 Geolocation API available');

  if (userLocation && locationPermissionGranted) {
    console.log('📍 Using cached location:', userLocation.readable);
    return userLocation; // Return cached location
  }

  console.log('📍 Requesting fresh location...');

  return new Promise((resolve) => {
    const options = {
      enableHighAccuracy: false, // Faster, less battery intensive
      timeout: 10000, // Increased timeout
      maximumAge: 300000, // Use cached location if less than 5 minutes old
    };

    console.log('📍 Calling navigator.geolocation.getCurrentPosition...');

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        console.log('📍 Position obtained:', position);
        const { latitude, longitude } = position.coords;

        try {
          // Try to get readable location using reverse geocoding
          console.log('📍 Attempting reverse geocoding...');
          const response = await fetch(
            `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=en`
          );
          const data = await response.json();
          console.log('📍 Reverse geocoding result:', data);

          userLocation = {
            latitude: latitude.toFixed(6),
            longitude: longitude.toFixed(6),
            city: data.city || 'Unknown',
            region: data.principalSubdivision || 'Unknown',
            country: data.countryName || 'Unknown',
            readable: `${data.city || 'Unknown'}, ${data.principalSubdivision || 'Unknown'}, ${data.countryName || 'Unknown'}`,
          };

          locationPermissionGranted = true;
          console.log(
            '📍 Location obtained with geocoding:',
            userLocation.readable
          );
          resolve(userLocation);
        } catch (geocodeError) {
          console.log('📍 Reverse geocoding failed:', geocodeError);
          // Fallback to coordinates only if reverse geocoding fails
          userLocation = {
            latitude: latitude.toFixed(6),
            longitude: longitude.toFixed(6),
            readable: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
          };

          locationPermissionGranted = true;
          console.log(
            '📍 Location obtained (coordinates only):',
            userLocation.readable
          );
          resolve(userLocation);
        }
      },
      (error) => {
        console.log('📍 Geolocation error details:', error);
        console.log('📍 Error code:', error.code);
        console.log('📍 Error message:', error.message);

        let errorMessage = 'Unknown location error';
        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMessage = 'Location access denied by user';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = 'Location information unavailable';
            break;
          case error.TIMEOUT:
            errorMessage = 'Location request timed out';
            break;
        }

        console.log('📍 Processed error message:', errorMessage);
        locationPermissionGranted = false;
        resolve(null);
      },
      options
    );
  });
}

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

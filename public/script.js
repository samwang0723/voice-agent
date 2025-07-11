import createRNNWasmModule from './rnnoise.js';
import AudioPlayer from './audioPlayer.js';

// OAuth Configuration
const AGENT_SWARM_API = 'https://50c21f73c5ca.ngrok-free.app/api/v1';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/calendar',
];

// Global variables
let ws = null;
let vadInstance = null;
let isListening = false;
let isConnected = false;
let isUserDisconnected = false; // Track if user manually disconnected
let isVadReady = false; // Track if VAD is initialized and ready
let isOAuthInProgress = false; // Prevent multiple OAuth flows

// Initialize AudioPlayer instance
const audioPlayer = new AudioPlayer();

// RNNoise global variables
let rnnoiseModule = null;
let rnnoiseState = null;
let isNoiseReductionEnabled = true;
let inputBuffer = null;
let outputBuffer = null;

// VAD Tuning Configuration - Centralized settings to prevent false triggers
const DEFAULT_VAD_TUNING = {
  positiveSpeechThreshold: 0.7, // Increased from 0.5-0.6 for less sensitivity
  negativeSpeechThreshold: 0.5, // Increased from 0.35-0.4 for cleaner cutoffs
  minSpeechFrames: 6, // Increased from 3-4, requires ~64ms vs 32ms
  redemptionFrames: 4, // Reduced from 8 for shorter speech tails
  preSpeechPadFrames: 1,
  frameSamples: 512,
};

// RMS Energy Gate Threshold (approximately -40 dBFS)
const RMS_ENERGY_THRESHOLD = 0.01;

// VAD Debugging Counters for observability
const vadDebugCounters = {
  falseStarts: 0,
  trueStarts: 0,
  gateDrops: 0,
};

// DOM elements
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const googleLoginBtn = document.getElementById('googleLoginBtn');

const clearBtn = document.getElementById('clearBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connectBtn = document.getElementById('connectBtn');
const messagesEl = document.getElementById('messages');
const messagesContainer = document.querySelector('.messages-container');
const chatModeSelect = document.getElementById('chat-mode-select');

// Streaming support variables
let activeStreamMsg = {
  text: '',
  domEl: null,
};

// Function to get client timezone using browser API
function getClientTimezone() {
  try {
    // Use Intl.DateTimeFormat to get the timezone
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch (error) {
    console.warn('Failed to detect client timezone:', error);
    return 'UTC';
  }
}

// Function to get current client datetime in ISO format
function getClientDateTime() {
  try {
    return new Date().toISOString();
  } catch (error) {
    console.warn('Failed to get client datetime:', error);
    return new Date().toISOString();
  }
}

// OAuth Token Storage Utilities
function storeToken(tokenData) {
  try {
    localStorage.setItem('oauth_token', JSON.stringify(tokenData));
    if (googleLoginBtn) {
      googleLoginBtn.classList.add('hidden');
    }
    hideLoginPrompt();
    addMessage('Authentication successful', 'system');
  } catch (error) {
    console.error('Failed to store token:', error);
    addMessage('Failed to store authentication token', 'error');
  }
}

function getStoredToken() {
  try {
    const tokenData = localStorage.getItem('oauth_token');
    return tokenData ? JSON.parse(tokenData) : null;
  } catch (error) {
    console.error('Failed to retrieve token:', error);
    return null;
  }
}

function clearToken() {
  try {
    localStorage.removeItem('oauth_token');
    sessionStorage.removeItem('oauth_state'); // Clear OAuth state as well
    isOAuthInProgress = false; // Reset OAuth flag when clearing tokens
    updateLoginButtonState(); // Update button appearance
    showLoginPrompt();
    addMessage('Logged out successfully', 'system');
  } catch (error) {
    console.error('Failed to clear token:', error);
    addMessage('Failed to clear authentication token', 'error');
  }
}

function isTokenExpired() {
  try {
    const tokenData = getStoredToken();
    if (!tokenData || !tokenData.expires_in) {
      return false; // No expiration info, assume valid
    }

    const tokenTimestamp = tokenData.timestamp || 0;
    const expiresInMs = tokenData.expires_in * 1000;
    const currentTime = Date.now();

    return currentTime - tokenTimestamp >= expiresInMs;
  } catch (error) {
    console.error('Failed to check token expiration:', error);
    return true; // Assume expired on error
  }
}

function showLoginPrompt() {
  // Remove any existing login prompts first
  hideLoginPrompt();

  const messageEl = document.createElement('div');
  messageEl.className = 'message system login-prompt';
  messageEl.setAttribute('data-login-prompt', 'true');

  messageEl.innerHTML = `
    <span class="content">
      🔐 Authentication required for full functionality
      <button class="google-login-btn dynamic-login-btn" onclick="loginWithGoogle()">
        <svg class="google-icon" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Sign in with Google
      </button>
    </span>
  `;

  messagesEl.appendChild(messageEl);
  attachLoginButtonListener();

  // Auto-scroll to bottom to show the login prompt
  if (messagesContainer) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

function hideLoginPrompt() {
  const loginPrompts = document.querySelectorAll('[data-login-prompt="true"]');
  loginPrompts.forEach((prompt) => prompt.remove());
}

function attachLoginButtonListener() {
  const dynamicLoginBtn = document.querySelector('.dynamic-login-btn');
  if (dynamicLoginBtn) {
    dynamicLoginBtn.addEventListener('click', (e) => {
      // Prevent default and multiple clicks during OAuth
      e.preventDefault();
      if (isOAuthInProgress) {
        return;
      }
      loginWithGoogle();
    });
  }
}

// OAuth Flow Functions
async function loginWithGoogle() {
  // Prevent multiple OAuth flows
  if (isOAuthInProgress) {
    console.log('OAuth flow already in progress, ignoring duplicate request');
    addMessage('Authentication already in progress...', 'system');
    return;
  }

  try {
    isOAuthInProgress = true;
    setOAuthTimeout(); // Start timeout mechanism
    updateLoginButtonState(); // Update button appearance

    // Clear any existing state first
    sessionStorage.removeItem('oauth_state');

    const state = crypto.randomUUID();
    const timestamp = Date.now();

    // Store state with timestamp for validation
    const stateData = {
      state: state,
      timestamp: timestamp,
    };

    sessionStorage.setItem('oauth_state', JSON.stringify(stateData));
    console.log('Generated and stored OAuth state:', state);

    const redirectUri = `${window.location.origin}${window.location.pathname}`;

    const initiateResponse = await fetch(
      `${AGENT_SWARM_API}/auth/oauth/initiate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          redirect_uri: redirectUri,
          state: state,
          scopes: OAUTH_SCOPES,
        }),
      }
    );

    if (!initiateResponse.ok) {
      throw new Error(`OAuth initiate failed: ${initiateResponse.status}`);
    }

    const initiateData = await initiateResponse.json();

    if (!initiateData.auth_url) {
      throw new Error('No auth URL received from server');
    }

    addMessage('Redirecting to Google for authentication...', 'system');
    window.location.href = initiateData.auth_url;
  } catch (error) {
    console.error('OAuth initiation failed:', error);
    addMessage(`Authentication failed: ${error.message}`, 'error');
    isOAuthInProgress = false; // Reset flag on error
    updateLoginButtonState(); // Update button appearance
  }
}

async function handleOAuthCallback() {
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    const state = urlParams.get('state');
    const error = urlParams.get('error');

    if (error) {
      throw new Error(`OAuth error: ${error}`);
    }

    if (!code) {
      return; // Not an OAuth callback
    }

    // Retrieve and parse stored state data
    const storedStateStr = sessionStorage.getItem('oauth_state');
    if (!storedStateStr) {
      throw new Error('No stored OAuth state found - possible session timeout');
    }

    let storedStateData;
    try {
      storedStateData = JSON.parse(storedStateStr);
    } catch (parseError) {
      console.error('Failed to parse stored state:', parseError);
      throw new Error('Invalid stored OAuth state format');
    }

    const storedState = storedStateData.state;
    const stateTimestamp = storedStateData.timestamp;

    // Validate state match
    if (!storedState || storedState !== state) {
      throw new Error(
        'Invalid OAuth state - possible CSRF attack or expired session'
      );
    }

    // Check if state is too old (older than 10 minutes)
    const stateAgeMinutes = (Date.now() - stateTimestamp) / 60000;
    if (stateAgeMinutes > 10) {
      throw new Error('OAuth state expired - please try authenticating again');
    }

    sessionStorage.removeItem('oauth_state');

    const redirectUri = `${window.location.origin}${window.location.pathname}`;

    const tokenResponse = await fetch(`${AGENT_SWARM_API}/auth/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        state: state,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Token exchange failed: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();

    if (!tokenData.access_token) {
      throw new Error('No access token received');
    }

    // Add timestamp for expiration checking
    tokenData.timestamp = Date.now();

    storeToken(tokenData);

    // Clean up URL parameters
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);

    // Reset OAuth progress flag on success
    isOAuthInProgress = false;
    updateLoginButtonState(); // Update button appearance
    console.log('OAuth flow completed successfully');
  } catch (error) {
    console.error('OAuth callback handling failed:', error);
    addMessage(`Authentication failed: ${error.message}`, 'error');

    // Clean up URL parameters even on error
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);

    // Reset OAuth progress flag on error
    isOAuthInProgress = false;
    updateLoginButtonState(); // Update button appearance

    // Clear potentially corrupted state
    sessionStorage.removeItem('oauth_state');
  }
}

async function bootstrapAuth() {
  try {
    // Check for existing token
    const existingToken = getStoredToken();
    if (existingToken) {
      // Check if token is expired
      if (isTokenExpired()) {
        addMessage('Authentication token expired', 'system');
        clearToken();
        return;
      }

      if (googleLoginBtn) {
        googleLoginBtn.classList.add('hidden');
      }
      hideLoginPrompt();
      addMessage('Already authenticated', 'system');
      addMessage(`Bearer token: ${existingToken.access_token}`, 'system');
      return;
    }

    // Handle OAuth callback if present
    await handleOAuthCallback();
  } catch (error) {
    console.error('Auth bootstrap failed:', error);
    addMessage(
      `Authentication initialization failed: ${error.message}`,
      'error'
    );
  }
}

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

  // Cleanup RNNoise resources
  cleanupRNNoise();
}

// Update connection status and UI
function updateStatus(connected) {
  isConnected = connected;
  const appContainer = document.querySelector('.app-container');
  const tokenData = getStoredToken();
  const isAuthenticated = tokenData && tokenData.access_token;

  if (connected && isVadReady) {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = isAuthenticated
      ? 'Ready to listen (Authenticated)'
      : 'Ready to listen (Guest)';
    appContainer.classList.add('is-animating');

    // Show disconnect button, hide connect button
    disconnectBtn.classList.remove('hidden');
    connectBtn.classList.add('hidden');
  } else if (connected && !isVadReady) {
    statusIndicator.className = 'status-indicator connected';
    statusText.textContent = isAuthenticated
      ? 'Initializing voice detection... (Authenticated)'
      : 'Initializing voice detection... (Guest)';
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

// Stop current TTS audio playback and cleanup visual indicators
function stopCurrentAudio() {
  try {
    console.log('🎵 Stopping current audio playback');
    audioPlayer.stop();
    console.log('🎵 Current audio stopped and cleaned up');
  } catch (error) {
    console.error('Error stopping current audio:', error);
  }
}

// WebSocket connection management
function connectWebSocket() {
  if (isConnected) {
    console.log('Already connected.');
    return;
  }

  // Extract bearer token from localStorage (optional)
  const tokenData = getStoredToken();

  // Check if token is expired before using it
  if (tokenData && isTokenExpired()) {
    addMessage('Authentication token expired', 'system');
    clearToken();
    return;
  }

  const bearerToken =
    tokenData && tokenData.access_token ? tokenData.access_token : null;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let wsUrl = `${protocol}//${window.location.host}/ws`;

  // Include token parameter only if available
  if (bearerToken) {
    wsUrl += `?token=${encodeURIComponent(bearerToken)}`;
    console.log('Connecting with authentication token...');
  } else {
    console.log('Connecting as guest (no authentication token)...');
    addMessage(
      'Connecting as guest - some features may require authentication',
      'system'
    );
  }

  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    console.log('WebSocket connected');
    addMessage('Connected to websocket', 'system');

    // Send configuration to the server
    const sttEngine = document.getElementById('stt-engine-select').value;
    const ttsEngine = document.getElementById('tts-engine-select').value;
    const chatMode = chatModeSelect ? chatModeSelect.value : 'single';
    ws.send(
      JSON.stringify({
        type: 'config',
        sttEngine,
        ttsEngine,
        chatMode,
      })
    );
    addMessage(
      `Using STT: ${sttEngine}, TTS: ${ttsEngine}, Mode: ${chatMode}`,
      'system'
    );

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
        case 'agent':
          addMessage(`${data.message}`, 'agent');

          // Play TTS audio if available
          if (data.speechAudio) {
            // Defensive validation - prevent audio playback when disconnected
            if (!isConnected || isUserDisconnected) {
              console.log(
                '🎵 Skipping TTS audio playback - application is disconnected'
              );
              break;
            }

            try {
              // Mode detection - get current chat mode with fallback to 'single'
              const chatMode = chatModeSelect?.value || 'single';

              // Conditional routing based on chat mode
              if (chatMode === 'stream') {
                // Stream mode: handle raw PCM chunks (existing functionality)
                audioPlayer.enqueue(data.speechAudio);
              } else {
                // Single mode and others: handle MP3 decoding
                audioPlayer.playBase64Audio(data.speechAudio);
              }
            } catch (error) {
              console.error('Error routing audio data:', error);
              // Fallback to original method on error
              audioPlayer.enqueue(data.speechAudio);
            }
          }
          break;
        case 'auth_required':
          addMessage(`${data.message}`, 'system');
          clearToken(); // This will clear token and show login prompt
          break;
        case 'error':
          addMessage(`${data.message}`, 'error');
          // Check if error is authentication-related
          if (
            data.message &&
            (data.message.includes('401') ||
              data.message.includes('403') ||
              data.message.includes('Authentication failed') ||
              data.message.includes('Access forbidden') ||
              data.message.includes('Bearer token') ||
              data.message.includes('token expired') ||
              data.message.includes('authentication') ||
              data.message.includes('unauthorized'))
          ) {
            clearToken(); // This will clear token and show login prompt
          }
          break;
        case 'barge-in-ack':
          addMessage(`Barge-in acknowledged`, 'system');
          break;
        case 'agent-stream':
          handleAgentStream(data.delta);
          break;
        case 'audio-chunk':
          // Defensive validation - prevent audio playback when disconnected
          if (!isConnected || isUserDisconnected) {
            console.log(
              '🎵 Skipping stream audio playback - application is disconnected'
            );
            break;
          }
          audioPlayer.enqueue(data.data);
          break;
        case 'agent-stream-complete':
          completeAgentStream();
          break;
        default:
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

    // Stop any ongoing TTS audio playback
    stopCurrentAudio();

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

    // Stop any ongoing TTS audio playback
    stopCurrentAudio();

    addMessage('Voice detection stopped (connection error)', 'system');

    updateStatus(false);
  };
}

// Calculate RMS energy of audio buffer for pre-VAD gating
function calculateRMS(audioBuffer) {
  if (!audioBuffer || audioBuffer.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let i = 0; i < audioBuffer.length; i++) {
    sum += audioBuffer[i] * audioBuffer[i];
  }

  return Math.sqrt(sum / audioBuffer.length);
}

// Get dynamic RMS threshold based on TTS playing state
function getDynamicRMSThreshold() {
  // Increase threshold during TTS playback to prevent audio feedback loops
  return audioPlayer.isPlaying()
    ? RMS_ENERGY_THRESHOLD * 3
    : RMS_ENERGY_THRESHOLD;
}

// Log VAD statistics for monitoring and tuning
function logVADStats() {
  console.table({
    'False Starts': vadDebugCounters.falseStarts,
    'True Starts': vadDebugCounters.trueStarts,
    'Gate Drops': vadDebugCounters.gateDrops,
    'False Trigger Rate':
      vadDebugCounters.trueStarts > 0
        ? (
            (vadDebugCounters.falseStarts /
              (vadDebugCounters.falseStarts + vadDebugCounters.trueStarts)) *
            100
          ).toFixed(1) + '%'
        : 'N/A',
  });
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

    // Initialize RNNoise after VAD setup
    if (isNoiseReductionEnabled) {
      await initializeRNNoise();
    }

    // Try multiple configurations for better compatibility
    const vadConfigs = [
      {
        model: 'v5',
        ...DEFAULT_VAD_TUNING,
        userSpeakingThreshold: 0.4,
        preSpeechPadFrames: 2,
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
            vadDebugCounters.trueStarts++;

            // Implement barge-in: stop current TTS audio when user starts speaking
            if (audioPlayer.isPlaying()) {
              console.log('🎤 User barge-in detected - stopping TTS audio');
              stopCurrentAudio();

              // Send barge-in message to server
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'barge-in' }));
                console.log('📤 Sent barge-in message to server');
              }
            }

            updateStatus(isConnected);
          },
          onSpeechEnd: async (audio) => {
            console.log('Speech ended, audio length:', audio.length);
            updateStatus(isConnected);

            // Apply RMS energy gate before processing with dynamic threshold
            const rmsEnergy = calculateRMS(audio);
            const dynamicThreshold = getDynamicRMSThreshold();
            console.log(
              'Audio RMS energy:',
              rmsEnergy.toFixed(4),
              'Threshold:',
              dynamicThreshold.toFixed(4)
            );

            if (rmsEnergy < dynamicThreshold) {
              console.log('Audio dropped by RMS energy gate (too quiet)');
              vadDebugCounters.gateDrops++;
              return; // Skip processing low-energy audio
            }

            if (ws && ws.readyState === WebSocket.OPEN) {
              // Step 1: Gather context information
              const datetime = getCurrentDateTime();
              const timezone = getClientTimezone();
              const clientDatetime = getClientDateTime();

              const context = {
                datetime: datetime.readable,
                timezone: timezone,
                clientDatetime: clientDatetime,
              };

              // Step 2: Send context first
              console.log('📍 Sending context:', context);
              ws.send(
                JSON.stringify({
                  type: 'audio-context',
                  context: context,
                })
              );

              // Step 2.5: Apply noise reduction if enabled and available
              let processedAudio = audio;
              if (isNoiseReductionEnabled && rnnoiseModule && rnnoiseState) {
                try {
                  processedAudio = await denoiseAudio(audio);
                  console.log('Applied noise reduction to audio');
                } catch (error) {
                  console.warn(
                    'Noise reduction failed, using original audio:',
                    error
                  );
                  processedAudio = audio;
                }
              }

              // Step 3: Convert to 16-bit PCM and send audio data.
              // This reduces payload size by 50% compared to Float32.
              const int16Array = new Int16Array(processedAudio.length);
              for (let i = 0; i < processedAudio.length; i++) {
                const s = Math.max(-1, Math.min(1, processedAudio[i]));
                int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
              }

              console.log(
                'Sending audio data as Int16:',
                int16Array.byteLength,
                'bytes'
              );
              ws.send(int16Array.buffer);
              addMessage(
                `Audio sent (${processedAudio.length} samples as 16-bit PCM${isNoiseReductionEnabled && rnnoiseModule ? ' with noise reduction' : ''})`,
                'system'
              );

              // Show context info to user
              addMessage(
                `📍 Context: ${context.datetime} (${context.timezone})`,
                'system'
              );
            } else {
              addMessage('Not connected to server', 'error');
            }
          },
          onVADMisfire: () => {
            console.log('VAD misfire');
            vadDebugCounters.falseStarts++;
            updateStatus(isConnected);
          },
          ...config,
        });

        console.log(`VAD initialized successfully with ${config.model} model`);
        addMessage(`Voice detection ready (${config.model} model)`, 'system');
        vadInitialized = true;
        isVadReady = true;

        // Set up periodic VAD statistics logging for monitoring
        setInterval(logVADStats, 30000); // Log stats every 30 seconds

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

    // Stop any ongoing TTS audio playback immediately
    stopCurrentAudio();

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

  // Add Google login button event listener
  if (googleLoginBtn) {
    googleLoginBtn.addEventListener('click', (e) => {
      // Prevent default and multiple clicks during OAuth
      e.preventDefault();
      if (isOAuthInProgress) {
        return;
      }
      loginWithGoogle();
    });
  }

  // Add event listeners for engine selection changes
  const sttEngineSelect = document.getElementById('stt-engine-select');
  const ttsEngineSelect = document.getElementById('tts-engine-select');

  const sendConfig = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const sttEngine = sttEngineSelect.value;
      const ttsEngine = ttsEngineSelect.value;
      const chatMode = chatModeSelect ? chatModeSelect.value : 'single';
      ws.send(
        JSON.stringify({
          type: 'config',
          sttEngine,
          ttsEngine,
          chatMode,
          noiseReduction: isNoiseReductionEnabled,
        })
      );
      addMessage(
        `Configuration updated - STT: ${sttEngine}, TTS: ${ttsEngine}, Mode: ${chatMode}, Noise Reduction: '${
          isNoiseReductionEnabled ? 'ON' : 'OFF'
        }'`,
        'system'
      );
    }
  };

  sttEngineSelect.addEventListener('change', sendConfig);
  ttsEngineSelect.addEventListener('change', sendConfig);

  // Add event listener for chat mode selector
  if (chatModeSelect) {
    chatModeSelect.addEventListener('change', sendConfig);
  }
}

// Initialize everything when DOM is loaded
window.addEventListener('DOMContentLoaded', async () => {
  configureONNXRuntime();
  setupAudioPlayerCallbacks();
  setupEventListeners();
  await bootstrapAuth();
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

// Setup AudioPlayer event callbacks
function setupAudioPlayerCallbacks() {
  // Set up callback to add speaking indicator when audio starts
  audioPlayer.onStart = () => {
    const agentMessages = document.querySelectorAll('.message.agent');
    const lastAgentMessage = agentMessages[agentMessages.length - 1];
    if (lastAgentMessage) {
      lastAgentMessage.classList.add('speaking');
    }
  };

  // Set up callback to remove speaking indicator when audio finishes
  audioPlayer.onFinish = () => {
    const speakingMessages = document.querySelectorAll(
      '.message.agent.speaking'
    );
    speakingMessages.forEach((msg) => {
      msg.classList.remove('speaking');
    });
  };

  // Set up callback for barge-in and disconnect scenarios
  audioPlayer.onCancel = () => {
    const speakingMessages = document.querySelectorAll(
      '.message.agent.speaking'
    );
    speakingMessages.forEach((msg) => {
      msg.classList.remove('speaking');
    });
  };
}

// Add timeout mechanism for OAuth flow
function setOAuthTimeout() {
  // Set a timeout to reset OAuth flag if flow doesn't complete within 5 minutes
  setTimeout(
    () => {
      if (isOAuthInProgress) {
        console.warn('OAuth flow timeout - resetting flag');
        isOAuthInProgress = false;
        updateLoginButtonState(); // Update button appearance
        addMessage('Authentication timeout - please try again', 'system');
      }
    },
    5 * 60 * 1000
  ); // 5 minutes
}

// Update login button state based on OAuth progress
function updateLoginButtonState() {
  const loginBtns = document.querySelectorAll(
    '.google-login-btn, .dynamic-login-btn'
  );
  loginBtns.forEach((btn) => {
    if (isOAuthInProgress) {
      btn.disabled = true;
      btn.textContent = 'Authenticating...';
      btn.style.opacity = '0.6';
      btn.style.cursor = 'not-allowed';
    } else {
      btn.disabled = false;
      btn.innerHTML = `
        <svg class="google-icon" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Sign in with Google
      `;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
    }
  });
}

// RNNoise Helper Functions

// Initialize RNNoise WASM module
async function initializeRNNoise() {
  try {
    console.log('Initializing RNNoise...');
    addMessage('Loading noise reduction module...', 'system');

    // Load the RNNoise WASM module with proper error handling
    try {
      rnnoiseModule = await createRNNWasmModule();
      await rnnoiseModule.ready;
    } catch (moduleError) {
      console.warn('RNNoise WASM module failed to load:', moduleError);
      addMessage(
        'Noise reduction not available - continuing without it',
        'system'
      );
      return;
    }

    // Initialize RNNoise
    rnnoiseModule._rnnoise_init();

    // Create noise reduction state
    rnnoiseState = rnnoiseModule._rnnoise_create();
    if (!rnnoiseState) {
      throw new Error('Failed to create RNNoise state');
    }

    // Allocate persistent input/output buffers (480 samples * 4 bytes per Float32)
    const bufferSize = 480 * 4;
    inputBuffer = rnnoiseModule._malloc(bufferSize);
    outputBuffer = rnnoiseModule._malloc(bufferSize);

    if (!inputBuffer || !outputBuffer) {
      throw new Error('Failed to allocate RNNoise buffers');
    }

    console.log('RNNoise initialized successfully');
    addMessage('Noise reduction ready', 'system');
  } catch (error) {
    console.warn('RNNoise initialization failed:', error);
    addMessage(`Noise reduction unavailable: ${error.message}`, 'system');

    // Cleanup on failure
    cleanupRNNoise();
  }
}

// Process audio through RNNoise noise reduction
async function denoiseAudio(audioBuffer) {
  if (!rnnoiseModule || !rnnoiseState || !inputBuffer || !outputBuffer) {
    console.warn('RNNoise not available, returning original audio');
    return audioBuffer;
  }

  try {
    const frameSize = 480; // RNNoise requires 480 samples per frame
    const numFrames = Math.ceil(audioBuffer.length / frameSize);
    const denoisedBuffer = new Float32Array(audioBuffer.length);

    let outputIndex = 0;

    for (let i = 0; i < numFrames; i++) {
      const startIndex = i * frameSize;
      const endIndex = Math.min(startIndex + frameSize, audioBuffer.length);
      const frameLength = endIndex - startIndex;

      // Create frame with padding if necessary
      const frame = new Float32Array(frameSize);
      for (let j = 0; j < frameLength; j++) {
        frame[j] = audioBuffer[startIndex + j];
      }
      // Remaining samples are already zero-padded

      // Process frame through RNNoise
      const processedFrame = await processFrame(frame);

      // Copy processed samples to output buffer
      for (let j = 0; j < frameLength; j++) {
        denoisedBuffer[outputIndex++] = processedFrame[j];
      }
    }

    return denoisedBuffer;
  } catch (error) {
    console.error('Error during noise reduction:', error);
    return audioBuffer; // Return original audio on error
  }
}

// Process a single 480-sample frame through RNNoise
async function processFrame(inputSamples) {
  if (!rnnoiseModule || !rnnoiseState || !inputBuffer || !outputBuffer) {
    return inputSamples;
  }

  try {
    // Copy input samples to WASM memory
    const inputHeap = new Float32Array(
      rnnoiseModule.HEAPF32.buffer,
      inputBuffer,
      480
    );
    inputHeap.set(inputSamples);

    // Process frame
    rnnoiseModule._rnnoise_process_frame(
      rnnoiseState,
      outputBuffer,
      inputBuffer
    );

    // Copy output samples from WASM memory
    const outputHeap = new Float32Array(
      rnnoiseModule.HEAPF32.buffer,
      outputBuffer,
      480
    );
    return new Float32Array(outputHeap);
  } catch (error) {
    console.error('Error processing frame:', error);
    return inputSamples; // Return original frame on error
  }
}

// Cleanup RNNoise resources
function cleanupRNNoise() {
  try {
    if (rnnoiseModule) {
      if (rnnoiseState) {
        rnnoiseModule._rnnoise_destroy(rnnoiseState);
        rnnoiseState = null;
      }

      if (inputBuffer) {
        rnnoiseModule._free(inputBuffer);
        inputBuffer = null;
      }

      if (outputBuffer) {
        rnnoiseModule._free(outputBuffer);
        outputBuffer = null;
      }
    }

    console.log('RNNoise resources cleaned up');
  } catch (error) {
    console.error('Error cleaning up RNNoise:', error);
  }
}

// Streaming Text Functions

// Handle incoming agent stream chunks
function handleAgentStream(delta) {
  try {
    if (!activeStreamMsg.domEl) {
      // First chunk - create a new streaming message
      activeStreamMsg.text = delta;
      activeStreamMsg.domEl = createStreamingMessage(delta);
      messagesEl.appendChild(activeStreamMsg.domEl);
    } else {
      // Subsequent chunks - update existing message
      activeStreamMsg.text += delta;
      const contentSpan = activeStreamMsg.domEl.querySelector('.content');
      if (contentSpan) {
        contentSpan.textContent = activeStreamMsg.text;
      }
    }

    // Auto-scroll to bottom to show the latest content
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  } catch (error) {
    console.error('Error handling agent stream:', error);
  }
}

// Create a streaming message DOM element
function createStreamingMessage(initialText) {
  const messageEl = document.createElement('div');
  messageEl.className = 'message agent';

  messageEl.innerHTML = `
    <span class="content">${initialText}</span>
    <span class="timestamp">${new Date().toLocaleTimeString()}</span>
  `;

  return messageEl;
}

// Complete the agent stream and reset state
function completeAgentStream() {
  try {
    if (activeStreamMsg.domEl) {
      console.log('🎯 Agent stream completed');

      // Reset streaming state
      activeStreamMsg = {
        text: '',
        domEl: null,
      };
    }
  } catch (error) {
    console.error('Error completing agent stream:', error);
  }
}

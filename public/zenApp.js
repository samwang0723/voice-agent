import AudioPlayer from './audioPlayer.js';

// Configuration constants
const ONNX_CONFIG = {
  wasmPaths: 'https://unpkg.com/onnxruntime-web@1.14.0/dist/',
  numThreads: 1,
  simd: false,
  proxy: false,
  executionProviders: ['cpu'],
  logLevel: 'error',
};

// Simple EventEmitter implementation for module communication
class EventEmitter {
  constructor() {
    this.events = {};
  }

  on(event, listener) {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(listener);
  }

  emit(event, ...args) {
    if (this.events[event]) {
      this.events[event].forEach((listener) => {
        try {
          listener(...args);
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error);
        }
      });
    }
  }

  off(event, listenerToRemove) {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter(
      (listener) => listener !== listenerToRemove
    );
  }

  once(event, listener) {
    const onceWrapper = (...args) => {
      this.off(event, onceWrapper);
      listener(...args);
    };
    this.on(event, onceWrapper);
  }
}

/**
 * ZenApp - Main application orchestrator
 * Coordinates all modules and manages application lifecycle
 */
class ZenApp extends EventEmitter {
  constructor() {
    super();

    // Module instances
    this.auth = null;
    this.transport = null;
    this.vad = null;
    this.ui = null;
    this.audioPlayer = null;

    // Application state
    this.isInitialized = false;
    this.isMobile = false;
    this.isConnected = false;
    this.isListening = false;
    this.isVadReady = false;
    this.isAuthenticated = false;

    // Initialization promise to prevent multiple init calls
    this.initPromise = null;
  }

  /**
   * Initialize the application
   */
  async initialize() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._doInitialize();
    return this.initPromise;
  }

  async _doInitialize() {
    try {
      console.log('🚀 ZenApp: Starting initialization...');

      // Step 1: Configure ONNX Runtime for maximum compatibility
      this._configureONNXRuntime();

      // Step 2: Detect mobile devices
      this.isMobile = this._detectMobileBrowser();
      console.log('📱 Mobile device detected:', this.isMobile);

      // Step 3: Check browser compatibility
      if (!this._checkBrowserCompatibility()) {
        throw new Error('Browser compatibility check failed');
      }

      // Step 4: Initialize AudioPlayer
      this.audioPlayer = new AudioPlayer();
      this._setupAudioPlayerCallbacks();

      // Step 5: Initialize modules (these will be imported dynamically)
      await this._initializeModules();

      // Step 6: Bootstrap authentication
      await this._bootstrapAuthentication();

      // Step 7: Setup event listeners
      this._setupEventListeners();

      // Step 8: auto-initialize VAD, for faster startup
      await this._initializeVAD();

      // Step 9: Don't auto-connect, wait for user interaction
      // await this._connectAndStart();

      this.isInitialized = true;
      this.emit('initialized');

      console.log('✅ ZenApp: Initialization complete');
    } catch (error) {
      console.error('❌ ZenApp: Initialization failed:', error);
      this.emit('initializationError', error);
      throw error;
    }
  }

  /**
   * Configure ONNX Runtime for maximum browser compatibility
   */
  _configureONNXRuntime() {
    if (typeof ort !== 'undefined') {
      Object.assign(ort.env.wasm, ONNX_CONFIG);
      ort.env.executionProviders = ONNX_CONFIG.executionProviders;
      ort.env.logLevel = ONNX_CONFIG.logLevel;
      console.log('🧠 ONNX Runtime configured for compatibility mode');
    } else {
      console.warn('⚠️ ONNX Runtime not available');
    }
  }

  /**
   * Detect if running on a mobile browser
   */
  _detectMobileBrowser() {
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    const mobileRegex =
      /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
    const isMobileUA = mobileRegex.test(userAgent.toLowerCase());
    const hasTouchScreen =
      'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;
    const isAndroid = /Android/.test(userAgent);

    return isMobileUA || hasTouchScreen || isIOS || isAndroid;
  }

  /**
   * Check browser compatibility
   */
  _checkBrowserCompatibility() {
    const required = {
      webAssembly: typeof WebAssembly !== 'undefined',
      audioContext:
        typeof AudioContext !== 'undefined' ||
        typeof webkitAudioContext !== 'undefined',
      mediaDevices:
        navigator.mediaDevices && navigator.mediaDevices.getUserMedia,
      webWorkers: typeof Worker !== 'undefined',
      webSockets: typeof WebSocket !== 'undefined',
      requestAnimationFrame: typeof requestAnimationFrame !== 'undefined',
    };

    const missing = Object.entries(required)
      .filter(([_, supported]) => !supported)
      .map(([feature, _]) => feature);

    if (missing.length > 0) {
      console.error('❌ Browser missing features:', missing);
      this.emit('browserIncompatible', missing);
      return false;
    }

    console.log('✅ Browser compatibility check passed');
    return true;
  }

  /**
   * Initialize all modules
   */
  async _initializeModules() {
    try {
      // Dynamic imports for modules - import singleton instances
      const [
        { default: authModule },
        { default: transportModule },
        { default: vadModule },
        { default: uiModule },
      ] = await Promise.all([
        import('./auth.js').catch(() => ({
          default: this._createMockAuthInstance(),
        })),
        import('./transport.js').catch(() => ({
          default: this._createMockTransportInstance(),
        })),
        import('./vad.js').catch(() => ({
          default: this._createMockVADInstance(),
        })),
        import('./ui.js').catch(() => ({
          default: this._createMockUIInstance(),
        })),
      ]);

      // Use the imported singleton instances directly
      this.auth = authModule;
      this.transport = transportModule;
      this.vad = vadModule;
      this.ui = uiModule;

      // Setup inter-module communication
      this._setupModuleCommunication();

      console.log('📦 All modules initialized');
    } catch (error) {
      console.error('❌ Module initialization failed:', error);
      throw error;
    }
  }

  /**
   * Setup communication between modules
   */
  _setupModuleCommunication() {
    // Auth events
    this.auth.on('authenticated', (event) => {
      this.isAuthenticated = true;
      this.ui.hideLoginScreen();
      this.ui.showMainInterface();

      // Show authentication success message
      if (
        event.detail &&
        event.detail.tokenData &&
        event.detail.tokenData.access_token
      ) {
        this.ui.showMessage('Authentication successful', 'system');
        // Only show first 20 characters of token for security
        const tokenPreview =
          event.detail.tokenData.access_token.substring(0, 20) + '...';
        this.ui.showMessage(`Bearer token: ${tokenPreview}`, 'system');
      }

      this.emit('authStateChanged', true);
    });

    this.auth.on('authenticationFailed', (event) => {
      this.isAuthenticated = false;
      this.ui.showLoginScreen();
      this.ui.showError(`Authentication failed: ${event.detail.message}`);
      this.emit('authStateChanged', false);
    });

    this.auth.on('logout', () => {
      this.isAuthenticated = false;
      this.ui.showLoginScreen();
      this.transport.clearBearerToken(); // Clear stored token
      this.transport.disconnect();
      this.emit('authStateChanged', false);
    });

    // Transport events
    this.transport.on('connected', (event) => {
      this.isConnected = true;
      this.ui.updateConnectionStatus(true, event.detail.authenticated);
      this.ui.updateOrbState('connected'); // Update orb to show connected state
      this.emit('connectionStateChanged', true);

      // Send initial configuration to the server
      const settings = this.ui.getSettings();
      this.transport.sendConfig(settings);

      // Don't auto-start listening
      // this._checkAutoStartListening();
    });

    this.transport.on('disconnected', () => {
      this.isConnected = false;
      this.isListening = false;
      this.ui.updateConnectionStatus(false);
      this.ui.updateListeningState(false);
      this.ui.updateOrbState('disconnected'); // Update orb to show disconnected state
      this.vad.stopListening();
      this.audioPlayer.stop();
      this.emit('connectionStateChanged', false);
    });

    this.transport.on('message', (event) => {
      // The transport module already sends the message type and data in detail
      this._handleTransportMessage(event.detail);
    });

    this.transport.on('error', (event) => {
      this.ui.showError(
        `Connection error: ${event.detail.message || 'Unknown error'}`
      );
    });

    // VAD events
    this.vad.on('vadReady', () => {
      this.isVadReady = true;
      this.ui.updateVADStatus(true);
      this.emit('vadStateChanged', true);
      // Don't auto-start listening
      // this._checkAutoStartListening();
    });

    this.vad.on('speechStart', () => {
      this.ui.updateOrbState('listening');
      // Implement barge-in
      if (this.audioPlayer.isPlaying()) {
        this.audioPlayer.stop();
        this.transport.sendBargeIn();
      }
    });

    this.vad.on('vadMisfire', () => {
      console.log('VAD misfire detected, resetting orb state.');
      this.ui.updateOrbState('idle');
    });

    this.vad.on('audioProcessed', (event) => {
      this.ui.updateOrbState('processing');

      // Send context first if available
      if (event.detail.context) {
        this.transport.sendAudioContext(event.detail.context);

        // Show context info to user
        this.ui.showMessage(
          `📍 Context: ${event.detail.context.datetime} (${event.detail.context.timezone})`,
          'system'
        );
      }

      // Send audio data
      this.transport.sendAudio(event.detail.audioData);

      // Show audio sent message
      const noiseReduction = event.detail.hasNoiseReduction
        ? ' with noise reduction'
        : '';
      this.ui.showMessage(
        `Audio sent (${event.detail.originalLength} samples as 16-bit PCM${noiseReduction})`,
        'system'
      );
    });

    this.vad.on('vadStatus', (event) => {
      if (event.detail.type === 'error') {
        this.isVadReady = false;
        this.ui.updateVADStatus(false);
        this.ui.showError(event.detail.message);
        this.emit('vadStateChanged', false);
      }
    });

    // UI events - some are dispatched on document
    document.addEventListener('loginRequested', () => {
      this.auth.loginWithGoogle();
    });

    document.addEventListener('logoutRequested', () => {
      this.auth.clearToken();
      this.ui.showMessage('Logged out successfully', 'system');
    });

    document.addEventListener('orbClick', () => {
      this._toggleListening();
    });

    // Settings listeners
    this.ui.setupSettingsListeners((settings) => {
      this.transport.sendConfig(settings);
    });

    // Test audio button
    this.ui.setupTestAudioButton(() => {
      this._testAudio();
    });

    // Additional UI events if needed
    this.ui.on('connectRequested', () => {
      this._connect();
    });

    this.ui.on('disconnectRequested', () => {
      this._disconnect();
    });

    this.ui.on('clearRequested', () => {
      this.ui.clearTranscript();
    });
  }

  /**
   * Setup AudioPlayer callbacks for orb animation and audio unlock
   */
  _setupAudioPlayerCallbacks() {
    this.audioPlayer.onStart = () => {
      this.ui.updateOrbState('speaking');
      this.ui.addSpeakingIndicator();
    };

    this.audioPlayer.onFinish = () => {
      this.ui.updateOrbState('idle');
      this.ui.removeSpeakingIndicator();
    };

    this.audioPlayer.onCancel = () => {
      this.ui.updateOrbState('idle');
      this.ui.removeSpeakingIndicator();
    };

    this.audioPlayer.onAutoplayBlocked = () => {
      this.ui.showAudioUnlockPrompt();
    };
  }

  /**
   * Bootstrap authentication
   */
  async _bootstrapAuthentication() {
    try {
      console.log('🔐 Bootstrapping authentication...');
      const isAuthenticated = await this.auth.bootstrap();
      this.isAuthenticated = isAuthenticated;

      const token = this.auth.getToken();
      console.log(
        '🔑 Token after bootstrap:',
        token ? `${token.substring(0, 20)}...` : 'null'
      );

      if (isAuthenticated) {
        // If already authenticated, show main interface directly
        this.ui.hideLoginScreen();
        this.ui.showMainInterface();
        this.ui.showMessage('Already authenticated', 'system');
      } else {
        // Only show login screen if not authenticated
        this.ui.showLoginScreen();
      }

      this.emit('authStateChanged', isAuthenticated);
    } catch (error) {
      console.error('❌ Authentication bootstrap failed:', error);
      this.ui.showLoginScreen();
      this.ui.showError('Authentication initialization failed');
    }
  }

  /**
   * Setup global event listeners
   */
  _setupEventListeners() {
    // Handle page visibility changes
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        // Page is hidden - pause listening
        if (this.isListening) {
          this.vad.pauseListening();
        }
      } else {
        // Page is visible - resume listening
        if (this.isConnected && this.isVadReady && this.isListening) {
          this.vad.resumeListening();
        }
      }
    });

    // Handle beforeunload for cleanup
    window.addEventListener('beforeunload', () => {
      this._cleanup();
    });

    // Handle errors
    window.addEventListener('error', (event) => {
      console.error('Global error:', event.error);
      this.ui.showError('An unexpected error occurred');
    });

    // Handle unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      console.error('Unhandled promise rejection:', event.reason);
      this.ui.showError('An unexpected error occurred');
    });
  }

  /**
   * Initialize VAD
   */
  async _initializeVAD() {
    try {
      await this.vad.initializeVAD();
      console.log('🎤 VAD initialized successfully');
    } catch (error) {
      console.error('❌ VAD initialization failed:', error);
      this.ui.showError('Voice detection initialization failed');
    }
  }

  /**
   * Connect WebSocket and start listening
   */
  async _connectAndStart() {
    try {
      await this.transport.connect({ bearerToken: this.auth.getToken() });
      console.log('🔌 WebSocket connected');
    } catch (error) {
      console.error('❌ WebSocket connection failed:', error);
      this.ui.showError('Failed to connect to server');
    }
  }

  /**
   * Check if conditions are met to auto-start listening
   */
  _checkAutoStartListening() {
    if (this.isConnected && this.isVadReady && !this.isListening) {
      console.log('🎯 Auto-starting listening - all conditions met');
      this._startListening();
    }
  }

  /**
   * Start listening
   */
  async _startListening() {
    if (!this.isConnected) {
      this.ui.showError('Cannot start listening - not connected');
      return false;
    }

    if (!this.isVadReady) {
      this.ui.showError('Voice detection not ready');
      return false;
    }

    try {
      await this.vad.startListening();
      this.isListening = true;
      this.ui.updateListeningState(true);
      this.ui.updateOrbState('idle');
      return true;
    } catch (error) {
      console.error('❌ Failed to start listening:', error);
      this.ui.showError(`Failed to start listening: ${error.message}`);
      return false;
    }
  }

  /**
   * Stop listening
   */
  _stopListening() {
    // Stop VAD and release microphone
    if (this.vad) {
      this.vad.stopListening();
    }

    // Stop any ongoing TTS audio playback
    if (this.audioPlayer) {
      this.audioPlayer.stop();
    }

    // Disconnect from server
    if (this.transport && this.isConnected) {
      this.transport.disconnect();
    }

    // Update state
    this.isListening = false;
    this.isVadReady = false; // Will need to reinitialize VAD

    // Update UI
    this.ui.updateListeningState(false);
    this.ui.updateOrbState('idle');
    this.ui.showMessage('Voice detection stopped', 'system');
  }

  /**
   * Toggle listening state
   */
  async _toggleListening() {
    if (this.isListening) {
      this._stopListening();
    } else {
      // First, ensure audio is unlocked. This is a great place for it.
      if (!this.audioPlayer.audioUnlocked) {
        try {
          const unlocked = await this.audioPlayer.unlock();
          if (unlocked) {
            this.ui.showMessage('Audio enabled successfully', 'system');
            this.ui.updateTestAudioButton(true);
          } else {
            // It might fail if the user gesture wasn't "trusted".
            this.ui.showError(
              'Could not enable audio. Please click the orb again.'
            );
            return;
          }
        } catch (error) {
          console.error('Error unlocking audio:', error);
          this.ui.showError('Failed to enable audio.');
          return;
        }
      }

      // Initialize VAD if not ready
      if (!this.isVadReady) {
        this.ui.showMessage('Initializing voice detection...', 'info');
        try {
          await this.vad.initializeVAD();
          // Wait a bit for VAD to be fully ready
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (error) {
          console.error('❌ Failed to initialize VAD:', error);
          this.ui.showError('Failed to initialize voice detection');
          return;
        }
      }

      // Connect first if not connected
      if (!this.isConnected) {
        this.ui.showMessage('Connecting...', 'info');
        try {
          const token = this.auth.getToken();
          console.log(
            '🔑 Got token for connection:',
            token ? `${token.substring(0, 20)}...` : 'null'
          );
          await this.transport.connect({ bearerToken: token });
          // Wait a bit for connection to stabilize
          await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (error) {
          console.error('Failed to connect:', error);
          this.ui.showError('Failed to connect to server');
          return;
        }
      }

      await this._startListening();
    }
  }

  /**
   * Connect to server
   */
  async _connect() {
    if (this.isConnected) {
      this.ui.showMessage('Already connected', 'info');
      return;
    }

    try {
      this.ui.showMessage('Connecting...', 'info');
      const token = this.auth.getToken();
      console.log(
        '🔑 Got token for connection:',
        token ? `${token.substring(0, 20)}...` : 'null'
      );
      await this.transport.connect({ bearerToken: token });
    } catch (error) {
      console.error('❌ Connection failed:', error);
      this.ui.showError('Failed to connect to server');
    }
  }

  /**
   * Disconnect from server
   */
  _disconnect() {
    if (!this.isConnected) {
      this.ui.showMessage('Not connected', 'info');
      return;
    }

    this._stopListening();
    this.audioPlayer.stop();
    this.transport.disconnect();
    this.ui.showMessage('Disconnected', 'info');
  }

  /**
   * Test audio functionality
   */
  async _testAudio() {
    try {
      const unlocked = await this.audioPlayer.unlock();
      if (unlocked) {
        this.ui.showMessage('Audio enabled successfully', 'success');
        this._playTestTone();
      } else {
        this.ui.showError('Failed to enable audio');
      }
    } catch (error) {
      console.error('❌ Audio test failed:', error);
      this.ui.showError(`Audio test failed: ${error.message}`);
    }
  }

  /**
   * Play a test tone
   */
  _playTestTone() {
    try {
      if (!this.audioPlayer.audioContext) {
        console.warn('AudioContext not available for test tone');
        return;
      }

      const context = this.audioPlayer.audioContext;
      const oscillator = context.createOscillator();
      const gainNode = context.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(context.destination);

      oscillator.frequency.value = 440; // A4 note
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0, context.currentTime);
      gainNode.gain.linearRampToValueAtTime(0.2, context.currentTime + 0.1);
      gainNode.gain.linearRampToValueAtTime(0, context.currentTime + 0.5);

      oscillator.start(context.currentTime);
      oscillator.stop(context.currentTime + 0.5);

      this.ui.showMessage('Test tone played 🔊', 'success');
    } catch (error) {
      console.error('Failed to play test tone:', error);
    }
  }

  /**
   * Handle transport messages
   */
  _handleTransportMessage(eventData) {
    // Extract the actual data from the event detail
    const data = eventData.data || eventData;

    switch (data.type) {
      case 'connected':
        this.ui.showMessage(data.message || 'Connected', 'success');
        break;

      case 'transcript':
        if (data.transcript) {
          this.ui.addTranscriptLine(data.transcript, 'user');
        }
        break;

      case 'agent':
        if (data.message) {
          this.ui.addTranscriptLine(data.message, 'agent');
        }
        if (data.speechAudio) {
          this._handleAudioPlayback(data.speechAudio, data.chatMode);
        }
        break;

      case 'agent-stream':
        if (data.delta) {
          this.ui.updateStreamingMessage(data.delta);
        }
        break;

      case 'agent-stream-complete':
        this.ui.completeStreamingMessage();
        break;

      case 'audio-chunk':
        if (this.isConnected && data.data) {
          this.audioPlayer.enqueue(data.data);
        }
        break;

      case 'auth_required':
        this.ui.showMessage(
          data.message || 'Authentication required',
          'warning'
        );
        this.auth.clearToken();
        this.transport.clearBearerToken(); // Clear stored token
        break;

      case 'error':
        this.ui.showError(data.message || 'An error occurred');
        if (data.message && this._isAuthError(data.message)) {
          this.auth.clearToken();
          this.transport.clearBearerToken(); // Clear stored token
        }
        break;

      case 'barge-in-ack':
        this.ui.showMessage('Barge-in acknowledged', 'info');
        break;

      default:
        this.ui.showMessage(data.message || 'Unknown message', 'info');
    }
  }

  /**
   * Handle audio playback based on chat mode
   */
  async _handleAudioPlayback(speechAudio, chatMode) {
    if (!this.isConnected) {
      console.log('🎵 Skipping audio playback - disconnected');
      return;
    }

    try {
      if (!this.audioPlayer.audioUnlocked) {
        await this.audioPlayer.unlock();
      }

      if (chatMode === 'stream') {
        this.audioPlayer.enqueue(speechAudio);
      } else {
        this.audioPlayer.playBase64Audio(speechAudio);
      }
    } catch (error) {
      console.error('Audio playback error:', error);
      if (error.message.includes('user gesture')) {
        this.ui.showAudioUnlockPrompt();
      }
    }
  }

  /**
   * Check if error is authentication-related
   */
  _isAuthError(message) {
    const authKeywords = [
      '401',
      '403',
      'Authentication failed',
      'Access forbidden',
      'Bearer token',
      'token expired',
      'authentication',
      'unauthorized',
    ];
    return authKeywords.some((keyword) =>
      message.toLowerCase().includes(keyword.toLowerCase())
    );
  }

  /**
   * Cleanup resources
   */
  _cleanup() {
    try {
      if (this.vad) {
        this.vad.destroy();
      }
      if (this.audioPlayer) {
        this.audioPlayer.stop();
      }
      if (this.transport) {
        this.transport.disconnect();
      }
      console.log('🧹 Cleanup completed');
    } catch (error) {
      console.error('❌ Cleanup error:', error);
    }
  }

  /**
   * Get application state
   */
  getState() {
    return {
      isInitialized: this.isInitialized,
      isMobile: this.isMobile,
      isConnected: this.isConnected,
      isListening: this.isListening,
      isVadReady: this.isVadReady,
      isAuthenticated: this.isAuthenticated,
      audioState: this.audioPlayer?.getState(),
    };
  }

  // Mock implementations for modules that don't exist yet
  _createMockAuthInstance() {
    class MockAuth extends EventEmitter {
      constructor() {
        super();
        this.token = null;
      }
      async bootstrap() {
        return false;
      }
      async loginWithGoogle() {
        this.emit('authenticationFailed', {
          message: 'Mock auth not implemented',
        });
      }
      getToken() {
        return this.token;
      }
      clearToken() {
        this.token = null;
        this.emit('logout');
      }
    }
    return new MockAuth();
  }

  _createMockTransportInstance() {
    class MockTransport extends EventEmitter {
      constructor() {
        super();
        this.connected = false;
      }
      async connect() {
        this.connected = true;
        this.emit('connected');
      }
      disconnect() {
        this.connected = false;
        this.emit('disconnected');
      }
      sendConfig() {}
      sendAudio() {}
      sendBargeIn() {}
      isConnected() {
        return this.connected;
      }
    }
    return new MockTransport();
  }

  _createMockVADInstance() {
    class MockVAD extends EventEmitter {
      constructor() {
        super();
        this.ready = false;
      }
      async initializeVAD() {
        this.ready = true;
        this.emit('ready');
      }
      async startListening() {}
      stopListening() {}
      pauseListening() {}
      resumeListening() {}
      destroy() {}
      isReady() {
        return this.ready;
      }
    }
    return new MockVAD();
  }

  _createMockUIInstance() {
    class MockUI extends EventEmitter {
      showLoginScreen() {
        console.log('UI: Show login screen');
      }
      hideLoginScreen() {
        console.log('UI: Hide login screen');
      }
      showMainInterface() {
        console.log('UI: Show main interface');
      }
      updateConnectionStatus() {
        console.log('UI: Update connection status');
      }
      updateListeningState() {
        console.log('UI: Update listening state');
      }
      updateVADStatus() {
        console.log('UI: Update VAD status');
      }
      updateOrbState() {
        console.log('UI: Update orb state');
      }
      addTranscriptLine() {
        console.log('UI: Add transcript line');
      }
      updateStreamingMessage() {
        console.log('UI: Update streaming message');
      }
      completeStreamingMessage() {
        console.log('UI: Complete streaming message');
      }
      clearTranscript() {
        console.log('UI: Clear transcript');
      }
      showMessage() {
        console.log('UI: Show message');
      }
      showError() {
        console.log('UI: Show error');
      }
      addSpeakingIndicator() {
        console.log('UI: Add speaking indicator');
      }
      removeSpeakingIndicator() {
        console.log('UI: Remove speaking indicator');
      }
      showAudioUnlockPrompt() {
        console.log('UI: Show audio unlock prompt');
      }
    }
    return new MockUI();
  }
}

// Initialize and start the application
let zenApp = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    zenApp = new ZenApp();

    // Setup global error handling
    zenApp.on('initializationError', (error) => {
      console.error('❌ Application initialization failed:', error);
      document.body.innerHTML = `
        <div style="padding: 20px; text-align: center; color: red;">
          <h2>Application Failed to Initialize</h2>
          <p>${error.message}</p>
          <button onclick="location.reload()">Reload Page</button>
        </div>
      `;
    });

    zenApp.on('browserIncompatible', (missing) => {
      document.body.innerHTML = `
        <div style="padding: 20px; text-align: center; color: orange;">
          <h2>Browser Not Compatible</h2>
          <p>Missing features: ${missing.join(', ')}</p>
          <p>Please use Chrome, Firefox, or Safari for best compatibility.</p>
        </div>
      `;
    });

    // Start initialization
    await zenApp.initialize();

    // Make zenApp globally available for debugging
    window.zenApp = zenApp;
  } catch (error) {
    console.error('❌ Failed to start application:', error);
  }
});

// Export for module use
export default ZenApp;

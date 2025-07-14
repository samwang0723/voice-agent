// WebSocket Transport Module
// Handles all WebSocket communication with event-based architecture

class Transport extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.isConnected = false;
    this.isUserDisconnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.reconnectDelay = 2000;
    this.bearerToken = null; // Store bearer token for reconnection
    this.lastContext = null; // Add this line to track the last sent context
  }

  // Public API Methods

  /**
   * Connect to WebSocket server
   * @param {Object} options - Connection options
   * @param {string} options.bearerToken - Optional authentication token
   * @returns {Promise<boolean>} - Success status
   */
  async connect(options = {}) {
    if (this.isConnected) {
      console.log('Already connected.');
      this.emit('status', { type: 'info', message: 'Already connected' });
      return true;
    }

    try {
      this.isUserDisconnected = false;
      // Store bearer token for reconnection
      this.bearerToken = options.bearerToken || null;
      await this._connectWebSocket(this.bearerToken);
      return true;
    } catch (error) {
      console.error('Connection failed:', error);
      this.emit('status', {
        type: 'error',
        message: `Connection failed: ${error.message}`,
      });
      return false;
    }
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.isUserDisconnected = true;
      this.ws.close();
      this.emit('status', { type: 'info', message: 'Disconnected by user' });
    } else {
      this.emit('status', {
        type: 'info',
        message: 'No active connection to disconnect',
      });
    }
  }

  /**
   * Clear stored bearer token (for logout)
   */
  clearBearerToken() {
    this.bearerToken = null;
  }

  /**
   * Send configuration to server
   * @param {Object} config - Configuration object
   * @param {string} config.sttEngine - STT engine selection
   * @param {string} config.ttsEngine - TTS engine selection
   * @param {string} config.chatMode - Chat mode (stream/single)
   * @param {boolean} config.noiseReduction - Noise reduction enabled
   */
  sendConfig(config) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'config',
          sttEngine: config.sttEngine,
          ttsEngine: config.ttsEngine,
          chatMode: config.chatMode,
          noiseReduction: config.noiseReduction,
        })
      );

      this.emit('status', {
        type: 'info',
        message: `Configuration updated - STT: ${config.sttEngine}, TTS: ${config.ttsEngine}, Mode: ${config.chatMode}, Noise Reduction: ${config.noiseReduction ? 'ON' : 'OFF'}`,
      });
    } else {
      this.emit('status', {
        type: 'error',
        message: 'Not connected to server',
      });
    }
  }

  /**
   * Send audio context information
   * @param {Object} context - Context object with datetime, timezone, etc.
   */
  sendAudioContext(context) {
    // Only send context if it's different from the last one
    if (JSON.stringify(context) !== JSON.stringify(this.lastContext)) {
      this.ws.send(
        JSON.stringify({
          type: 'audio-context',
          context: context,
        })
      );
      this.lastContext = context; // Update last sent context
    }
  }

  /**
   * Send audio data
   * @param {ArrayBuffer} audioBuffer - Audio data as Int16 PCM
   */
  sendAudio(audioBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(audioBuffer);
    } else {
      this.emit('status', {
        type: 'error',
        message: 'Not connected to server',
      });
    }
  }

  /**
   * Send barge-in signal
   */
  sendBargeIn() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'barge-in' }));
      console.log('📤 Sent barge-in message to server');
    }
  }

  /**
   * Check if connected
   * @returns {boolean} - Connection status
   */
  getIsConnected() {
    return this.isConnected;
  }

  // Private Methods

  /**
   * Internal WebSocket connection method
   * @param {string} bearerToken - Optional authentication token
   */
  async _connectWebSocket(bearerToken = null) {
    return new Promise((resolve, reject) => {
      try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let wsUrl = `${protocol}//${window.location.host}/ws`;

        // Include token parameter only if available
        if (bearerToken) {
          wsUrl += `?token=${encodeURIComponent(bearerToken)}`;
          console.log(
            '🔑 Connecting with authentication token:',
            bearerToken.substring(0, 20) + '...'
          );
          console.log(
            '🔗 WebSocket URL:',
            wsUrl.replace(bearerToken, 'TOKEN_HIDDEN')
          );
        } else {
          console.log('🔓 Connecting as guest (no authentication token)...');
          this.emit('status', {
            type: 'info',
            message:
              'Connecting as guest - some features may require authentication',
          });
        }

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          console.log('WebSocket connected');
          this.isConnected = true;
          this.reconnectAttempts = 0;

          this.emit('connected', { authenticated: !!bearerToken });
          this.emit('status', {
            type: 'info',
            message: 'Connected to websocket',
          });

          resolve();
        };

        this.ws.onmessage = (event) => {
          this._handleMessage(event);
        };

        this.ws.onclose = () => {
          console.log('WebSocket disconnected');
          this.isConnected = false;

          this.emit('disconnected');
          this.emit('status', {
            type: 'info',
            message: 'Voice detection stopped (connection lost)',
          });

          // Attempt reconnection if not user-initiated
          if (
            !this.isUserDisconnected &&
            this.reconnectAttempts < this.maxReconnectAttempts
          ) {
            this._attemptReconnect();
          }
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);

          if (!this.isUserDisconnected) {
            this.emit('status', {
              type: 'error',
              message: 'Connection error.',
            });
          }

          this.emit('error', error);
          reject(error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle incoming WebSocket messages
   * @param {MessageEvent} event - WebSocket message event
   */
  _handleMessage(event) {
    try {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'connected':
          this.emit('message', { type: 'connected', data });
          this.emit('status', { type: 'info', message: data.message });
          break;

        case 'transcript':
          this.emit('message', { type: 'transcript', data });
          this.emit('transcript', { text: data.transcript });
          break;

        case 'agent':
          this.emit('message', { type: 'agent', data });
          this.emit('agent-response', {
            text: data.message,
            audio: data.speechAudio,
            chatMode: this._getCurrentChatMode(),
          });
          break;

        case 'auth_required':
          this.emit('message', { type: 'auth_required', data });
          this.emit('auth-required', { message: data.message });
          this.emit('status', { type: 'info', message: data.message });
          break;

        case 'error':
          this.emit('message', { type: 'error', data });
          this.emit('status', { type: 'error', message: data.message });

          // Check if error is authentication-related
          if (this._isAuthError(data.message)) {
            this.emit('auth-error', { message: data.message });
          }
          break;

        case 'barge-in-ack':
          this.emit('message', { type: 'barge-in-ack', data });
          this.emit('barge-in-ack');
          this.emit('status', {
            type: 'info',
            message: 'Barge-in acknowledged',
          });
          break;

        case 'agent-stream':
          this.emit('message', { type: 'agent-stream', data });
          this.emit('agent-stream', { delta: data.delta });
          break;

        case 'audio-chunk':
          this.emit('message', { type: 'audio-chunk', data });
          this.emit('audio-chunk', {
            data: data.data,
            chatMode: this._getCurrentChatMode(),
          });
          break;

        case 'agent-stream-complete':
          this.emit('message', { type: 'agent-stream-complete', data });
          this.emit('agent-stream-complete');
          break;

        default:
          this.emit('message', { type: 'unknown', data });
          this.emit('status', { type: 'info', message: event.data });
      }
    } catch (e) {
      console.error('❌ Error parsing WebSocket message:', e);
      this.emit('message', { type: 'raw', data: event.data });
      this.emit('status', { type: 'info', message: event.data });
    }
  }

  /**
   * Check if error message is authentication-related
   * @param {string} message - Error message
   * @returns {boolean} - True if auth-related error
   */
  _isAuthError(message) {
    if (!message) return false;

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
   * Get current chat mode (would be injected or configured)
   * @returns {string} - Current chat mode
   */
  _getCurrentChatMode() {
    // Try to get from UI settings or use default
    const chatModeSelect = document.getElementById('chat-mode-select');
    return chatModeSelect?.value || 'stream';
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  _attemptReconnect() {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    this.emit('status', {
      type: 'info',
      message: `Reconnecting in ${delay / 1000}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    });

    setTimeout(() => {
      if (
        !this.isUserDisconnected &&
        this.reconnectAttempts <= this.maxReconnectAttempts
      ) {
        this.connect({ bearerToken: this.bearerToken });
      }
    }, delay);
  }

  /**
   * Custom event emitter for better debugging
   * @param {string} type - Event type
   * @param {Object} detail - Event detail
   */
  emit(type, detail = {}) {
    const event = new CustomEvent(type, { detail });
    this.dispatchEvent(event);
  }

  /**
   * Add event listener with better debugging
   * @param {string} type - Event type
   * @param {Function} listener - Event listener
   * @param {Object} options - Event options
   */
  on(type, listener, options = {}) {
    this.addEventListener(type, listener, options);
  }

  /**
   * Remove event listener
   * @param {string} type - Event type
   * @param {Function} listener - Event listener
   */
  off(type, listener) {
    this.removeEventListener(type, listener);
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.ws) {
      this.isUserDisconnected = true;
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.reconnectAttempts = 0;
  }
}

// Create and export singleton instance
const transport = new Transport();

export default transport;

// Also export the class for testing or multiple instances
export { Transport };

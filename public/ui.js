// UI Management Module for Zen Voice Interface
// Handles all DOM interactions, screen transitions, orb animations, and user interface updates

class UIManager extends EventTarget {
  constructor() {
    super();
    this.elements = {};
    this.state = {
      currentScreen: 'login',
      isListening: false,
      isConnected: false,
      isAuthenticated: false,
      isVadReady: false,
      settingsOpen: false,
      orbAnimating: false,
    };

    // Touch/swipe handling for settings panel
    this.touchState = {
      startY: 0,
      currentY: 0,
      isDragging: false,
      threshold: 50,
    };

    this.initializeElements();
    this.setupEventListeners();
    this.setupSwipeGestures();

    // Update location on initialization (for returning users)
    this.updateUserLocation();
  }

  // Initialize DOM element references
  initializeElements() {
    // Screens
    this.elements.loginScreen = document.getElementById('login-screen');
    this.elements.mainScreen = document.getElementById('main-screen');

    // Login elements
    this.elements.googleLoginButton = document.getElementById(
      'google-login-button'
    );

    // Main interface elements
    this.elements.statusText = document.getElementById('status-text');
    this.elements.transcriptContainer = document.getElementById(
      'transcript-container'
    );
    this.elements.transcriptContent =
      document.getElementById('transcript-content');

    // Header elements
    this.elements.systemStatus = document.getElementById('system-status');
    this.elements.systemLocation = document.getElementById('system-location');

    // Orb elements
    this.elements.orbContainer = document.getElementById('orb-container');
    this.elements.orbCenter = document.getElementById('orb-center');
    this.elements.micIcon = document.getElementById('mic-icon');
    this.elements.stopIcon = document.getElementById('stop-icon');

    // Settings elements
    this.elements.settingsButton = document.getElementById('settings-button');
    this.elements.settingsPanel = document.getElementById('settings-panel');
    this.elements.closeSettingsButton = document.getElementById(
      'close-settings-button'
    );
    this.elements.connectionStatusIcon = document.getElementById(
      'connection-status-icon'
    );
    this.elements.connectionStatusText = document.getElementById(
      'connection-status-text'
    );

    // Engine selects
    this.elements.sttEngineSelect =
      document.getElementById('stt-engine-select');
    this.elements.ttsEngineSelect =
      document.getElementById('tts-engine-select');
    this.elements.chatModeSelect = document.getElementById('chat-mode-select');
    this.elements.noiseReductionToggle = document.getElementById(
      'noise-reduction-toggle'
    );
    this.elements.testAudioButton =
      document.getElementById('test-audio-button');
    this.elements.systemMessageToggle = document.getElementById(
      'system-message-toggle'
    );
    this.elements.logoutButton = document.getElementById('logout-button');
  }

  // Setup event listeners
  setupEventListeners() {
    // Google login button
    if (this.elements.googleLoginButton) {
      this.elements.googleLoginButton.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('loginRequested'));
      });
    }

    // Orb click for listening toggle
    if (this.elements.orbCenter) {
      this.elements.orbCenter.addEventListener('click', () => {
        this.handleOrbClick();
      });
    }

    // Location click for manual refresh
    if (this.elements.systemLocation) {
      this.elements.systemLocation.addEventListener('click', () => {
        this.updateUserLocation();
      });

      // Add cursor pointer style
      this.elements.systemLocation.style.cursor = 'pointer';
      this.elements.systemLocation.title = 'Click to refresh location';
    }

    // Logout button
    if (this.elements.logoutButton) {
      this.elements.logoutButton.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('logoutRequested'));
      });
    }

    // Settings panel controls
    if (this.elements.settingsButton) {
      this.elements.settingsButton.addEventListener('click', () => {
        this.openSettings();
      });
    }

    if (this.elements.closeSettingsButton) {
      this.elements.closeSettingsButton.addEventListener('click', () => {
        this.closeSettings();
      });
    }

    // Settings panel backdrop click to close
    if (this.elements.settingsPanel) {
      this.elements.settingsPanel.addEventListener('click', (e) => {
        if (e.target === this.elements.settingsPanel) {
          this.closeSettings();
        }
      });
    }

    // Prevent settings content clicks from closing panel
    const settingsContent =
      this.elements.settingsPanel?.querySelector('.space-y-6');
    if (settingsContent) {
      settingsContent.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    }
  }

  // Setup swipe gestures for settings panel
  setupSwipeGestures() {
    if (!this.elements.settingsPanel) return;

    // Touch events for mobile swipe
    this.elements.settingsPanel.addEventListener(
      'touchstart',
      (e) => {
        this.touchState.startY = e.touches[0].clientY;
        this.touchState.isDragging = true;
      },
      { passive: true }
    );

    this.elements.settingsPanel.addEventListener(
      'touchmove',
      (e) => {
        if (!this.touchState.isDragging) return;

        this.touchState.currentY = e.touches[0].clientY;
        const deltaY = this.touchState.currentY - this.touchState.startY;

        // Only allow downward swipe to close
        if (deltaY > 0) {
          const progress = Math.min(deltaY / 200, 1);
          this.elements.settingsPanel.style.transform = `translateY(${deltaY}px)`;
          this.elements.settingsPanel.style.opacity = `${1 - progress * 0.5}`;
        }
      },
      { passive: true }
    );

    this.elements.settingsPanel.addEventListener(
      'touchend',
      (e) => {
        if (!this.touchState.isDragging) return;

        const deltaY = this.touchState.currentY - this.touchState.startY;

        if (deltaY > this.touchState.threshold) {
          this.closeSettings();
        } else {
          // Snap back to open position
          this.elements.settingsPanel.style.transform = 'translateY(0)';
          this.elements.settingsPanel.style.opacity = '1';
        }

        this.touchState.isDragging = false;
      },
      { passive: true }
    );

    // Mouse events for desktop
    this.elements.settingsPanel.addEventListener('mousedown', (e) => {
      this.touchState.startY = e.clientY;
      this.touchState.isDragging = true;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.touchState.isDragging) return;

      this.touchState.currentY = e.clientY;
      const deltaY = this.touchState.currentY - this.touchState.startY;

      if (deltaY > 0) {
        const progress = Math.min(deltaY / 200, 1);
        this.elements.settingsPanel.style.transform = `translateY(${deltaY}px)`;
        this.elements.settingsPanel.style.opacity = `${1 - progress * 0.5}`;
      }
    });

    document.addEventListener('mouseup', () => {
      if (!this.touchState.isDragging) return;

      const deltaY = this.touchState.currentY - this.touchState.startY;

      if (deltaY > this.touchState.threshold) {
        this.closeSettings();
      } else {
        this.elements.settingsPanel.style.transform = 'translateY(0)';
        this.elements.settingsPanel.style.opacity = '1';
      }

      this.touchState.isDragging = false;
    });
  }

  // Screen transition methods
  showLoginScreen() {
    if (this.elements.loginScreen && this.elements.mainScreen) {
      this.elements.loginScreen.classList.remove('hidden');
      this.elements.loginScreen.style.opacity = '1';
      this.elements.mainScreen.classList.add('hidden');
      this.elements.mainScreen.style.opacity = '0';
      this.state.currentScreen = 'login';
    }
  }

  hideLoginScreen() {
    // Alias for showMainScreen to match zenApp.js expectations
    this.showMainScreen();
  }

  showMainScreen() {
    if (this.elements.loginScreen && this.elements.mainScreen) {
      this.elements.loginScreen.style.opacity = '0';
      setTimeout(() => {
        this.elements.loginScreen.classList.add('hidden');
        this.elements.mainScreen.classList.remove('hidden');
        this.elements.mainScreen.style.opacity = '1';

        // Update user location when main screen is shown
        this.updateUserLocation();
      }, 300);
      this.state.currentScreen = 'main';
    }
  }

  // Orb animation and state management
  setOrbListening(listening) {
    if (!this.elements.orbContainer) return;

    this.state.isListening = listening;

    if (listening) {
      this.elements.orbContainer.classList.add('listening');
      this.elements.micIcon?.classList.add('hidden');
      this.elements.stopIcon?.classList.remove('hidden');
    } else {
      this.elements.orbContainer.classList.remove('listening');
      this.elements.micIcon?.classList.remove('hidden');
      this.elements.stopIcon?.classList.add('hidden');
    }
  }

  setOrbConnected(connected) {
    if (!this.elements.orbContainer) return;
    if (connected) {
      this.elements.orbContainer.classList.add('connected');
    } else {
      this.elements.orbContainer.classList.remove('connected');
    }
  }

  setOrbBreathing(breathing) {
    if (!this.elements.orbContainer) return;

    if (breathing) {
      this.elements.orbContainer.classList.remove('listening');
    }
  }

  // Handle orb click events
  handleOrbClick() {
    // Emit custom event for listening toggle
    const event = new CustomEvent('orbClick', {
      detail: { currentlyListening: this.state.isListening },
    });
    document.dispatchEvent(event);
  }

  // Transcript management
  appendTranscriptLine(content, type = 'system', timestamp = null) {
    if (type === 'system' && !this.getSettings().showSystemMessages) {
      return;
    }

    if (!this.elements.transcriptContent) return;

    // Hide the status text when adding actual content
    const statusText =
      this.elements.transcriptContent.querySelector('#status-text');
    if (statusText) {
      statusText.style.opacity = '0';
      setTimeout(() => {
        statusText.remove();
      }, 300);
    }

    const line = document.createElement('div');
    line.className = `transcript-line mb-2 ${type}`;

    const time = timestamp || new Date().toLocaleTimeString();

    switch (type) {
      case 'user':
        line.innerHTML = `
          <div class="user-text text-md opacity-60">
            ${content}
          </div>
        `;
        break;
      case 'agent':
        line.innerHTML = `
          <div class="agent text-white text-md">
            ${content}
          </div>
        `;
        break;
      case 'system':
        line.innerHTML = `
          <div class="text-gray-400 text-xs">
            • ${content}
          </div>
        `;
        break;
      case 'error':
        line.innerHTML = `
          <div class="text-red-400 text-sm">
            ⚠ ${content}
          </div>
        `;
        break;
      default:
        line.innerHTML = `
          <div class="text-gray-300 text-sm">
            ${content}
          </div>
        `;
    }

    this.elements.transcriptContent.appendChild(line);
    this.scrollTranscriptToBottom();
  }

  // Update streaming message (for agent responses)
  updateStreamingMessage(delta) {
    if (!this.elements.transcriptContent) return;

    let streamingLine =
      this.elements.transcriptContent.querySelector('.streaming-message');

    if (!streamingLine) {
      // First delta - create new streaming message
      streamingLine = document.createElement('div');
      streamingLine.className = 'transcript-line streaming-message mb-2 agent';
      streamingLine.innerHTML = `
        <div class="text-md" data-streaming-text="${this._escapeHtml(delta)}">
          ${delta}
        </div>
      `;
      this.elements.transcriptContent.appendChild(streamingLine);
    } else {
      // Subsequent deltas - append to existing message
      const contentDiv = streamingLine.querySelector('div');
      if (contentDiv) {
        // Get accumulated text from data attribute
        const currentText =
          contentDiv.getAttribute('data-streaming-text') || '';
        const newText = currentText + delta;

        // Update both the data attribute and the displayed text
        contentDiv.setAttribute('data-streaming-text', newText);
        contentDiv.textContent = newText;
      }
    }

    this.scrollTranscriptToBottom();
  }

  // Helper method to escape HTML
  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Complete streaming message
  completeStreamingMessage() {
    const streamingLine =
      this.elements.transcriptContent?.querySelector('.streaming-message');
    if (streamingLine) {
      streamingLine.classList.remove('streaming-message');

      // Remove the data attribute as it's no longer needed
      const contentDiv = streamingLine.querySelector(
        'div[data-streaming-text]'
      );
      if (contentDiv) {
        contentDiv.removeAttribute('data-streaming-text');
      }

      console.log('🎯 Agent stream completed');
    }
  }

  // Clear transcript
  clearTranscript() {
    if (this.elements.transcriptContent) {
      // Clear all transcript lines but keep the status text
      const transcriptLines =
        this.elements.transcriptContent.querySelectorAll('.transcript-line');
      transcriptLines.forEach((line) => line.remove());

      // If there's no status text, add it back
      if (!this.elements.transcriptContent.querySelector('#status-text')) {
        const statusP = document.createElement('p');
        statusP.id = 'status-text';
        statusP.className =
          'text-lg text-gray-400 transition-opacity duration-500';
        statusP.textContent = 'Tap the orb to speak';
        this.elements.transcriptContent.appendChild(statusP);

        // Re-reference the status text element
        this.elements.statusText = statusP;
      }
    }
  }

  scrollTranscriptToBottom() {
    if (this.elements.transcriptContainer) {
      this.elements.transcriptContainer.scrollTop =
        this.elements.transcriptContainer.scrollHeight;
    }
  }

  // Status updates
  updateStatus(message, type = 'info') {
    if (!this.elements.statusText) return;

    this.elements.statusText.textContent = message;

    // Update status text color based on type
    this.elements.statusText.className =
      'text-lg transition-opacity duration-500';
    switch (type) {
      case 'connected':
        this.elements.statusText.classList.add('text-green-400');
        break;
      case 'listening':
        this.elements.statusText.classList.add('text-blue-400');
        break;
      case 'error':
        this.elements.statusText.classList.add('text-red-400');
        break;
      case 'warning':
        this.elements.statusText.classList.add('text-yellow-400');
        break;
      default:
        this.elements.statusText.classList.add('text-gray-400');
    }
  }

  // Connection status updates
  updateConnectionStatus(connected, authenticated = false) {
    this.state.isConnected = connected;
    this.state.isAuthenticated = authenticated;

    if (
      this.elements.connectionStatusIcon &&
      this.elements.connectionStatusText
    ) {
      if (connected) {
        // Use setAttribute for SVG elements
        this.elements.connectionStatusIcon.setAttribute(
          'class',
          'h-5 w-5 text-green-400'
        );
        this.elements.connectionStatusText.textContent = authenticated
          ? 'Connected (Auth)'
          : 'Connected';
        this.elements.connectionStatusText.className =
          'text-green-400 font-medium';
      } else {
        // Use setAttribute for SVG elements
        this.elements.connectionStatusIcon.setAttribute(
          'class',
          'h-5 w-5 text-red-400'
        );
        this.elements.connectionStatusText.textContent = 'Disconnected';
        this.elements.connectionStatusText.className =
          'text-red-400 font-medium';
      }
    }

    // Update header system status
    this.updateSystemStatus(connected, authenticated);

    // Update main status based on connection and VAD readiness
    this.updateMainStatus();
  }

  // Update system status in header
  updateSystemStatus(connected, authenticated = false) {
    if (this.elements.systemStatus) {
      if (connected) {
        if (authenticated) {
          this.elements.systemStatus.textContent = 'ONLINE (AUTH)';
          this.elements.systemStatus.className = 'text-green-400';
        } else {
          this.elements.systemStatus.textContent = 'ONLINE';
          this.elements.systemStatus.className = 'text-yellow-400';
        }
      } else {
        this.elements.systemStatus.textContent = 'OFFLINE';
        this.elements.systemStatus.className = 'text-red-400';
      }
    }
  }

  // Get and update user's real location
  async updateUserLocation() {
    if (!this.elements.systemLocation) return;

    try {
      // Check if geolocation is supported
      if (!navigator.geolocation) {
        this.elements.systemLocation.textContent = 'LOCATION UNAVAILABLE';
        return;
      }

      // Show loading state
      this.elements.systemLocation.textContent = 'LOCATING...';
      this.elements.systemLocation.className = 'text-yellow-400';

      // Get current position
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 300000, // 5 minutes
        });
      });

      const { latitude, longitude } = position.coords;

      // Use reverse geocoding to get location name
      const locationName = await this.reverseGeocode(latitude, longitude);

      this.elements.systemLocation.textContent = locationName.toUpperCase();
      this.elements.systemLocation.className = 'text-gray-400';

      console.log(`📍 Location updated: ${locationName}`);
    } catch (error) {
      console.error('❌ Failed to get location:', error);

      // Handle different error types
      let fallbackText = 'LOCATION UNAVAILABLE';
      if (error.code === 1) {
        fallbackText = 'LOCATION DENIED';
      } else if (error.code === 2) {
        fallbackText = 'LOCATION UNAVAILABLE';
      } else if (error.code === 3) {
        fallbackText = 'LOCATION TIMEOUT';
      }

      this.elements.systemLocation.textContent = fallbackText;
      this.elements.systemLocation.className = 'text-red-400';
    }
  }

  // Reverse geocode coordinates to location name
  async reverseGeocode(lat, lon) {
    try {
      // Use a free geocoding service (nominatim from OpenStreetMap)
      // Request English language results
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1&accept-language=en`,
        {
          headers: {
            'User-Agent': 'ZenVoiceInterface/1.0',
            'Accept-Language': 'en,en-US;q=0.9',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Geocoding failed: ${response.status}`);
      }

      const data = await response.json();

      // Extract city/town name from the response
      const address = data.address || {};

      // Try to get the most appropriate English location name
      const locationName =
        address.city ||
        address.town ||
        address.village ||
        address.municipality ||
        address.county ||
        address.state ||
        address.region ||
        address.country ||
        'Unknown Location';

      // Clean up the location name (remove unnecessary prefixes/suffixes)
      const cleanLocationName = locationName
        .replace(/^(City of|Town of|Village of|Municipality of)\s+/i, '')
        .replace(/\s+(City|Town|Village|Municipality|County|District)$/i, '')
        .trim();

      return cleanLocationName;
    } catch (error) {
      console.error('❌ Reverse geocoding failed:', error);
      // Fallback to coordinates if geocoding fails
      return `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    }
  }

  // VAD readiness updates
  updateVadStatus(ready) {
    this.state.isVadReady = ready;
    this.updateMainStatus();
  }

  // Update main status text based on current state
  updateMainStatus() {
    let message = 'ANALYZING POTENTIAL THREATS';
    let type = 'info';

    if (!this.state.isConnected) {
      message = 'Tap the orb to speak';
      type = 'warning';
    } else if (!this.state.isVadReady) {
      message = 'Initializing voice detection';
      type = 'warning';
    } else if (this.state.isListening) {
      message = 'Listening... Speak now';
      type = 'listening';
    } else if (this.state.isConnected && this.state.isVadReady) {
      message = this.state.isAuthenticated
        ? 'AWAITING COMMAND (Authenticated)'
        : 'AWAITING COMMAND';
      type = 'connected';
    }

    this.updateStatus(message, type);
  }

  // Settings panel management
  openSettings() {
    if (!this.elements.settingsPanel || !this.elements.mainScreen) return;

    this.state.settingsOpen = true;
    this.elements.settingsPanel.classList.add('open');
    this.elements.mainScreen.classList.add('settings-view');

    // Reset any transform from swipe gestures
    this.elements.settingsPanel.style.transform = 'translateY(0)';
    this.elements.settingsPanel.style.opacity = '1';
  }

  closeSettings() {
    if (!this.elements.settingsPanel || !this.elements.mainScreen) return;

    this.state.settingsOpen = false;
    this.elements.settingsPanel.classList.remove('open');
    this.elements.mainScreen.classList.remove('settings-view');

    // Reset any transform from swipe gestures
    this.elements.settingsPanel.style.transform = '';
    this.elements.settingsPanel.style.opacity = '';
  }

  // Audio unlock prompt
  showAudioUnlockPrompt() {
    this.appendTranscriptLine(
      'Audio requires user interaction - tap the orb to enable',
      'system'
    );
  }

  hideAudioUnlockPrompt() {
    // Remove any audio unlock messages
    const systemMessages = this.elements.transcriptContent?.querySelectorAll(
      '.transcript-line.system'
    );
    systemMessages?.forEach((msg) => {
      if (msg.textContent.includes('Audio requires user interaction')) {
        msg.remove();
      }
    });
  }

  // Login prompt management
  showLoginPrompt() {
    this.appendTranscriptLine(
      '🔐 Authentication required for full functionality',
      'system'
    );

    // Create login button in transcript
    const loginLine = document.createElement('div');
    loginLine.className = 'transcript-line system mb-2';
    loginLine.innerHTML = `
      <button class="inline-flex items-center px-3 py-2 bg-white text-gray-800 rounded-lg text-sm font-medium hover:bg-gray-100 transition-colors mt-2" onclick="document.dispatchEvent(new CustomEvent('loginRequested'))">
        <svg class="w-4 h-4 mr-2" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Sign in with Google
      </button>
    `;

    this.elements.transcriptContent?.appendChild(loginLine);
    this.scrollTranscriptToBottom();
  }

  hideLoginPrompt() {
    // Remove login prompts from transcript
    const loginButtons =
      this.elements.transcriptContent?.querySelectorAll('button');
    loginButtons?.forEach((btn) => {
      if (btn.textContent.includes('Sign in with Google')) {
        btn.closest('.transcript-line')?.remove();
      }
    });
  }

  // Get current settings values
  getSettings() {
    return {
      sttEngine: this.elements.sttEngineSelect?.value || 'groq',
      ttsEngine: this.elements.ttsEngineSelect?.value || 'elevenlabs',
      chatMode: this.elements.chatModeSelect?.value || 'stream',
      noiseReduction: this.elements.noiseReductionToggle?.checked !== false, // Default to true
      showSystemMessages: this.elements.systemMessageToggle?.checked !== false,
    };
  }

  // Update settings values
  updateSettings(settings) {
    if (settings.sttEngine && this.elements.sttEngineSelect) {
      this.elements.sttEngineSelect.value = settings.sttEngine;
    }
    if (settings.ttsEngine && this.elements.ttsEngineSelect) {
      this.elements.ttsEngineSelect.value = settings.ttsEngine;
    }
    if (settings.chatMode && this.elements.chatModeSelect) {
      this.elements.chatModeSelect.value = settings.chatMode;
    }
    if (
      typeof settings.noiseReduction === 'boolean' &&
      this.elements.noiseReductionToggle
    ) {
      this.elements.noiseReductionToggle.checked = settings.noiseReduction;
    }
    if (
      typeof settings.showSystemMessages === 'boolean' &&
      this.elements.systemMessageToggle
    ) {
      this.elements.systemMessageToggle.checked = settings.showSystemMessages;
    }
  }

  // Setup settings change listeners
  setupSettingsListeners(callback) {
    const elements = [
      this.elements.sttEngineSelect,
      this.elements.ttsEngineSelect,
      this.elements.chatModeSelect,
      this.elements.noiseReductionToggle,
      this.elements.systemMessageToggle,
    ];

    elements.forEach((element) => {
      if (element) {
        element.addEventListener('change', () => {
          callback(this.getSettings());
        });
      }
    });
  }

  // Test audio button handling
  setupTestAudioButton(callback) {
    if (this.elements.testAudioButton) {
      this.elements.testAudioButton.addEventListener('click', callback);
    }
  }

  // Update test audio button state
  updateTestAudioButton(audioUnlocked) {
    if (!this.elements.testAudioButton) return;

    if (audioUnlocked) {
      this.elements.testAudioButton.textContent = 'Test ✓';
      this.elements.testAudioButton.classList.remove(
        'bg-blue-600',
        'hover:bg-blue-700'
      );
      this.elements.testAudioButton.classList.add(
        'bg-green-600',
        'hover:bg-green-700'
      );
    } else {
      this.elements.testAudioButton.textContent = 'Test';
      this.elements.testAudioButton.classList.remove(
        'bg-green-600',
        'hover:bg-green-700'
      );
      this.elements.testAudioButton.classList.add(
        'bg-blue-600',
        'hover:bg-blue-700'
      );
    }
  }

  // Utility methods
  isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );
  }

  // Get current state
  getState() {
    return { ...this.state };
  }

  // Compatibility methods for zenApp.js expectations
  showMainInterface() {
    this.showMainScreen();
  }

  updateListeningState(listening) {
    this.setOrbListening(listening);
  }

  updateVADStatus(ready) {
    this.updateVadStatus(ready);
  }

  updateOrbState(state) {
    console.log('updateOrbState', state);
    // Map states to appropriate visual feedback
    switch (state) {
      case 'idle':
        this.setOrbListening(false);
        this.setOrbBreathing(true);
        this.setOrbConnected(this.state.isConnected);
        break;
      case 'listening':
        this.setOrbListening(true);
        this.setOrbConnected(false);
        break;
      case 'processing':
        this.setOrbListening(false);
        this.setOrbBreathing(false);
        this.setOrbConnected(true);
        // Could add a processing animation here
        break;
      case 'speaking':
        this.setOrbListening(false);
        this.setOrbBreathing(false);
        // Could add a speaking animation here
        break;
      case 'connected':
        this.setOrbListening(false);
        this.setOrbBreathing(true);
        this.setOrbConnected(true);
        break;
      case 'disconnected':
        this.setOrbListening(false);
        this.setOrbBreathing(false);
        this.setOrbConnected(false);
        break;
      default:
        this.setOrbListening(false);
        this.setOrbBreathing(false);
        this.setOrbConnected(false);
    }
  }

  addTranscriptLine(content, type = 'system') {
    this.appendTranscriptLine(content, type);
  }

  showMessage(message, type = 'info') {
    // Map message types to transcript types
    const transcriptType = type === 'error' ? 'error' : 'system';
    this.appendTranscriptLine(message, transcriptType);

    // Also update status if it's important
    if (type === 'error' || type === 'warning') {
      this.updateStatus(message, type);
    }
  }

  showError(message) {
    this.showMessage(message, 'error');
  }

  addSpeakingIndicator() {
    // This is handled internally by setupAudioPlayerCallbacks
    // Adding this method for compatibility
  }

  removeSpeakingIndicator() {
    // This is handled internally by setupAudioPlayerCallbacks
    // Adding this method for compatibility
  }

  // Event emitter methods for EventTarget compatibility
  emit(type, detail = {}) {
    const event = new CustomEvent(type, { detail });
    this.dispatchEvent(event);
  }

  on(type, listener, options = {}) {
    this.addEventListener(type, listener, options);
  }

  off(type, listener) {
    this.removeEventListener(type, listener);
  }
}

// Create and export singleton instance
const uiManager = new UIManager();

export default uiManager;

// Also export the class for testing or multiple instances
export { UIManager };

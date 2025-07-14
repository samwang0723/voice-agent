import createRNNWasmModule from './rnnoise.js';

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

class VADManager extends EventTarget {
  constructor() {
    super();
    this.vadInstance = null;
    this.isListening = false;
    this.isVadReady = false;
    this.isNoiseReductionEnabled = true;

    // RNNoise global variables
    this.rnnoiseModule = null;
    this.rnnoiseState = null;
    this.inputBuffer = null;
    this.outputBuffer = null;
  }

  // Public API Methods

  /**
   * Initialize VAD with ONNX configuration and RNNoise
   */
  async initializeVAD() {
    try {
      console.log('Initializing VAD...');
      this.dispatchEvent(
        new CustomEvent('vadStatus', {
          detail: {
            message: 'Initializing voice detection...',
            type: 'system',
          },
        })
      );

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

      // This is logged in zenApp.js, so we can remove this to avoid confusion
      // console.log('ONNX Runtime version:', ort.version || 'unknown');
      console.log('VAD library loaded successfully');

      // Initialize RNNoise after VAD setup
      if (this.isNoiseReductionEnabled) {
        await this.initializeRNNoise();
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
          this.vadInstance = await vad.MicVAD.new({
            onSpeechStart: () => this.handleSpeechStart(),
            onSpeechEnd: (audio) => this.handleSpeechEnd(audio),
            onVADMisfire: () => this.handleVADMisfire(),
            ...config,
          });

          console.log(
            `VAD initialized successfully with ${config.model} model`
          );
          this.dispatchEvent(
            new CustomEvent('vadStatus', {
              detail: {
                message: `Voice detection ready (${config.model} model)`,
                type: 'system',
              },
            })
          );
          vadInitialized = true;
          this.isVadReady = true;

          // Set up periodic VAD statistics logging for monitoring
          setInterval(() => this.logVADStats(), 30000); // Log stats every 30 seconds

          // Notify that VAD is ready
          this.dispatchEvent(new CustomEvent('vadReady'));
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
      this.dispatchEvent(
        new CustomEvent('vadStatus', {
          detail: {
            message: `Voice detection failed: ${error.message}`,
            type: 'error',
          },
        })
      );
      this.dispatchEvent(
        new CustomEvent('vadStatus', {
          detail: {
            message: 'Try refreshing the page or check browser compatibility',
            type: 'system',
          },
        })
      );
    }
  }

  /**
   * Start listening for voice activity
   */
  async startListening() {
    if (!this.vadInstance) {
      this.dispatchEvent(
        new CustomEvent('vadStatus', {
          detail: { message: 'Voice detection not initialized', type: 'error' },
        })
      );
      return false;
    }

    try {
      await this.vadInstance.start();
      this.isListening = true;
      this.dispatchEvent(
        new CustomEvent('vadListeningChanged', {
          detail: { isListening: true },
        })
      );
      return true;
    } catch (error) {
      console.error('Failed to start VAD:', error);
      this.dispatchEvent(
        new CustomEvent('vadStatus', {
          detail: {
            message: `Failed to start: ${error.message}`,
            type: 'error',
          },
        })
      );
      return false;
    }
  }

  /**
   * Stop listening and release microphone
   */
  stopListening() {
    if (this.vadInstance) {
      console.log('Stopping VAD and releasing microphone...');
      this.vadInstance.destroy();
      this.vadInstance = null;
      this.isListening = false;
      this.isVadReady = false; // VAD is no longer ready, will need to reinitialize
      this.dispatchEvent(
        new CustomEvent('vadListeningChanged', {
          detail: { isListening: false },
        })
      );
    }

    // Cleanup RNNoise resources
    this.cleanupRNNoise();
  }

  /**
   * Check if VAD is ready
   */
  isReady() {
    return this.isVadReady;
  }

  /**
   * Check if currently listening
   */
  getIsListening() {
    return this.isListening;
  }

  // Private Methods

  /**
   * Handle speech start event
   */
  handleSpeechStart() {
    console.log('Speech started');
    vadDebugCounters.trueStarts++;

    // Dispatch barge-in event for audio interruption
    this.dispatchEvent(new CustomEvent('speechStart'));
    this.dispatchEvent(new CustomEvent('bargeIn'));
  }

  /**
   * Handle speech end event with audio processing
   */
  async handleSpeechEnd(audio) {
    console.log('Speech ended, audio length:', audio.length);
    this.dispatchEvent(new CustomEvent('speechEnd'));

    // Apply RMS energy gate before processing with dynamic threshold
    const rmsEnergy = this.calculateRMS(audio);
    const dynamicThreshold = this.getDynamicRMSThreshold();
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

    // Step 1: Gather context information
    const datetime = this.getCurrentDateTime();
    const timezone = this.getClientTimezone();
    const clientDatetime = this.getClientDateTime();

    const context = {
      datetime: datetime.readable,
      timezone: timezone,
      clientDatetime: clientDatetime,
    };

    // Step 2: Apply noise reduction if enabled and available
    let processedAudio = audio;
    if (
      this.isNoiseReductionEnabled &&
      this.rnnoiseModule &&
      this.rnnoiseState
    ) {
      try {
        processedAudio = await this.denoiseAudio(audio);
        console.log('Applied noise reduction to audio');
      } catch (error) {
        console.warn('Noise reduction failed, using original audio:', error);
        processedAudio = audio;
      }
    }

    // Step 3: Convert to 16-bit PCM
    const int16Array = new Int16Array(processedAudio.length);
    for (let i = 0; i < processedAudio.length; i++) {
      const s = Math.max(-1, Math.min(1, processedAudio[i]));
      int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    console.log(
      'Processed audio data as Int16:',
      int16Array.byteLength,
      'bytes'
    );

    // Dispatch audio processed event with context and audio data
    this.dispatchEvent(
      new CustomEvent('audioProcessed', {
        detail: {
          audioData: int16Array.buffer,
          context: context,
          originalLength: processedAudio.length,
          hasNoiseReduction: this.isNoiseReductionEnabled && this.rnnoiseModule,
        },
      })
    );
  }

  /**
   * Handle VAD misfire event
   */
  handleVADMisfire() {
    console.log('VAD misfire');
    vadDebugCounters.falseStarts++;
    this.dispatchEvent(new CustomEvent('vadMisfire'));
  }

  /**
   * Calculate RMS energy of audio buffer for pre-VAD gating
   */
  calculateRMS(audioBuffer) {
    if (!audioBuffer || audioBuffer.length === 0) {
      return 0;
    }

    let sum = 0;
    for (let i = 0; i < audioBuffer.length; i++) {
      sum += audioBuffer[i] * audioBuffer[i];
    }

    return Math.sqrt(sum / audioBuffer.length);
  }

  /**
   * Get dynamic RMS threshold based on TTS playing state
   */
  getDynamicRMSThreshold() {
    // Check if audio is playing via event system
    // Default to base threshold, can be updated via events
    return RMS_ENERGY_THRESHOLD;
  }

  /**
   * Log VAD statistics for monitoring and tuning
   */
  logVADStats() {
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

  // RNNoise Helper Functions

  /**
   * Initialize RNNoise WASM module
   */
  async initializeRNNoise() {
    try {
      console.log('Initializing RNNoise...');
      this.dispatchEvent(
        new CustomEvent('vadStatus', {
          detail: {
            message: 'Loading noise reduction module...',
            type: 'system',
          },
        })
      );

      // Load the RNNoise WASM module with proper error handling
      try {
        this.rnnoiseModule = await createRNNWasmModule();
        await this.rnnoiseModule.ready;
      } catch (moduleError) {
        console.warn('RNNoise WASM module failed to load:', moduleError);
        this.dispatchEvent(
          new CustomEvent('vadStatus', {
            detail: {
              message: 'Noise reduction not available - continuing without it',
              type: 'system',
            },
          })
        );
        return;
      }

      // Initialize RNNoise
      this.rnnoiseModule._rnnoise_init();

      // Create noise reduction state
      this.rnnoiseState = this.rnnoiseModule._rnnoise_create();
      if (!this.rnnoiseState) {
        throw new Error('Failed to create RNNoise state');
      }

      // Allocate persistent input/output buffers (480 samples * 4 bytes per Float32)
      const bufferSize = 480 * 4;
      this.inputBuffer = this.rnnoiseModule._malloc(bufferSize);
      this.outputBuffer = this.rnnoiseModule._malloc(bufferSize);

      if (!this.inputBuffer || !this.outputBuffer) {
        throw new Error('Failed to allocate RNNoise buffers');
      }

      console.log('RNNoise initialized successfully');
      this.dispatchEvent(
        new CustomEvent('vadStatus', {
          detail: { message: 'Noise reduction ready', type: 'system' },
        })
      );
    } catch (error) {
      console.warn('RNNoise initialization failed:', error);
      this.dispatchEvent(
        new CustomEvent('vadStatus', {
          detail: {
            message: `Noise reduction unavailable: ${error.message}`,
            type: 'system',
          },
        })
      );

      // Cleanup on failure
      this.cleanupRNNoise();
    }
  }

  /**
   * Process audio through RNNoise noise reduction
   */
  async denoiseAudio(audioBuffer) {
    if (
      !this.rnnoiseModule ||
      !this.rnnoiseState ||
      !this.inputBuffer ||
      !this.outputBuffer
    ) {
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
        const processedFrame = await this.processFrame(frame);

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

  /**
   * Process a single 480-sample frame through RNNoise
   */
  async processFrame(inputSamples) {
    if (
      !this.rnnoiseModule ||
      !this.rnnoiseState ||
      !this.inputBuffer ||
      !this.outputBuffer
    ) {
      return inputSamples;
    }

    try {
      // Copy input samples to WASM memory
      const inputHeap = new Float32Array(
        this.rnnoiseModule.HEAPF32.buffer,
        this.inputBuffer,
        480
      );
      inputHeap.set(inputSamples);

      // Process frame
      this.rnnoiseModule._rnnoise_process_frame(
        this.rnnoiseState,
        this.outputBuffer,
        this.inputBuffer
      );

      // Copy output samples from WASM memory
      const outputHeap = new Float32Array(
        this.rnnoiseModule.HEAPF32.buffer,
        this.outputBuffer,
        480
      );
      return new Float32Array(outputHeap);
    } catch (error) {
      console.error('Error processing frame:', error);
      return inputSamples; // Return original frame on error
    }
  }

  /**
   * Cleanup RNNoise resources
   */
  cleanupRNNoise() {
    try {
      if (this.rnnoiseModule) {
        if (this.rnnoiseState) {
          this.rnnoiseModule._rnnoise_destroy(this.rnnoiseState);
          this.rnnoiseState = null;
        }

        if (this.inputBuffer) {
          this.rnnoiseModule._free(this.inputBuffer);
          this.inputBuffer = null;
        }

        if (this.outputBuffer) {
          this.rnnoiseModule._free(this.outputBuffer);
          this.outputBuffer = null;
        }
      }

      console.log('RNNoise resources cleaned up');
    } catch (error) {
      console.error('Error cleaning up RNNoise:', error);
    }
  }

  // Utility Functions

  /**
   * Get client timezone using browser API
   */
  getClientTimezone() {
    try {
      // Use Intl.DateTimeFormat to get the timezone
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      console.warn('Failed to detect client timezone:', error);
      return 'UTC';
    }
  }

  /**
   * Get current client datetime in ISO format
   */
  getClientDateTime() {
    try {
      return new Date().toISOString();
    } catch (error) {
      console.warn('Failed to get client datetime:', error);
      return new Date().toISOString();
    }
  }

  /**
   * Get formatted current datetime
   */
  getCurrentDateTime() {
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

  /**
   * Update RMS threshold based on audio playing state
   */
  updateRMSThreshold(isAudioPlaying) {
    // This can be called by other modules to adjust sensitivity during TTS playback
    this.isAudioPlaying = isAudioPlaying;
  }

  /**
   * Get dynamic RMS threshold based on audio playing state
   */
  getDynamicRMSThreshold() {
    // Increase threshold during TTS playback to prevent audio feedback loops
    return this.isAudioPlaying
      ? RMS_ENERGY_THRESHOLD * 3
      : RMS_ENERGY_THRESHOLD;
  }

  /**
   * Custom event emitter for consistency with other modules
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
   * Pause listening (compatibility method)
   */
  pauseListening() {
    // The VAD library might not support pause, so we just track state
    if (this.vadInstance && this.isListening) {
      this.isListening = false;
      // Don't destroy the instance, just stop processing
    }
  }

  /**
   * Resume listening (compatibility method)
   */
  resumeListening() {
    // Resume by setting listening state back
    if (this.vadInstance && !this.isListening) {
      this.isListening = true;
    }
  }

  /**
   * Destroy VAD instance (compatibility method)
   */
  destroy() {
    this.stopListening();
  }
}

// Create and export singleton instance
const vadManager = new VADManager();
export default vadManager;

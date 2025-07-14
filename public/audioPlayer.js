/**
 * AudioPlayer - Hybrid audio playback module
 * Uses Web Audio API for PCM streaming and Howler.js for MP3 playback
 */
class AudioPlayer {
  constructor() {
    // Audio contexts
    this.audioContext = null;
    this.isInitialized = false;
    this.audioUnlocked = false;

    // Playback state
    this.currentlyPlaying = false;
    this.nextScheduledTime = 0;

    // Queue management
    this.audioQueue = [];
    this.pendingQueue = [];
    this.scheduledSources = new Map(); // Track Web Audio sources
    this.howlSources = new Map(); // Track Howler.js sources
    this.sourceCounter = 0;

    // Configuration
    this.pitchFactor = 1.0;
    this.minLeadTime = 0.1; // Reduced from 0.15 for lower latency
    this.crossfadeDuration = 0.005; // 5ms crossfade
    this.isMobile = this.isMobileBrowser();

    // Event callbacks
    this.onStart = null;
    this.onFinish = null;
    this.onCancel = null;
    this.onAutoplayBlocked = null;

    // Processing state
    this.isProcessingQueue = false;

    console.log(
      'AudioPlayer: Hybrid Web Audio API + Howler.js player initialized'
    );
  }

  /**
   * Detect if running on a mobile browser
   */
  isMobileBrowser() {
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
   * Check if user gesture is required for audio playback
   */
  requiresUserGesture() {
    return !this.audioUnlocked;
  }

  /**
   * Initialize Web Audio API context
   */
  async initializeAudioContext() {
    if (this.audioContext) {
      return;
    }

    try {
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();

      // Try to resume if suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.isInitialized = true;
      console.log('AudioPlayer: Web Audio API initialized', {
        sampleRate: this.audioContext.sampleRate,
        state: this.audioContext.state,
      });
    } catch (error) {
      console.error('AudioPlayer: Failed to initialize Web Audio API:', error);
      throw error;
    }
  }

  /**
   * Unlock audio playback (must be called in response to user gesture)
   */
  async unlock() {
    if (this.audioUnlocked) {
      console.log('AudioPlayer: Audio already unlocked');
      return true;
    }

    try {
      // Initialize Web Audio API first
      await this.initializeAudioContext();

      // Test with Howler.js for compatibility
      const testSound = new Howl({
        src: [
          'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmYZBTKO1e7SdigGLHTD7eCWRAkTUqnn8rBqHAVKm9jy2lUrBBthvNq6aR0FTYvi9M14LQQpcruF2lYrBhlfveO+aSENQJbY9d56MgMjcLOHzk8pBhpdut+6aB0FTobp9c17IgQkcMKI0k8qBhNZtN99aR0DOYvZ8tJyJgckcNqK3VcuCA==',
        ],
        volume: 0,
        html5: false,
      });

      return new Promise((resolve) => {
        // Set up unlock detection
        const checkUnlocked = () => {
          if (this.audioContext.state === 'running') {
            this.audioUnlocked = true;
            console.log('AudioPlayer: Audio unlocked successfully');
            testSound.unload();
            this.processPendingQueue();
            resolve(true);
          }
        };

        testSound.once('unlock', checkUnlocked);
        testSound.once('load', checkUnlocked);

        // Attempt to play the test sound
        testSound.play();

        // Also try to resume audio context directly
        if (this.audioContext.state === 'suspended') {
          this.audioContext
            .resume()
            .then(checkUnlocked)
            .catch(() => {
              // Ignore resume errors, test sound should handle it
            });
        }

        // Fallback - assume unlocked after delay
        setTimeout(() => {
          if (!this.audioUnlocked) {
            this.audioUnlocked = true;
            console.log('AudioPlayer: Audio unlocked via fallback method');
            testSound.unload();
            this.processPendingQueue();
            resolve(true);
          }
        }, 1000);
      });
    } catch (error) {
      console.error('AudioPlayer: Failed to unlock audio:', error);
      return false;
    }
  }

  /**
   * Process pending audio queue after unlock
   */
  async processPendingQueue() {
    if (this.pendingQueue.length === 0) {
      return;
    }

    console.log(
      `AudioPlayer: Processing ${this.pendingQueue.length} pending audio chunks`
    );

    // Move pending chunks to main queue
    this.audioQueue.push(...this.pendingQueue);
    this.pendingQueue = [];

    // Process the queue
    await this.processAudioQueue();
  }

  /**
   * Set the pitch/playback rate factor
   */
  setPitchFactor(factor) {
    if (typeof factor !== 'number' || factor <= 0 || factor > 10) {
      console.warn(
        'AudioPlayer: Invalid pitch factor. Must be between 0 and 10.'
      );
      return;
    }
    this.pitchFactor = factor;
    console.log(`AudioPlayer: Pitch factor set to ${factor}`);
  }

  /**
   * Convert PCM data to AudioBuffer for Web Audio API
   * @param {string|Int16Array|ArrayBuffer} data - PCM data
   * @param {number} sampleRate - Sample rate (default: 16000)
   * @returns {AudioBuffer} - Web Audio API buffer
   */
  async convertPCMToAudioBuffer(data, sampleRate = 16000) {
    if (!this.audioContext) {
      await this.initializeAudioContext();
    }

    let pcmData;

    if (typeof data === 'string') {
      // Base64 encoded PCM
      const binaryString = atob(data);
      const uint8Array = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        uint8Array[i] = binaryString.charCodeAt(i);
      }

      // Ensure even length for 16-bit samples
      if (uint8Array.length % 2 !== 0) {
        const paddedArray = new Uint8Array(uint8Array.length + 1);
        paddedArray.set(uint8Array);
        paddedArray[uint8Array.length] = 0;
        pcmData = new Int16Array(paddedArray.buffer);
      } else {
        pcmData = new Int16Array(uint8Array.buffer);
      }
    } else if (data instanceof Int16Array) {
      pcmData = data;
    } else if (data instanceof ArrayBuffer) {
      pcmData = new Int16Array(data);
    } else {
      throw new Error('Unsupported PCM data format');
    }

    // Convert Int16 PCM to Float32 for Web Audio API
    const float32Array = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      float32Array[i] = pcmData[i] / 32768.0; // Normalize to [-1, 1]
    }

    // Create AudioBuffer
    const audioBuffer = this.audioContext.createBuffer(
      1, // Mono
      Math.ceil(
        (float32Array.length * this.audioContext.sampleRate) / sampleRate
      ),
      this.audioContext.sampleRate
    );

    // Resample if needed
    if (this.audioContext.sampleRate !== sampleRate) {
      this.resampleAudio(float32Array, audioBuffer, sampleRate);
    } else {
      audioBuffer.copyToChannel(float32Array, 0);
    }

    return audioBuffer;
  }

  /**
   * Simple linear interpolation resampling
   */
  resampleAudio(inputData, outputBuffer, inputSampleRate) {
    const outputData = outputBuffer.getChannelData(0);
    const ratio = inputSampleRate / this.audioContext.sampleRate;

    for (let i = 0; i < outputData.length; i++) {
      const inputIndex = i * ratio;
      const inputIndexFloor = Math.floor(inputIndex);
      const inputIndexCeil = Math.min(
        inputIndexFloor + 1,
        inputData.length - 1
      );
      const fraction = inputIndex - inputIndexFloor;

      outputData[i] =
        inputData[inputIndexFloor] * (1 - fraction) +
        inputData[inputIndexCeil] * fraction;
    }
  }

  /**
   * Schedule an AudioBuffer for seamless playback
   */
  scheduleAudioBuffer(audioBuffer, startTime) {
    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();

    source.buffer = audioBuffer;
    source.playbackRate.value = this.pitchFactor;
    source.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    // Apply gentle crossfade
    const fadeInEnd = startTime + this.crossfadeDuration;
    const fadeOutStart =
      startTime +
      audioBuffer.duration / this.pitchFactor -
      this.crossfadeDuration;

    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(1, fadeInEnd);

    if (audioBuffer.duration / this.pitchFactor > this.crossfadeDuration * 2) {
      gainNode.gain.setValueAtTime(1, fadeOutStart);
      gainNode.gain.linearRampToValueAtTime(
        0,
        startTime + audioBuffer.duration / this.pitchFactor
      );
    }

    // Track source
    const sourceId = `pcm_${++this.sourceCounter}`;
    this.scheduledSources.set(sourceId, source);

    // Clean up when finished
    source.onended = () => {
      this.scheduledSources.delete(sourceId);
      source.disconnect();
      gainNode.disconnect();

      // Check if this was the last source
      if (
        this.scheduledSources.size === 0 &&
        this.howlSources.size === 0 &&
        this.audioQueue.length === 0
      ) {
        this.currentlyPlaying = false;
        if (this.onFinish) {
          this.onFinish();
        }
      }
    };

    // Start playback
    source.start(startTime);
    console.log(
      `AudioPlayer: Scheduled PCM source ${sourceId} at ${startTime.toFixed(3)}s`
    );

    return source;
  }

  /**
   * Process the audio queue with improved timing
   */
  async processAudioQueue() {
    if (this.isProcessingQueue || this.audioQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    try {
      // Check if user gesture is required
      if (this.requiresUserGesture()) {
        console.log('AudioPlayer: Audio locked, moving to pending queue');
        this.pendingQueue.push(...this.audioQueue);
        this.audioQueue = [];

        if (this.onAutoplayBlocked) {
          this.onAutoplayBlocked();
        }
        return;
      }

      // Ensure audio context is ready
      if (!this.audioContext || this.audioContext.state !== 'running') {
        await this.initializeAudioContext();
      }

      const currentTime = this.audioContext.currentTime;

      // Initialize or fix scheduling time
      if (this.nextScheduledTime <= currentTime) {
        this.nextScheduledTime = currentTime + this.minLeadTime;
        console.log(
          `AudioPlayer: Reset scheduling time to ${this.nextScheduledTime.toFixed(3)}s`
        );
      }

      // Process all queued chunks
      while (this.audioQueue.length > 0) {
        const chunk = this.audioQueue.shift();

        try {
          // Convert PCM chunk to AudioBuffer
          let audioBuffer;

          if (typeof chunk === 'string') {
            audioBuffer = await this.convertPCMToAudioBuffer(chunk);
          } else if (chunk instanceof Int16Array) {
            audioBuffer = await this.convertPCMToAudioBuffer(
              chunk,
              chunk.sampleRate || 16000
            );
          } else if (
            chunk.data instanceof Int16Array &&
            typeof chunk.sampleRate === 'number'
          ) {
            audioBuffer = await this.convertPCMToAudioBuffer(
              chunk.data,
              chunk.sampleRate
            );
          } else {
            throw new Error('Unsupported audio chunk format');
          }

          // Schedule the chunk
          this.scheduleAudioBuffer(audioBuffer, this.nextScheduledTime);

          // Update next scheduled time
          this.nextScheduledTime += audioBuffer.duration / this.pitchFactor;

          // Trigger onStart callback for first chunk
          if (!this.currentlyPlaying) {
            this.currentlyPlaying = true;
            if (this.onStart) {
              this.onStart();
            }
          }
        } catch (error) {
          console.error('AudioPlayer: Failed to process PCM chunk:', error);
          // Continue processing remaining chunks
        }
      }
    } catch (error) {
      console.error('AudioPlayer: Failed to process audio queue:', error);
    } finally {
      this.isProcessingQueue = false;
    }
  }

  /**
   * Add a PCM audio chunk to the playback queue
   */
  async enqueue(chunk) {
    if (!chunk) {
      console.warn('AudioPlayer: Invalid audio chunk provided');
      return;
    }

    // Validate chunk format
    const isValidChunk =
      typeof chunk === 'string' ||
      chunk instanceof Int16Array ||
      (chunk &&
        chunk.data instanceof Int16Array &&
        typeof chunk.sampleRate === 'number');

    if (!isValidChunk) {
      console.warn('AudioPlayer: Invalid audio chunk format');
      return;
    }

    try {
      // Add to appropriate queue
      if (this.requiresUserGesture()) {
        console.log(
          'AudioPlayer: Queueing PCM chunk - waiting for user gesture'
        );
        this.pendingQueue.push(chunk);
        return;
      }

      // Add to queue
      this.audioQueue.push(chunk);

      // Process the queue
      await this.processAudioQueue();
    } catch (error) {
      console.error('AudioPlayer: Failed to enqueue PCM chunk:', error);
    }
  }

  /**
   * Play base64-encoded MP3/WAV audio using Howler.js
   */
  async playBase64Audio(base64AudioData) {
    if (!base64AudioData || typeof base64AudioData !== 'string') {
      console.warn('AudioPlayer: Invalid base64 audio data provided');
      return;
    }

    // Check if user gesture is required
    if (this.requiresUserGesture()) {
      console.log('AudioPlayer: Cannot play audio - user gesture required');
      throw new Error('NotAllowedError: Audio playback requires user gesture');
    }

    try {
      // Stop existing playback for barge-in
      if (this.isPlaying()) {
        console.log('AudioPlayer: Stopping existing playback for barge-in');
        this.stop();
      }

      // Create data URL (assume MP3 format)
      const dataUrl = `data:audio/mpeg;base64,${base64AudioData}`;
      const sourceId = `mp3_${++this.sourceCounter}`;

      // Create Howl instance
      const howl = new Howl({
        src: [dataUrl],
        format: ['mp3'],
        volume: 1.0,
        rate: this.pitchFactor,
        html5: false,
        preload: true,
      });

      // Set up event handlers
      howl.once('play', () => {
        console.log(`AudioPlayer: MP3 source ${sourceId} started`);
        if (!this.currentlyPlaying) {
          this.currentlyPlaying = true;
          if (this.onStart) {
            this.onStart();
          }
        }
      });

      howl.once('end', () => {
        console.log(`AudioPlayer: MP3 source ${sourceId} finished`);
        this.howlSources.delete(sourceId);
        howl.unload();

        // Check if this was the last source
        if (
          this.scheduledSources.size === 0 &&
          this.howlSources.size === 0 &&
          this.audioQueue.length === 0
        ) {
          this.currentlyPlaying = false;
          if (this.onFinish) {
            this.onFinish();
          }
        }
      });

      howl.once('loaderror', (id, error) => {
        console.error(
          `AudioPlayer: MP3 source ${sourceId} failed to load:`,
          error
        );
        this.howlSources.delete(sourceId);
        howl.unload();
      });

      // Store reference and play
      this.howlSources.set(sourceId, howl);
      howl.play();

      console.log('AudioPlayer: Started MP3 playback');
    } catch (error) {
      console.error('AudioPlayer: Failed to play MP3 audio:', error);

      this.currentlyPlaying = false;
      if (this.onCancel) {
        this.onCancel();
      }

      throw error;
    }
  }

  /**
   * Stop all audio playback
   */
  stop() {
    try {
      // Stop Web Audio API sources
      for (const [sourceId, source] of this.scheduledSources) {
        try {
          source.stop();
          source.disconnect();
        } catch (error) {
          console.debug(
            `AudioPlayer: Error stopping PCM source ${sourceId}:`,
            error
          );
        }
      }

      // Stop Howler.js sources
      for (const [sourceId, howl] of this.howlSources) {
        try {
          howl.stop();
          howl.unload();
        } catch (error) {
          console.debug(
            `AudioPlayer: Error stopping MP3 source ${sourceId}:`,
            error
          );
        }
      }

      // Clear all tracking
      this.scheduledSources.clear();
      this.howlSources.clear();
      this.audioQueue = [];
      this.pendingQueue = [];
      this.isProcessingQueue = false;

      // Reset state
      this.currentlyPlaying = false;
      this.nextScheduledTime = 0;

      // Trigger cancel callback
      if (this.onCancel) {
        this.onCancel();
      }

      console.log('AudioPlayer: All audio stopped');
    } catch (error) {
      console.error('AudioPlayer: Error stopping audio:', error);
    }
  }

  /**
   * Clear the audio queue without stopping current playback
   */
  flush() {
    try {
      this.audioQueue = [];
      this.pendingQueue = [];
      console.log('AudioPlayer: Audio queue flushed');
    } catch (error) {
      console.error('AudioPlayer: Error flushing queue:', error);
    }
  }

  /**
   * Check if audio is currently playing
   */
  isPlaying() {
    return (
      this.currentlyPlaying ||
      this.scheduledSources.size > 0 ||
      this.howlSources.size > 0
    );
  }

  /**
   * Get current audio player state information
   */
  getState() {
    return {
      isInitialized: this.isInitialized,
      isPlaying: this.isPlaying(),
      queueLength: this.audioQueue.length,
      pendingQueueLength: this.pendingQueue.length,
      scheduledSources: this.scheduledSources.size,
      howlSources: this.howlSources.size,
      audioContextState: this.audioContext?.state,
      nextScheduledTime: this.nextScheduledTime,
      currentTime: this.audioContext?.currentTime,
      isMobile: this.isMobile,
      audioUnlocked: this.audioUnlocked,
      requiresUserGesture: this.requiresUserGesture(),
      pitchFactor: this.pitchFactor,
      isProcessingQueue: this.isProcessingQueue,
    };
  }
}

// Export as default ES module
export default AudioPlayer;

/**
 * AudioPlayer - Seamless streaming audio playback module
 * Handles PCM audio chunks with precise scheduling to eliminate gaps
 */
class AudioPlayer {
  constructor() {
    this.audioContext = null;
    this.nextScheduledTime = 0;
    this.isInitialized = false;
    this.audioQueue = [];
    this.scheduledSources = new Set();
    this.currentlyPlaying = false;
    this.minLeadTime = 0.15; // 150ms minimum lead time
    this.crossfadeDuration = 0.005; // 5ms crossfade to eliminate clicks

    // Mobile autoplay compliance
    this.audioUnlocked = false;
    this.pendingQueue = [];
    this.isMobile = this.isMobileBrowser();

    // Event callbacks
    this.onStart = null;
    this.onFinish = null;
    this.onCancel = null;

    // Only auto-initialize on desktop browsers
    if (!this.isMobile) {
      this.initializeAudioContext();
    }
  }

  /**
   * Detect if running on a mobile browser
   * @returns {boolean} - True if mobile browser detected
   */
  isMobileBrowser() {
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;

    // Check for mobile user agents
    const mobileRegex =
      /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i;
    const isMobileUA = mobileRegex.test(userAgent.toLowerCase());

    // Check for touch capability
    const hasTouchScreen =
      'ontouchstart' in window || navigator.maxTouchPoints > 0;

    // Check for specific mobile browsers
    const isIOS = /iPad|iPhone|iPod/.test(userAgent) && !window.MSStream;
    const isAndroid = /Android/.test(userAgent);
    const isMobileSafari =
      isIOS && /Safari/.test(userAgent) && !/CriOS|FxiOS/.test(userAgent);
    const isMobileChrome = (isAndroid || isIOS) && /Chrome/.test(userAgent);

    return (
      isMobileUA ||
      hasTouchScreen ||
      isIOS ||
      isAndroid ||
      isMobileSafari ||
      isMobileChrome
    );
  }

  /**
   * Check if user gesture is required for audio playback
   * @returns {boolean} - True if user gesture is needed
   */
  requiresUserGesture() {
    return this.isMobile && !this.audioUnlocked;
  }

  /**
   * Unlock audio playback (must be called in response to user gesture)
   * @returns {Promise<boolean>} - True if unlock successful
   */
  async unlock() {
    if (this.audioUnlocked) {
      console.log('AudioPlayer: Audio already unlocked');
      return true;
    }

    try {
      // Initialize AudioContext if not already done
      if (!this.isInitialized) {
        await this.initializeAudioContext();
      }

      // Resume AudioContext if suspended
      if (this.audioContext && this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Set unlock flag
      this.audioUnlocked = true;

      console.log('AudioPlayer: Audio unlocked successfully');

      // Process any pending audio
      await this.processPendingQueue();

      return true;
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
   * Initialize the Web Audio API context
   */
  async initializeAudioContext() {
    try {
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();

      // Handle audio context state changes
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      this.isInitialized = true;
      console.log('AudioPlayer: AudioContext initialized', {
        sampleRate: this.audioContext.sampleRate,
        state: this.audioContext.state,
      });
    } catch (error) {
      console.error('AudioPlayer: Failed to initialize AudioContext:', error);
      this.isInitialized = false;
    }
  }

  /**
   * Ensure audio context is ready for use
   */
  async ensureAudioContextReady() {
    // Check if user gesture is required on mobile
    if (this.requiresUserGesture()) {
      throw new Error(
        'NotAllowedError: Audio playback requires user gesture on mobile browsers'
      );
    }

    if (!this.isInitialized || !this.audioContext) {
      await this.initializeAudioContext();
    }

    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        console.log('AudioPlayer: AudioContext resumed');
      } catch (error) {
        // Handle common mobile autoplay errors
        if (error.name === 'NotAllowedError') {
          console.error(
            'AudioPlayer: Audio playback not allowed - user gesture required'
          );
          throw new Error(
            'NotAllowedError: Audio playback requires user gesture'
          );
        }
        console.error('AudioPlayer: Failed to resume AudioContext:', error);
        throw error;
      }
    }
  }

  /**
   * Convert base64 PCM data to AudioBuffer
   * @param {string} base64Data - Base64 encoded PCM audio data
   * @returns {Promise<AudioBuffer>} - Decoded audio buffer
   */
  async convertPCMToAudioBuffer(base64Data) {
    try {
      // Convert base64 to Uint8Array
      const binaryString = atob(base64Data);
      const uint8Array = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        uint8Array[i] = binaryString.charCodeAt(i);
      }

      // Ensure buffer length is even for Int16Array (16-bit PCM requires pairs of bytes)
      let processedBuffer;
      if (uint8Array.length % 2 !== 0) {
        console.warn(
          'AudioPlayer: PCM data has odd byte length, padding with zero'
        );
        // Create a new buffer with even length
        processedBuffer = new Uint8Array(uint8Array.length + 1);
        processedBuffer.set(uint8Array);
        processedBuffer[uint8Array.length] = 0; // Pad with zero
      } else {
        processedBuffer = uint8Array;
      }

      // Convert Uint8Array to Int16Array (16-bit PCM)
      const int16Array = new Int16Array(processedBuffer.buffer);

      // Convert Int16Array to Float32Array (normalized to [-1, 1])
      const float32Array = new Float32Array(int16Array.length);
      for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
      }

      // Create AudioBuffer
      const sampleRate = 16000; // Input PCM is 16kHz
      const numberOfChannels = 1; // Mono
      const length = float32Array.length;

      // Create buffer with target sample rate
      const audioBuffer = this.audioContext.createBuffer(
        numberOfChannels,
        Math.ceil((length * this.audioContext.sampleRate) / sampleRate),
        this.audioContext.sampleRate
      );

      // Resample if needed
      if (this.audioContext.sampleRate !== sampleRate) {
        this.resampleAudio(float32Array, audioBuffer, sampleRate);
      } else {
        // Direct copy for same sample rate
        audioBuffer.copyToChannel(float32Array, 0);
      }

      return audioBuffer;
    } catch (error) {
      console.error(
        'AudioPlayer: Failed to convert PCM to AudioBuffer:',
        error
      );
      throw error;
    }
  }

  /**
   * Resample audio data to match AudioContext sample rate
   * @param {Float32Array} inputData - Input audio samples
   * @param {AudioBuffer} outputBuffer - Output audio buffer
   * @param {number} inputSampleRate - Input sample rate
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

      // Linear interpolation
      outputData[i] =
        inputData[inputIndexFloor] * (1 - fraction) +
        inputData[inputIndexCeil] * fraction;
    }
  }

  /**
   * Schedule an audio buffer for playback with precise timing
   * @param {AudioBuffer} audioBuffer - Audio buffer to play
   * @param {number} startTime - When to start playback
   * @returns {AudioBufferSourceNode} - The scheduled source node
   */
  scheduleAudioBuffer(audioBuffer, startTime) {
    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();

    source.buffer = audioBuffer;
    source.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    // Apply crossfade to eliminate clicks/pops
    const fadeInEnd = startTime + this.crossfadeDuration;
    const fadeOutStart =
      startTime + audioBuffer.duration - this.crossfadeDuration;

    gainNode.gain.setValueAtTime(0, startTime);
    gainNode.gain.linearRampToValueAtTime(1, fadeInEnd);

    if (audioBuffer.duration > this.crossfadeDuration * 2) {
      gainNode.gain.setValueAtTime(1, fadeOutStart);
      gainNode.gain.linearRampToValueAtTime(
        0,
        startTime + audioBuffer.duration
      );
    }

    // Track source for cancellation
    this.scheduledSources.add(source);

    // Clean up when finished
    source.onended = () => {
      this.scheduledSources.delete(source);
      source.disconnect();
      gainNode.disconnect();

      // Check if this was the last scheduled source
      if (this.scheduledSources.size === 0 && this.audioQueue.length === 0) {
        this.currentlyPlaying = false;
        if (this.onFinish) {
          this.onFinish();
        }
      }
    };

    // Start playback
    source.start(startTime);

    return source;
  }

  /**
   * Process the audio queue and schedule chunks for seamless playback
   */
  async processAudioQueue() {
    if (!this.isInitialized || this.audioQueue.length === 0) {
      return;
    }

    try {
      await this.ensureAudioContextReady();

      const currentTime = this.audioContext.currentTime;

      // Initialize scheduling time if not set
      if (this.nextScheduledTime <= currentTime) {
        this.nextScheduledTime = currentTime + this.minLeadTime;
      }

      // Process all queued chunks
      while (this.audioQueue.length > 0) {
        const base64Chunk = this.audioQueue.shift();

        try {
          const audioBuffer = await this.convertPCMToAudioBuffer(base64Chunk);

          // Schedule the chunk
          this.scheduleAudioBuffer(audioBuffer, this.nextScheduledTime);

          // Update next scheduled time
          this.nextScheduledTime += audioBuffer.duration;

          // Trigger onStart callback for first chunk
          if (!this.currentlyPlaying) {
            this.currentlyPlaying = true;
            if (this.onStart) {
              this.onStart();
            }
          }
        } catch (error) {
          console.error('AudioPlayer: Failed to process audio chunk:', error);
          // Continue processing remaining chunks
        }
      }
    } catch (error) {
      console.error('AudioPlayer: Failed to process audio queue:', error);
    }
  }

  /**
   * Add an audio chunk to the playback queue
   * @param {string} base64Chunk - Base64 encoded PCM audio data
   */
  async enqueue(base64Chunk) {
    if (!base64Chunk || typeof base64Chunk !== 'string') {
      console.warn('AudioPlayer: Invalid audio chunk provided');
      return;
    }

    try {
      // Check if user gesture is required
      if (this.requiresUserGesture()) {
        console.log(
          'AudioPlayer: Queueing audio chunk - waiting for user gesture'
        );
        this.pendingQueue.push(base64Chunk);
        return;
      }

      // Add to queue
      this.audioQueue.push(base64Chunk);

      // Process the queue
      await this.processAudioQueue();
    } catch (error) {
      console.error('AudioPlayer: Failed to enqueue audio chunk:', error);
    }
  }

  /**
   * Play base64-encoded MP3 audio data for single-shot TTS playback
   * @param {string} base64AudioData - Base64 encoded MP3 audio data
   */
  async playBase64Audio(base64AudioData) {
    // Input validation
    if (!base64AudioData || typeof base64AudioData !== 'string') {
      console.warn('AudioPlayer: Invalid base64 audio data provided');
      return;
    }

    // Check if user gesture is required
    if (this.requiresUserGesture()) {
      console.log(
        'AudioPlayer: Cannot play audio - user gesture required on mobile'
      );
      throw new Error(
        'NotAllowedError: Audio playback requires user gesture on mobile browsers'
      );
    }

    try {
      // Audio context preparation
      await this.ensureAudioContextReady();

      // Barge-in support - stop existing playback
      if (this.isPlaying()) {
        console.log('AudioPlayer: Stopping existing playback for barge-in');
        this.stop();
      }

      // Audio decoding - convert base64 to ArrayBuffer
      const binaryString = atob(base64AudioData);
      const uint8Array = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        uint8Array[i] = binaryString.charCodeAt(i);
      }

      // Decode MP3 audio data
      const audioBuffer = await this.audioContext.decodeAudioData(
        uint8Array.buffer
      );

      // Playback setup
      const source = this.audioContext.createBufferSource();
      const gainNode = this.audioContext.createGain();

      source.buffer = audioBuffer;
      source.connect(gainNode);
      gainNode.connect(this.audioContext.destination);

      // Apply crossfade effects (reuse logic from scheduleAudioBuffer)
      const currentTime = this.audioContext.currentTime;
      const startTime = currentTime;
      const fadeInEnd = startTime + this.crossfadeDuration;
      const fadeOutStart =
        startTime + audioBuffer.duration - this.crossfadeDuration;

      gainNode.gain.setValueAtTime(0, startTime);
      gainNode.gain.linearRampToValueAtTime(1, fadeInEnd);

      if (audioBuffer.duration > this.crossfadeDuration * 2) {
        gainNode.gain.setValueAtTime(1, fadeOutStart);
        gainNode.gain.linearRampToValueAtTime(
          0,
          startTime + audioBuffer.duration
        );
      }

      // State management
      this.currentlyPlaying = true;
      this.scheduledSources.add(source);

      // Trigger onStart callback
      if (this.onStart) {
        this.onStart();
      }

      // Handle onended event for cleanup
      source.onended = () => {
        this.scheduledSources.delete(source);
        source.disconnect();
        gainNode.disconnect();

        // Check if this was the last scheduled source
        if (this.scheduledSources.size === 0 && this.audioQueue.length === 0) {
          this.currentlyPlaying = false;
          if (this.onFinish) {
            this.onFinish();
          }
        }
      };

      // Start playback
      source.start(startTime);

      console.log('AudioPlayer: Started MP3 playback', {
        duration: audioBuffer.duration,
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioBuffer.numberOfChannels,
      });
    } catch (error) {
      console.error('AudioPlayer: Failed to play base64 audio:', error);

      // Clean up state on error
      this.currentlyPlaying = false;

      // Trigger cancel callback if needed
      if (this.onCancel) {
        this.onCancel();
      }

      throw error;
    }
  }

  /**
   * Stop all audio playback and cancel scheduled chunks
   */
  stop() {
    try {
      // Cancel all scheduled sources
      for (const source of this.scheduledSources) {
        try {
          source.stop();
          source.disconnect();
        } catch (error) {
          // Source might already be stopped/disconnected
          console.debug('AudioPlayer: Source already stopped:', error);
        }
      }

      // Clear tracking sets
      this.scheduledSources.clear();
      this.audioQueue = [];
      this.pendingQueue = [];

      // Reset state
      this.currentlyPlaying = false;
      this.nextScheduledTime = 0;

      // Trigger cancel callback
      if (this.onCancel) {
        this.onCancel();
      }

      console.log('AudioPlayer: All audio stopped and cancelled');
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
   * @returns {boolean} - True if audio is playing
   */
  isPlaying() {
    return this.currentlyPlaying || this.scheduledSources.size > 0;
  }

  /**
   * Get current audio context state information
   * @returns {object} - Audio context state info
   */
  getState() {
    return {
      isInitialized: this.isInitialized,
      isPlaying: this.isPlaying(),
      queueLength: this.audioQueue.length,
      pendingQueueLength: this.pendingQueue.length,
      scheduledSources: this.scheduledSources.size,
      audioContextState: this.audioContext?.state,
      nextScheduledTime: this.nextScheduledTime,
      currentTime: this.audioContext?.currentTime,
      isMobile: this.isMobile,
      audioUnlocked: this.audioUnlocked,
      requiresUserGesture: this.requiresUserGesture(),
    };
  }
}

// Export as default ES module
export default AudioPlayer;

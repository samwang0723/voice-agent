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
        
        // Event callbacks
        this.onStart = null;
        this.onFinish = null;
        this.onCancel = null;
        
        this.initializeAudioContext();
    }
    
    /**
     * Initialize the Web Audio API context
     */
    async initializeAudioContext() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            
            // Handle audio context state changes
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            this.isInitialized = true;
            console.log('AudioPlayer: AudioContext initialized', {
                sampleRate: this.audioContext.sampleRate,
                state: this.audioContext.state
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
        if (!this.isInitialized || !this.audioContext) {
            await this.initializeAudioContext();
        }
        
        if (this.audioContext.state === 'suspended') {
            try {
                await this.audioContext.resume();
                console.log('AudioPlayer: AudioContext resumed');
            } catch (error) {
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
            
            // Convert Uint8Array to Int16Array (16-bit PCM)
            const int16Array = new Int16Array(uint8Array.buffer);
            
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
                Math.ceil(length * this.audioContext.sampleRate / sampleRate),
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
            console.error('AudioPlayer: Failed to convert PCM to AudioBuffer:', error);
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
            const inputIndexCeil = Math.min(inputIndexFloor + 1, inputData.length - 1);
            const fraction = inputIndex - inputIndexFloor;
            
            // Linear interpolation
            outputData[i] = inputData[inputIndexFloor] * (1 - fraction) + 
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
        const fadeOutStart = startTime + audioBuffer.duration - this.crossfadeDuration;
        
        gainNode.gain.setValueAtTime(0, startTime);
        gainNode.gain.linearRampToValueAtTime(1, fadeInEnd);
        
        if (audioBuffer.duration > this.crossfadeDuration * 2) {
            gainNode.gain.setValueAtTime(1, fadeOutStart);
            gainNode.gain.linearRampToValueAtTime(0, startTime + audioBuffer.duration);
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
            // Add to queue
            this.audioQueue.push(base64Chunk);
            
            // Process the queue
            await this.processAudioQueue();
            
        } catch (error) {
            console.error('AudioPlayer: Failed to enqueue audio chunk:', error);
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
            scheduledSources: this.scheduledSources.size,
            audioContextState: this.audioContext?.state,
            nextScheduledTime: this.nextScheduledTime,
            currentTime: this.audioContext?.currentTime
        };
    }
}

// Export as default ES module
export default AudioPlayer;
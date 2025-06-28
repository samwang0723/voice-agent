class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;

    this.port.onmessage = (event) => {
      if (event.data.type === 'start') {
        this.isRecording = true;
      } else if (event.data.type === 'stop') {
        this.isRecording = false;
      }
    };
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];

    if (input && input.length > 0 && this.isRecording) {
      const inputChannel = input[0];

      if (inputChannel && inputChannel.length > 0) {
        // Check if there's actual audio data (not just silence)
        const hasAudio = inputChannel.some(
          (sample) => Math.abs(sample) > 0.001
        );

        if (hasAudio) {
          // Send audio data to main thread
          this.port.postMessage({
            type: 'audiodata',
            audioData: inputChannel,
            length: inputChannel.length,
            max: Math.max(...inputChannel),
          });
        }
      }
    }

    return true; // Keep the processor alive
  }
}

registerProcessor('audio-processor', AudioProcessor);

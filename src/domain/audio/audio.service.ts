export interface ITranscriptionService {
  transcribe(audio: Buffer): Promise<string>;
}

export interface ITextToSpeechService {
  synthesize(text: string, abortSignal?: AbortSignal): Promise<Buffer | null>;
}

export interface IStreamingTextToSpeechService {
  synthesizeStream(
    textChunks: AsyncIterable<string>,
    abortSignal?: AbortSignal
  ): AsyncIterable<Buffer>;
}

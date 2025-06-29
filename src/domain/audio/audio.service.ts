export interface ITranscriptionService {
  transcribe(audio: Buffer): Promise<string>;
}

export interface ITextToSpeechService {
  synthesize(text: string): Promise<Buffer | null>;
} 
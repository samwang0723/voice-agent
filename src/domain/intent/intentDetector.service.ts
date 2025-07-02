/**
 * Interface for detecting tool intent from user transcripts.
 * This interface allows for future extensibility with different detection algorithms
 * (keyword-based, ML-based, etc.) while maintaining a consistent API.
 */
export interface IToolIntentDetector {
  /**
   * Analyzes a transcript to detect if external tools are required.
   *
   * @param transcript - The user's spoken input as text
   * @returns Promise resolving to detection result containing:
   *   - requiresTools: boolean indicating if external tools are needed
   *   - detectedTools: optional array of specific tool names detected
   *   - confidence: optional confidence score (0-1) for the detection
   */
  detectToolIntent(transcript: string): Promise<{
    requiresTools: boolean;
    detectedTools?: string[];
    confidence?: number;
  }>;
}

/**
 * Result type for tool intent detection.
 */
export interface ToolIntentResult {
  requiresTools: boolean;
  detectedTools?: string[];
  confidence?: number;
}

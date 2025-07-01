import type {
  IToolIntentDetector,
  ToolIntentResult,
} from '../../domain/intent/intentDetector.service';
import logger from '../logger';

/**
 * Keyword-based implementation of tool intent detection.
 * Uses predefined keyword patterns to detect when external tools are required.
 */
export class KeywordIntentDetector implements IToolIntentDetector {
  private readonly toolKeywords: Record<string, string[]> = {
    email: [
      'send email',
      'check inbox',
      'compose message',
      'email',
      'send message',
      'check mail',
      'write email',
      'reply to email',
      'forward email',
      'delete email',
      'read email',
      'inbox',
      'outbox',
      'draft',
      'compose',
      'mail',
    ],
    calendar: [
      'schedule meeting',
      'book appointment',
      'check calendar',
      'calendar',
      'meeting',
      'appointment',
      'schedule',
      'book time',
      'free time',
      'busy',
      'available',
      'reschedule',
      'cancel meeting',
      'event',
      'reminder',
      'agenda',
      'time slot',
    ],
    restaurant: [
      'book table',
      'find restaurant',
      'find me restaurant',
      'find me a restaurant',
      'find me a good restaurant',
      'find me a good restaurant in',
      'find me a good restaurant in the area',
      'make reservation',
      'restaurant',
      'table',
      'reservation',
      'book dinner',
      'book lunch',
      'dining',
      'food',
      'cuisine',
      'menu',
      'reserve table',
      'restaurant booking',
      'table for',
      'dinner reservation',
    ],
  };

  /**
   * Analyzes a transcript to detect if external tools are required.
   * Uses keyword matching with confidence scoring based on matches found.
   */
  async detectToolIntent(transcript: string): Promise<ToolIntentResult> {
    if (!transcript || transcript.trim().length === 0) {
      return {
        requiresTools: false,
        detectedTools: [],
        confidence: 0,
      };
    }

    const normalizedTranscript = transcript.toLowerCase().trim();
    const detectedTools: string[] = [];
    let totalMatches = 0;
    let maxMatches = 0;

    // Check each tool category for keyword matches
    for (const [toolName, keywords] of Object.entries(this.toolKeywords)) {
      let matches = 0;
      const matchedKeywords: string[] = [];

      for (const keyword of keywords) {
        if (normalizedTranscript.includes(keyword.toLowerCase())) {
          matches++;
          matchedKeywords.push(keyword);
        }
      }

      if (matches > 0) {
        detectedTools.push(toolName);
        totalMatches += matches;
        maxMatches = Math.max(maxMatches, matches);

        logger.info(
          `[KeywordIntentDetector] Detected ${toolName} tool intent with ${matches} keyword matches:`,
          matchedKeywords
        );
      }
    }

    const requiresTools = detectedTools.length > 0;

    // Calculate confidence based on number of matches
    // Higher confidence for more matches, capped at 1.0
    const confidence = requiresTools ? Math.min(totalMatches * 0.2, 1.0) : 0;

    const result: ToolIntentResult = {
      requiresTools,
      detectedTools: requiresTools ? detectedTools : undefined,
      confidence: requiresTools ? confidence : undefined,
    };

    if (requiresTools) {
      console.log(`[KeywordIntentDetector] Tool intent detected:`, {
        transcript:
          transcript.substring(0, 100) + (transcript.length > 100 ? '...' : ''),
        detectedTools,
        confidence,
        totalMatches,
      });
    } else {
      console.log(
        `[KeywordIntentDetector] No tool intent detected for transcript:`,
        transcript.substring(0, 100) + (transcript.length > 100 ? '...' : '')
      );
    }

    return result;
  }

  /**
   * Get all available tool categories and their keywords.
   * Useful for debugging and monitoring.
   */
  getToolCategories(): Record<string, string[]> {
    return { ...this.toolKeywords };
  }

  /**
   * Add custom keywords to a tool category.
   * Allows runtime extension of keyword patterns.
   */
  addKeywords(toolName: string, keywords: string[]): void {
    if (!this.toolKeywords[toolName]) {
      this.toolKeywords[toolName] = [];
    }
    this.toolKeywords[toolName].push(...keywords);
    console.log(
      `[KeywordIntentDetector] Added ${keywords.length} keywords to ${toolName} category`
    );
  }
}

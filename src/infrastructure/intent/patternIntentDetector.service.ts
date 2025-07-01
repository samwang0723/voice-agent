import logger from '../logger';
import type {
  IToolIntentDetector,
  ToolIntentResult,
} from '../../domain/intent/intentDetector.service';
import {
  intentPatterns,
  keywordWeights,
  getKeywordWeight,
} from '../../config/intent/patterns';

// Import compromise for NLP text processing
import nlp from 'compromise';

/**
 * Pattern-based implementation of tool intent detection.
 * Uses regex patterns and NLP text processing to detect when external tools are required.
 * Combines pattern matching with weighted keyword scoring for improved accuracy.
 */
export class PatternIntentDetector implements IToolIntentDetector {
  private readonly patterns: Record<string, RegExp[]>;
  private readonly weights: Record<string, number>;

  constructor() {
    // Initialize with default patterns and weights from configuration
    this.patterns = { ...intentPatterns };
    this.weights = { ...keywordWeights };

    logger.info(
      `[PatternIntentDetector] Initialized with ${Object.keys(this.patterns).length} tool categories:`,
      Object.keys(this.patterns)
    );
  }

  /**
   * Analyzes a transcript to detect if external tools are required.
   * Uses NLP text processing, pattern matching, and weighted keyword scoring.
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
    const toolScores: Record<string, number> = {};

    logger.info(
      `[PatternIntentDetector] Processing transcript: ${transcript.substring(0, 100)} ...`
    );

    // Process text with compromise NLP
    const doc = nlp(normalizedTranscript);
    const terms = doc.terms().out('array');
    const sentences = doc.sentences().out('array');

    logger.info(
      `[PatternIntentDetector] NLP processing extracted ${terms.length} terms and ${sentences.length} sentences`
    );

    // Check each tool category for pattern and keyword matches
    for (const [toolName, patterns] of Object.entries(this.patterns)) {
      const patternScore = this.calculatePatternScore(
        normalizedTranscript,
        patterns
      );
      const keywordScore = this.calculateKeywordScore(terms);

      // Combine pattern and keyword scores with weighted formula
      // Pattern score has higher weight (0.7) as it's more specific
      const combinedScore = patternScore * 0.7 + keywordScore * 0.3;

      if (combinedScore > 0) {
        detectedTools.push(toolName);
        toolScores[toolName] = combinedScore;

        logger.info(
          `[PatternIntentDetector] Detected ${toolName} tool intent:`,
          {
            patternScore: patternScore.toFixed(3),
            keywordScore: keywordScore.toFixed(3),
            combinedScore: combinedScore.toFixed(3),
          }
        );
      }
    }

    const requiresTools = detectedTools.length > 0;

    // Calculate overall confidence as the maximum combined score
    // This represents the strongest intent signal detected
    const confidence = requiresTools
      ? Math.min(Math.max(...Object.values(toolScores)), 1.0)
      : 0;

    const result: ToolIntentResult = {
      requiresTools,
      detectedTools: requiresTools ? detectedTools : undefined,
      confidence: requiresTools ? confidence : undefined,
    };

    if (requiresTools) {
      logger.info(`[PatternIntentDetector] Tool intent detected:`, {
        transcript:
          transcript.substring(0, 100) + (transcript.length > 100 ? '...' : ''),
        detectedTools,
        confidence: confidence.toFixed(3),
        toolScores: Object.fromEntries(
          Object.entries(toolScores).map(([tool, score]) => [
            tool,
            score.toFixed(3),
          ])
        ),
      });
    } else {
      logger.info(
        `[PatternIntentDetector] No tool intent detected for transcript:`,
        transcript.substring(0, 100) + (transcript.length > 100 ? '...' : '')
      );
    }

    return result;
  }

  /**
   * Calculate pattern matching score for a given text and patterns.
   * Returns a normalized score between 0 and 1 based on pattern matches.
   */
  private calculatePatternScore(text: string, patterns: RegExp[]): number {
    let matches = 0;
    const matchedPatterns: string[] = [];

    for (const pattern of patterns) {
      if (pattern.test(text)) {
        matches++;
        matchedPatterns.push(pattern.source);
      }
    }

    if (matches > 0) {
      logger.info(
        `[PatternIntentDetector] Pattern matches found: ${matches}/${patterns.length}`,
        matchedPatterns.slice(0, 3) // Log first 3 patterns to avoid spam
      );
    }

    // Normalize score: more matches = higher confidence, capped at 1.0
    // Use logarithmic scaling to prevent over-confidence with many matches
    return matches > 0
      ? Math.min(Math.log(matches + 1) / Math.log(patterns.length + 1), 1.0)
      : 0;
  }

  /**
   * Calculate weighted keyword score based on extracted terms.
   * Returns a normalized score between 0 and 1 based on keyword weights.
   */
  private calculateKeywordScore(terms: string[]): number {
    let totalWeight = 0;
    let maxPossibleWeight = 0;
    const matchedKeywords: Array<{ keyword: string; weight: number }> = [];

    // Calculate total weight of matched keywords
    for (const term of terms) {
      const normalizedTerm = term.toLowerCase();
      const weight = getKeywordWeight(normalizedTerm);

      if (weight > 0) {
        totalWeight += weight;
        matchedKeywords.push({ keyword: normalizedTerm, weight });
      }
    }

    // Calculate maximum possible weight for normalization
    // Use the top 5 highest weights as a reasonable maximum
    const sortedWeights = Object.values(this.weights).sort((a, b) => b - a);
    maxPossibleWeight = sortedWeights
      .slice(0, 5)
      .reduce((sum, weight) => sum + weight, 0);

    if (matchedKeywords.length > 0) {
      logger.info(
        `[PatternIntentDetector] Keyword matches found:`,
        matchedKeywords.slice(0, 5).map((k) => `${k.keyword}(${k.weight})`)
      );
    }

    // Normalize score based on maximum possible weight
    return maxPossibleWeight > 0
      ? Math.min(totalWeight / maxPossibleWeight, 1.0)
      : 0;
  }

  /**
   * Get all available tool categories and their patterns.
   * Useful for debugging and monitoring.
   */
  getToolCategories(): Record<string, RegExp[]> {
    return { ...this.patterns };
  }

  /**
   * Get keyword weights for debugging and monitoring.
   */
  getKeywordWeights(): Record<string, number> {
    return { ...this.weights };
  }

  /**
   * Add custom patterns to a tool category.
   * Allows runtime extension of pattern matching similar to addKeywords in KeywordIntentDetector.
   */
  addPatterns(toolName: string, patterns: RegExp[]): void {
    if (!this.patterns[toolName]) {
      this.patterns[toolName] = [];
    }
    this.patterns[toolName].push(...patterns);
    logger.info(
      `[PatternIntentDetector] Added ${patterns.length} patterns to ${toolName} category`
    );
  }

  /**
   * Add custom keyword weights.
   * Allows runtime extension of keyword scoring.
   */
  addKeywordWeights(keywords: Record<string, number>): void {
    Object.assign(this.weights, keywords);
    logger.info(
      `[PatternIntentDetector] Added ${Object.keys(keywords).length} keyword weights:`,
      Object.keys(keywords)
    );
  }

  /**
   * Add a new tool category with patterns and keywords.
   * Comprehensive method for adding new tool support at runtime.
   */
  addToolCategory(
    toolName: string,
    patterns: RegExp[],
    keywords: Record<string, number> = {}
  ): void {
    this.patterns[toolName] = patterns;
    Object.assign(this.weights, keywords);

    logger.info(
      `[PatternIntentDetector] Added new tool category '${toolName}' with ${patterns.length} patterns and ${Object.keys(keywords).length} keywords`
    );
  }

  /**
   * Remove a tool category.
   * Useful for disabling certain tool detection at runtime.
   */
  removeToolCategory(toolName: string): boolean {
    if (this.patterns[toolName]) {
      delete this.patterns[toolName];
      logger.info(
        `[PatternIntentDetector] Removed tool category '${toolName}'`
      );
      return true;
    }
    return false;
  }

  /**
   * Get detailed analysis of a transcript for debugging purposes.
   * Returns comprehensive information about the detection process.
   */
  async analyzeTranscript(transcript: string): Promise<{
    normalizedText: string;
    terms: string[];
    sentences: string[];
    patternMatches: Record<string, { matches: number; patterns: string[] }>;
    keywordMatches: Array<{ keyword: string; weight: number }>;
    toolScores: Record<
      string,
      { patternScore: number; keywordScore: number; combinedScore: number }
    >;
  }> {
    const normalizedTranscript = transcript.toLowerCase().trim();
    const doc = nlp(normalizedTranscript);
    const terms = doc.terms().out('array');
    const sentences = doc.sentences().out('array');

    const patternMatches: Record<
      string,
      { matches: number; patterns: string[] }
    > = {};
    const keywordMatches: Array<{ keyword: string; weight: number }> = [];
    const toolScores: Record<
      string,
      { patternScore: number; keywordScore: number; combinedScore: number }
    > = {};

    // Analyze pattern matches for each tool
    for (const [toolName, patterns] of Object.entries(this.patterns)) {
      const matchedPatterns: string[] = [];
      let matches = 0;

      for (const pattern of patterns) {
        if (pattern.test(normalizedTranscript)) {
          matches++;
          matchedPatterns.push(pattern.source);
        }
      }

      patternMatches[toolName] = { matches, patterns: matchedPatterns };

      const patternScore = this.calculatePatternScore(
        normalizedTranscript,
        patterns
      );
      const keywordScore = this.calculateKeywordScore(terms);
      const combinedScore = patternScore * 0.7 + keywordScore * 0.3;

      toolScores[toolName] = { patternScore, keywordScore, combinedScore };
    }

    // Analyze keyword matches
    for (const term of terms) {
      const weight = getKeywordWeight(term.toLowerCase());
      if (weight > 0) {
        keywordMatches.push({ keyword: term.toLowerCase(), weight });
      }
    }

    return {
      normalizedText: normalizedTranscript,
      terms,
      sentences,
      patternMatches,
      keywordMatches,
      toolScores,
    };
  }
}

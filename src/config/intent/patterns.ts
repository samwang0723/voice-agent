/**
 * Intent Detection Patterns and Keyword Weights Configuration
 *
 * This file contains regex patterns and keyword weights used by the pattern-based
 * intent detector to identify when external tools are required based on user input.
 *
 * @fileoverview Configuration for intent detection patterns and scoring weights
 */

/**
 * Regular expression patterns for detecting tool intent categories.
 * Each tool category contains an array of regex patterns that match various
 * ways users might express intent for that category.
 *
 * Pattern Syntax Guidelines:
 * - Use word boundaries (\b) to ensure whole word matches
 * - Use non-capturing groups (?:) for grouping without capturing
 * - Use case-insensitive flag (i) for all patterns
 * - Use optional quantifiers (?) for flexible matching
 * - Escape special regex characters when matching literal text
 *
 * Adding New Categories:
 * 1. Add a new key to the intentPatterns object
 * 2. Define regex patterns that capture various expressions for that intent
 * 3. Add corresponding keyword weights in the keywordWeights object
 * 4. Test patterns thoroughly with expected user inputs
 *
 * @example
 * // To add a new hotel booking category:
 * // hotel: [
 * //   /\b(?:book|reserve|find)\s+(?:a\s+)?hotel\b/i,
 * //   /\bneed\s+(?:a\s+)?(?:hotel|accommodation)\b/i
 * // ]
 */
export const intentPatterns: Record<string, RegExp[]> = {
  /**
   * Email-related intent patterns
   * Matches expressions for sending, checking, composing, and managing emails
   */
  email: [
    // Direct email actions - MUST contain "email" keyword
    /\b(?:send|write|compose|draft)\s+(?:an?\s+)?email\b/i,
    /\bemail\s+(?:to|someone|him|her|them)\b/i,

    // Email checking and management - MUST contain email-specific terms (removed generic "check")
    /\b(?:read|view|open)\s+(?:my\s+)?(?:email|inbox)\b/i,
    /\b(?:reply|respond)\s+to\s+(?:the\s+)?email\b/i,
    /\bforward\s+(?:this\s+|the\s+)?email\b/i,
    /\bdelete\s+(?:this\s+|the\s+)?email\b/i,

    // Email-specific actions - MUST contain email/inbox/mail
    /\b(?:open|access)\s+(?:my\s+)?(?:inbox|email)\b/i,
    /\b(?:manage|organize)\s+(?:my\s+)?(?:email|inbox)\b/i,

    // Very specific email expressions only
    /\b(?:shoot|drop)\s+(?:an?\s+)?email\b/i,
    /\bget\s+in\s+touch\s+via\s+email\b/i,
    /\bemail\s+(?:communication|correspondence)\b/i,
  ],

  /**
   * Calendar-related intent patterns
   * Matches expressions for scheduling, booking appointments, and calendar management
   */
  calendar: [
    // Meeting and appointment scheduling
    /\b(?:schedule|book|arrange|set\s+up)\s+(?:a\s+)?(?:meeting|appointment)\b/i,
    /\b(?:schedule|book)\s+(?:some\s+)?time\b/i,
    /\bmeet\s+(?:with|up)\b/i,
    /\bset\s+(?:up\s+)?(?:a\s+)?(?:meeting|appointment|call)\b/i,

    // Calendar checking and availability - enhanced patterns
    /\b(?:check|view|see|show)\s+(?:my\s+)?(?:calendar|schedule|availability)\b/i,
    /\bwhat(?:'s|\s+is)\s+(?:on\s+)?(?:my\s+)?(?:calendar|schedule)\b/i,
    /\bshow\s+me\s+(?:my\s+)?(?:calendar|schedule)\b/i,
    /\b(?:calendar|schedule)\s+(?:for\s+)?(?:today|tomorrow|this\s+week|next\s+week|this\s+month)\b/i,
    /\b(?:my\s+)?(?:calendar|schedule)\s+(?:this\s+|next\s+)?(?:week|month|day)\b/i,
    /\bwhat(?:'s|\s+is)\s+(?:on\s+)?(?:my\s+)?(?:calendar|schedule)\s+(?:this\s+|next\s+)?(?:week|month|today|tomorrow)\b/i,

    // Availability and scheduling queries
    /\b(?:am\s+i|are\s+you)\s+(?:free|available|busy)\b/i,
    /\bfind\s+(?:a\s+)?(?:free\s+)?time\s+slot\b/i,
    /\bwhen\s+(?:am\s+i|are\s+you)\s+(?:free|available)\b/i,

    // Event management
    /\b(?:create|add|make)\s+(?:an?\s+)?(?:event|appointment|reminder)\b/i,
    /\b(?:cancel|reschedule|move)\s+(?:the\s+)?(?:meeting|appointment)\b/i,
    /\bblock\s+(?:out\s+)?(?:time|calendar)\b/i,

    // Time-related scheduling
    /\bbook\s+(?:me\s+)?(?:for|at)\s+\d/i,
    /\bschedule\s+(?:for|at)\s+\d/i,
    /\bnext\s+(?:week|month)\s+(?:meeting|appointment)\b/i,
  ],

  /**
   * Restaurant-related intent patterns
   * Matches expressions for finding restaurants, making reservations, and dining
   */
  restaurant: [
    // Restaurant booking - MUST contain "restaurant" keyword
    /\b(?:book|make|reserve)\s+(?:a\s+)?(?:table|reservation)\s+at\s+(?:a\s+)?restaurant\b/i,
    /\breserve\s+(?:a\s+)?table\s+at\s+(?:a\s+)?restaurant\b/i,
    /\b(?:dinner|lunch|breakfast)\s+reservation\s+at\s+(?:a\s+)?restaurant\b/i,

    // Restaurant finding - MUST contain "restaurant" keyword
    /\b(?:find|search\s+for|look\s+for)\s+(?:a\s+)?restaurant\b/i,
    /\b(?:recommend|suggest)\s+(?:a\s+)?restaurant\b/i,
    /\bgood\s+restaurant\b/i,
    /\bneed\s+(?:a\s+)?restaurant\b/i,

    // Restaurant-specific expressions - MUST contain "restaurant"
    /\bgoing\s+to\s+(?:a\s+)?restaurant\b/i,
    /\b(?:book|reserve)\s+(?:at\s+)?(?:a\s+)?restaurant\b/i,

    // Cuisine with restaurant - MUST contain "restaurant"
    /\b(?:italian|chinese|mexican|thai|indian)\s+restaurant\b/i,
    /\brestaurant\s+(?:recommendation|suggestion|booking|reservation)\b/i,
  ],

  /**
   * Web search-related intent patterns
   * Matches expressions for searching the web, looking up information, and research
   */
  websearch: [
    // Direct web search actions
    /\b(?:search|google|bing)\s+(?:for|about|the\s+web|online|internet)\b/i,
    /\bsearch\s+(?:the\s+)?(?:web|internet|online)\s+for\b/i,
    /\b(?:google|search\s+for)\s+(?:information\s+)?(?:about|on)\b/i,
    /\bweb\s+search\s+(?:for|about|on)\b/i,

    // Research and lookup patterns
    /\b(?:look\s+up|find\s+out|research|investigate)\s+(?:about|on|information\s+about)\b/i,
    /\b(?:find|get)\s+(?:information|details|facts)\s+(?:about|on|regarding)\b/i,
    /\b(?:learn|know)\s+(?:more\s+)?about\b/i,

    // Information request patterns
    /\bcan\s+you\s+(?:search|look\s+up|find|tell\s+me)\b/i,
    /\bi\s+(?:want\s+to\s+|need\s+to\s+)?(?:know|learn|find\s+out)\s+(?:about|more\s+about)\b/i,
    /\b(?:show\s+me|give\s+me)\s+(?:information|details|facts)\s+(?:about|on)\b/i,

    // Current events and news
    /\b(?:latest|recent|current)\s+(?:news|updates|information)\s+(?:about|on)\b/i,
    /\bwhat(?:'s|\s+is)\s+(?:happening|going\s+on)\s+(?:with|in|about)\b/i,
    /\b(?:news|updates)\s+(?:about|on|regarding)\b/i,
  ],
};

/**
 * Keyword importance weights for scoring intent detection confidence.
 * Higher weights indicate stronger intent signals for specific keywords.
 *
 * Weight Scale:
 * - 0.9-1.0: Very strong intent indicators (highly specific actions)
 * - 0.7-0.8: Strong intent indicators (clear action words)
 * - 0.5-0.6: Moderate intent indicators (context-dependent)
 * - 0.3-0.4: Weak intent indicators (ambiguous or common words)
 * - 0.1-0.2: Very weak indicators (supporting context only)
 *
 * Usage Guidelines:
 * - Action verbs should have higher weights than nouns
 * - Specific terms should have higher weights than general terms
 * - Consider context and ambiguity when assigning weights
 * - Regularly review and adjust weights based on detection accuracy
 *
 * Adding New Keywords:
 * 1. Identify the keyword's specificity and intent strength
 * 2. Assign appropriate weight based on the scale above
 * 3. Test with real user inputs to validate weight effectiveness
 * 4. Group related keywords with similar weights for consistency
 */
export const keywordWeights: Record<string, number> = {
  // Email-specific high-confidence keywords (MUST be email-specific)
  email: 0.9,
  inbox: 0.8,
  compose: 0.8,
  reply: 0.7,
  forward: 0.7,
  draft: 0.6,
  outbox: 0.7,
  // Removed: 'send', 'mail', 'message' as they're too generic

  // Calendar-specific high-confidence keywords (MUST be calendar-specific)
  calendar: 0.9,
  schedule: 0.8,
  meeting: 0.8,
  appointment: 0.8,
  reschedule: 0.9,
  event: 0.6,
  agenda: 0.7,
  availability: 0.7,
  // Removed: 'available', 'busy' as they're too generic

  // Restaurant-specific high-confidence keywords (MUST be restaurant-specific)
  restaurant: 0.9,
  reservation: 0.8,
  dining: 0.7,
  menu: 0.6,
  cuisine: 0.6,
  dine: 0.7,

  // Web search-specific high-confidence keywords
  search: 0.8,
  google: 0.9,
  bing: 0.8,
  websearch: 0.9,
  lookup: 0.7,
  research: 0.8,
  investigate: 0.7,

  // Removed all generic time-related and action verb keywords that cause false positives
  // Only keeping highly specific action verbs
  cancel: 0.6,
  delete: 0.6,

  // Tool-specific only - removed all generic words that cause cross-tool false positives

  // Future extensibility examples for additional tool categories
  // Uncomment and modify when adding new categories:

  // Hotel booking keywords
  // 'hotel': 0.9,
  // 'accommodation': 0.8,
  // 'room': 0.6,
  // 'stay': 0.5,
  // 'checkin': 0.7,
  // 'checkout': 0.7,

  // Flight booking keywords
  // 'flight': 0.9,
  // 'airline': 0.8,
  // 'ticket': 0.7,
  // 'departure': 0.7,
  // 'arrival': 0.7,
  // 'airport': 0.6,

  // Car rental keywords
  // 'car': 0.5, // Lower because it's general
  // 'rental': 0.8,
  // 'rent': 0.6,
  // 'vehicle': 0.6,
  // 'pickup': 0.5,
  // 'return': 0.4, // Lower because it's ambiguous
};

/**
 * Helper function to get all available tool categories.
 * Useful for validation and debugging purposes.
 *
 * @returns Array of tool category names
 */
export function getToolCategories(): string[] {
  return Object.keys(intentPatterns);
}

/**
 * Helper function to validate if a tool category exists.
 *
 * @param category - The tool category to validate
 * @returns True if the category exists, false otherwise
 */
export function isValidToolCategory(category: string): boolean {
  return category in intentPatterns;
}

/**
 * Helper function to get patterns for a specific tool category.
 *
 * @param category - The tool category
 * @returns Array of regex patterns for the category, or empty array if not found
 */
export function getPatternsForCategory(category: string): RegExp[] {
  return intentPatterns[category] || [];
}

/**
 * Helper function to get keyword weight for a specific keyword.
 *
 * @param keyword - The keyword to get weight for
 * @returns Weight value between 0 and 1, or 0 if keyword not found
 */
export function getKeywordWeight(keyword: string): number {
  return keywordWeights[keyword.toLowerCase()] || 0;
}

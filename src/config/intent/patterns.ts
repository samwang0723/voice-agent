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
    // Direct email actions
    /\b(?:send|write|compose|draft)\s+(?:an?\s+)?email\b/i,
    /\b(?:send|write)\s+(?:a\s+)?message\b/i,
    /\bemail\s+(?:to|someone|him|her|them)\b/i,
    
    // Email checking and management
    /\b(?:check|read|view)\s+(?:my\s+)?(?:email|inbox|mail)\b/i,
    /\b(?:reply|respond)\s+to\s+(?:the\s+)?email\b/i,
    /\bforward\s+(?:this\s+|the\s+)?email\b/i,
    /\bdelete\s+(?:this\s+|the\s+)?email\b/i,
    
    // Email-related nouns with action verbs
    /\b(?:open|access)\s+(?:my\s+)?(?:inbox|mail|email)\b/i,
    /\b(?:manage|organize)\s+(?:my\s+)?email\b/i,
    
    // Casual email expressions
    /\b(?:shoot|drop)\s+(?:an?\s+)?email\b/i,
    /\bget\s+in\s+touch\s+via\s+email\b/i,
    /\bcontact\s+(?:via\s+)?email\b/i,
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
    
    // Calendar checking and availability
    /\b(?:check|view|see)\s+(?:my\s+)?(?:calendar|schedule|availability)\b/i,
    /\b(?:am\s+i|are\s+you)\s+(?:free|available|busy)\b/i,
    /\bwhat(?:'s|\s+is)\s+(?:my\s+)?(?:schedule|calendar)\b/i,
    /\bfind\s+(?:a\s+)?(?:free\s+)?time\s+slot\b/i,
    
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
    // Restaurant booking and reservations
    /\b(?:book|make|reserve)\s+(?:a\s+)?(?:table|reservation)\b/i,
    /\breserve\s+(?:a\s+)?(?:table|spot)\s+(?:at|for)\b/i,
    /\btable\s+for\s+\d+\b/i,
    /\b(?:dinner|lunch|breakfast)\s+reservation\b/i,
    
    // Restaurant finding
    /\b(?:find|search\s+for|look\s+for)\s+(?:a\s+)?restaurant\b/i,
    /\b(?:recommend|suggest)\s+(?:a\s+)?restaurant\b/i,
    /\bwhere\s+(?:can\s+)?(?:i|we)\s+(?:eat|dine)\b/i,
    /\bgood\s+(?:restaurant|place\s+to\s+eat)\b/i,
    
    // Dining expressions
    /\b(?:want|need)\s+to\s+(?:eat|dine)\s+(?:out|at)\b/i,
    /\bgoing\s+(?:out\s+)?(?:for|to)\s+(?:dinner|lunch|eat)\b/i,
    /\b(?:book|reserve)\s+(?:dinner|lunch)\b/i,
    
    // Cuisine and food-related
    /\b(?:craving|want)\s+(?:some\s+)?(?:food|cuisine)\b/i,
    /\b(?:italian|chinese|mexican|thai|indian)\s+(?:restaurant|food)\b/i,
    /\bplace\s+to\s+eat\b/i,
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
  // Email-specific high-confidence keywords
  'email': 0.9,
  'inbox': 0.8,
  'compose': 0.8,
  'send': 0.7,
  'reply': 0.7,
  'forward': 0.7,
  'mail': 0.6,
  'message': 0.5,
  'draft': 0.6,
  'outbox': 0.7,
  
  // Calendar-specific high-confidence keywords
  'schedule': 0.8,
  'calendar': 0.9,
  'meeting': 0.8,
  'appointment': 0.8,
  'book': 0.6, // Lower because it's used across categories
  'reschedule': 0.9,
  'available': 0.5,
  'busy': 0.5,
  'event': 0.6,
  'reminder': 0.6,
  'agenda': 0.7,
  
  // Restaurant-specific high-confidence keywords
  'restaurant': 0.9,
  'table': 0.7,
  'reservation': 0.8,
  'dining': 0.7,
  'menu': 0.6,
  'cuisine': 0.6,
  'food': 0.4, // Lower because it's very general
  'eat': 0.5,
  'dine': 0.7,
  'reserve': 0.7,
  
  // Time-related keywords (moderate confidence)
  'time': 0.4,
  'today': 0.3,
  'tomorrow': 0.3,
  'tonight': 0.4,
  'lunch': 0.5,
  'dinner': 0.5,
  'breakfast': 0.5,
  
  // Action verbs (context-dependent)
  'find': 0.4,
  'check': 0.5,
  'open': 0.3,
  'view': 0.4,
  'create': 0.5,
  'make': 0.4,
  'cancel': 0.6,
  'delete': 0.6,
  'add': 0.4,
  'need': 0.3,
  'want': 0.3,
  
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
import type { ILanguageModel } from '../../domain/ai/ai.service';
import type { Message } from '../../domain/conversation/conversation.entity';
import { AgentSwarmService } from './agentSwarm.service';
import { isAgentSwarmConfigured } from '../../config';
import logger from '../logger';

export class AgentSwarmLanguageModel implements ILanguageModel {
  private agentSwarmService: AgentSwarmService;
  private initializedSessions: Set<string> = new Set();

  constructor() {
    this.agentSwarmService = new AgentSwarmService();
    logger.info('Initialized Agent-Swarm Language Model');
  }

  private extractBearerToken(context?: any): string | null {
    return context?.session?.bearerToken || null;
  }

  private getSessionId(context?: any): string {
    if (!context?.session?.id) {
      throw new Error('Session ID not found in context');
    }
    return context.session.id;
  }

  private async ensureChatInitialized(
    sessionId: string,
    bearerToken: string | null
  ): Promise<void> {
    if (this.initializedSessions.has(sessionId)) {
      return;
    }

    if (!bearerToken) {
      throw new Error('Authentication required for agent-swarm initialization');
    }

    try {
      await this.agentSwarmService.initChat(bearerToken);
      this.initializedSessions.add(sessionId);
      logger.info(`Agent-swarm chat initialized for session: ${sessionId}`);
    } catch (error) {
      logger.error(
        `Failed to initialize agent-swarm chat for session ${sessionId}:`,
        error
      );
      throw error;
    }
  }

  private formatConversationHistory(history: Message[]): string {
    if (!history || history.length === 0) {
      return '';
    }

    // Format conversation history as context for agent-swarm
    const formattedHistory = history
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n');

    return `Previous conversation:\n${formattedHistory}\n\n`;
  }

  private buildContextualMessage(
    history: Message[],
    newUserMessage: string,
    context?: any
  ): string {
    let message = '';

    // Add conversation history if available
    // const historyContext = this.formatConversationHistory(history);
    // if (historyContext) {
    //   message += historyContext;
    // }

    // Add datetime context if available
    if (context?.datetime) {
      message += `Current date and time: ${context.datetime}\n\n`;
    }

    // Add any additional context
    if (context?.additionalInfo) {
      message += `Additional context: ${context.additionalInfo}\n\n`;
    }

    // Add the current user message
    message += `User: ${newUserMessage}`;

    return message;
  }

  async generateResponse(
    history: Message[],
    newUserMessage: string,
    context?: any
  ): Promise<string> {
    try {
      // Check if agent-swarm is properly configured
      if (!isAgentSwarmConfigured()) {
        logger.warn('Agent-swarm is not properly configured');
        return 'I apologize, but the external tools service is not available right now. Please try again later.';
      }

      // Extract bearer token and session ID from context
      const bearerToken = this.extractBearerToken(context);
      const sessionId = this.getSessionId(context);

      // Check if authentication is available
      if (!bearerToken) {
        logger.info(
          `Authentication required for agent-swarm request from session: ${sessionId}`
        );
        return 'I can help you with that once you sign in to your account. Please authenticate to access external tools.';
      }

      logger.info(
        `Generating response using agent-swarm for session: ${sessionId}`
      );
      logger.info(`Current datetime: ${context?.datetime}`);

      // Ensure chat is initialized for this session
      await this.ensureChatInitialized(sessionId, bearerToken);

      // Build contextual message with history and context
      const contextualMessage = this.buildContextualMessage(
        history,
        newUserMessage,
        context
      );

      // Send message to agent-swarm
      const response = await this.agentSwarmService.chat(
        contextualMessage,
        bearerToken
      );

      if (!response?.response) {
        logger.warn('Agent-swarm returned empty response');
        return "I apologize, but I couldn't process your request right now. Please try again.";
      }

      logger.info('Successfully generated response using agent-swarm');
      return response.response;
    } catch (error) {
      logger.error('Failed to generate AI response from agent-swarm:', error);

      // Provide specific user-friendly error messages based on error type
      if (error instanceof Error) {
        if (error.message.includes('Authentication required')) {
          return 'I can help you with that once you sign in to your account. Please authenticate to access external tools.';
        }
        if (
          error.message.includes('Bearer token') ||
          error.message.includes('Authentication failed')
        ) {
          return 'It looks like your authentication has expired. Please sign in again to access external tools.';
        }
        if (error.message.includes('Rate limit')) {
          return "I'm experiencing high demand right now. Please wait a moment and try again.";
        }
        if (
          error.message.includes('Server error') ||
          error.message.includes('Network')
        ) {
          return "I'm having trouble connecting to external services right now. Please try again in a few moments.";
        }
      }

      return "I apologize, but I'm having trouble processing your request right now. Please try again.";
    }
  }

  // Method to clean up session tracking when session ends
  public cleanupSession(sessionId: string): void {
    this.initializedSessions.delete(sessionId);
    logger.info(`Cleaned up agent-swarm session: ${sessionId}`);
  }

  // Method to check if a session is initialized
  public isSessionInitialized(sessionId: string): boolean {
    return this.initializedSessions.has(sessionId);
  }
}

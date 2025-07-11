import { agentSwarmConfig } from '../../config';
import logger from '../logger';

export interface ChatResponse {
  response: string;
}

export interface HistoryResponse {
  messages: Array<{
    role: string;
    content: string;
    timestamp: string;
  }>;
}

export interface ModelsResponse {
  models: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
}

export interface HealthResponse {
  status: string;
  version?: string;
  uptime?: number;
}

export interface ClientContext {
  timezone?: string;
  clientDatetime?: string;
}

export class AgentSwarmService {
  private baseURL: string;
  private streamTimeout: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor() {
    this.baseURL = agentSwarmConfig.baseURL;
    this.streamTimeout = agentSwarmConfig.streamTimeout;
    this.maxRetries = agentSwarmConfig.maxRetries;
    this.retryDelay = agentSwarmConfig.retryDelay;

    logger.info(`Initialized Agent-Core Engine with base URL: ${this.baseURL}`);
  }

  private getHeaders(
    token?: string,
    timezone?: string,
    clientDatetime?: string
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (timezone) {
      headers['X-Client-Timezone'] = timezone;
    }

    if (clientDatetime) {
      headers['X-Client-Datetime'] = clientDatetime;
    }

    return headers;
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');

      switch (response.status) {
        case 401:
          throw new Error(`Authentication failed: ${errorText}`);
        case 403:
          throw new Error(`Access forbidden: ${errorText}`);
        case 429:
          throw new Error(`Rate limit exceeded: ${errorText}`);
        case 500:
          throw new Error(`Server error: ${errorText}`);
        default:
          throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
    }

    try {
      return (await response.json()) as T;
    } catch (error) {
      logger.error('Failed to parse JSON response:', error);
      throw new Error('Invalid JSON response from server');
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async retryRequest<T>(
    requestFn: () => Promise<T>,
    operation: string
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await requestFn();
      } catch (error) {
        lastError = error as Error;
        logger.warn(
          `${operation} attempt ${attempt}/${this.maxRetries} failed:`,
          error
        );

        if (attempt < this.maxRetries) {
          const delay = this.retryDelay * attempt;
          logger.info(`Retrying ${operation} in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    throw lastError!;
  }

  async initChat(token: string, context?: ClientContext): Promise<void> {
    try {
      logger.info('Initializing agent-swarm chat session');

      await this.retryRequest(async () => {
        const response = await fetch(`${this.baseURL}/chat/init`, {
          method: 'POST',
          headers: this.getHeaders(
            token,
            context?.timezone,
            context?.clientDatetime
          ),
          body: JSON.stringify({}),
        });

        await this.handleResponse(response);
      }, 'initChat');

      logger.info('Agent-swarm chat session initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize agent-swarm chat:', error);
      throw error;
    }
  }

  async chat(
    message: string,
    token: string,
    context?: ClientContext
  ): Promise<ChatResponse> {
    try {
      logger.info('Sending message to agent-swarm chat');

      return await this.retryRequest(async () => {
        const response = await fetch(`${this.baseURL}/chat`, {
          method: 'POST',
          headers: this.getHeaders(
            token,
            context?.timezone,
            context?.clientDatetime
          ),
          body: JSON.stringify({ message }),
        });

        return await this.handleResponse<ChatResponse>(response);
      }, 'chat');
    } catch (error) {
      logger.error('Failed to send message to agent-swarm:', error);
      throw error;
    }
  }

  async *chatStream(
    message: string,
    token: string,
    context?: ClientContext,
    externalAbort?: AbortSignal
  ): AsyncGenerator<string> {
    let lastEventId: string | null = null;
    let attempt = 1;

    while (attempt <= this.maxRetries) {
      let streamStarted = false;
      let timeoutId: NodeJS.Timeout | null = null;

      try {
        logger.info(`Starting agent-swarm chat stream (attempt ${attempt})`);

        // Create local AbortController for timeout management
        const controller = new AbortController();

        // Set up external cancellation support
        if (externalAbort) {
          if (externalAbort.aborted) {
            logger.info(
              'External abort signal already triggered, cancelling stream'
            );
            return;
          }
          externalAbort.addEventListener('abort', () => {
            logger.info('External abort signal received, cancelling stream');
            controller.abort();
          });
        }

        // Set up timeout
        timeoutId = setTimeout(() => {
          logger.warn(`Stream timeout after ${this.streamTimeout}ms, aborting`);
          controller.abort();
        }, this.streamTimeout);

        const headers = this.getHeaders(
          token,
          context?.timezone,
          context?.clientDatetime
        );
        headers['Accept'] = 'text/event-stream';
        headers['Cache-Control'] = 'no-cache';

        if (lastEventId) {
          headers['Last-Event-ID'] = lastEventId;
        }

        const response = await fetch(`${this.baseURL}/chat/stream`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ message }),
          signal: controller.signal,
        });

        if (!response.ok) {
          await this.handleResponse(response);
        }

        if (!response.body) {
          throw new Error('No response body received');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }
              break;
            }

            streamStarted = true;
            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE messages (separated by double newlines)
            const messages = buffer.split('\n\n');
            buffer = messages.pop() || ''; // Keep incomplete message in buffer

            for (const message of messages) {
              if (!message.trim()) continue;

              logger.debug(`Streaming message: "${message}"`);

              const lines = message.split('\n');
              let data = '';
              let eventType = '';
              let id = '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  data = line.slice(6);
                } else if (line.startsWith('event: ')) {
                  eventType = line.slice(7);
                } else if (line.startsWith('id: ')) {
                  id = line.slice(4);
                  lastEventId = id;
                }
              }

              // Handle different event types
              if (eventType === 'error') {
                throw new Error(`Stream error: ${data}`);
              }

              if (data === '[DONE]') {
                if (timeoutId) {
                  clearTimeout(timeoutId);
                  timeoutId = null;
                }
                return;
              }

              if (data && data !== '') {
                try {
                  // Try to parse as JSON first
                  const parsed = JSON.parse(data);
                  if (parsed.text) {
                    yield parsed.text;
                  } else if (typeof parsed === 'string') {
                    yield parsed;
                  }
                } catch {
                  // If not JSON, yield as plain text
                  yield data;
                }
              }
            }
          }

          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          return; // Successful completion
        } finally {
          reader.releaseLock();
        }
      } catch (error) {
        // Clean up timeout on error
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }

        const err = error as Error;

        // Handle AbortError specifically
        if (err.name === 'AbortError') {
          if (externalAbort?.aborted) {
            logger.info('Stream cancelled by external abort signal');
          } else {
            logger.info('Stream cancelled due to timeout');
          }
          return; // Gracefully exit without throwing
        }

        logger.error(
          `Agent-swarm chat stream attempt ${attempt} failed:`,
          error
        );

        // Don't retry operations that were deliberately aborted
        if (err.name === 'AbortError') {
          return;
        }

        if (attempt >= this.maxRetries) {
          throw error;
        }

        if (!streamStarted) {
          // If stream never started, retry immediately
          attempt++;
          continue;
        }

        // If stream was interrupted, wait before retry
        const delay = this.retryDelay * attempt;
        logger.info(`Retrying stream in ${delay}ms...`);
        await this.sleep(delay);
        attempt++;
      }
    }
  }

  async getHistory(
    token: string,
    context?: ClientContext
  ): Promise<HistoryResponse> {
    try {
      logger.info('Fetching agent-swarm chat history');

      return await this.retryRequest(async () => {
        const response = await fetch(`${this.baseURL}/chat/history`, {
          method: 'GET',
          headers: this.getHeaders(
            token,
            context?.timezone,
            context?.clientDatetime
          ),
        });

        return await this.handleResponse<HistoryResponse>(response);
      }, 'getHistory');
    } catch (error) {
      logger.error('Failed to fetch agent-swarm chat history:', error);
      throw error;
    }
  }

  async clearHistory(token: string, context?: ClientContext): Promise<void> {
    try {
      logger.info('Clearing agent-swarm chat history');

      await this.retryRequest(async () => {
        const response = await fetch(`${this.baseURL}/chat/history`, {
          method: 'DELETE',
          headers: this.getHeaders(
            token,
            context?.timezone,
            context?.clientDatetime
          ),
        });

        await this.handleResponse(response);
      }, 'clearHistory');

      logger.info('Agent-swarm chat history cleared successfully');
    } catch (error) {
      logger.error('Failed to clear agent-swarm chat history:', error);
      throw error;
    }
  }

  async getModels(
    token: string,
    context?: ClientContext
  ): Promise<ModelsResponse> {
    try {
      logger.info('Fetching available agent-swarm models');

      return await this.retryRequest(async () => {
        const response = await fetch(`${this.baseURL}/models`, {
          method: 'GET',
          headers: this.getHeaders(
            token,
            context?.timezone,
            context?.clientDatetime
          ),
        });

        return await this.handleResponse<ModelsResponse>(response);
      }, 'getModels');
    } catch (error) {
      logger.error('Failed to fetch agent-swarm models:', error);
      throw error;
    }
  }

  async healthCheck(context?: ClientContext): Promise<HealthResponse> {
    try {
      logger.info('Performing agent-swarm health check');

      return await this.retryRequest(async () => {
        const response = await fetch(`${this.baseURL}/health`, {
          method: 'GET',
          headers: this.getHeaders(
            undefined,
            context?.timezone,
            context?.clientDatetime
          ),
        });

        return await this.handleResponse<HealthResponse>(response);
      }, 'healthCheck');
    } catch (error) {
      logger.error('Agent-swarm health check failed:', error);
      throw error;
    }
  }
}

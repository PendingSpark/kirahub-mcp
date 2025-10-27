/**
 * A2A Protocol Client for KiraHub
 * Wraps KiraHub's A2A API for use in MCP tools
 */

import axios, { AxiosInstance } from 'axios';
import { v4 as uuidv4 } from 'uuid';

export interface A2AMessage {
  messageId: string;
  role: 'user' | 'agent';
  kind: 'message';
  parts: Array<{
    kind: 'text' | 'data';
    text?: string;
    data?: any;
  }>;
}

export interface A2AResponse {
  jsonrpc: '2.0';
  id: number;
  result?: {
    kind: 'message';
    messageId: string;
    role: 'agent';
    parts: Array<{
      kind: 'text' | 'data';
      text?: string;
      data?: any;
    }>;
    contextId?: string;
  };
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface ValidationQuestion {
  id: string;
  text: string;
  type: string;
  sequenceNumber: number;
}

export interface ValidationData {
  kind: 'validation';
  sessionId: string;
  currentQuestion: ValidationQuestion;
}

export interface ValidationResult {
  validationResult: 'passed' | 'failed';
  score: number;
}

export class A2AClient {
  private client: AxiosInstance;
  private apiKey: string;
  private requestCounter = 0;

  constructor(baseURL: string, apiKey: string) {
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
    });
  }

  /**
   * Send a message via A2A protocol
   */
  async sendMessage(text: string, contextId?: string): Promise<A2AResponse> {
    this.requestCounter++;
    const messageId = uuidv4();

    const request = {
      jsonrpc: '2.0',
      method: 'message/send',
      params: {
        message: {
          messageId,
          role: 'user',
          kind: 'message',
          parts: [{ kind: 'text', text }],
        },
        ...(contextId && { contextId }),
      },
      id: this.requestCounter,
    };

    const response = await this.client.post<A2AResponse>('/a2a', request);
    return response.data;
  }

  /**
   * Extract validation question from A2A response
   */
  extractValidationQuestion(response: A2AResponse): ValidationData | null {
    if (!response.result?.parts) return null;

    for (const part of response.result.parts) {
      if (part.kind === 'data' && part.data?.kind === 'validation') {
        return part.data as ValidationData;
      }
    }

    return null;
  }

  /**
   * Extract validation result from A2A response
   */
  extractValidationResult(response: A2AResponse): ValidationResult | null {
    if (!response.result?.parts) return null;

    for (const part of response.result.parts) {
      if (part.kind === 'data' && part.data?.validationResult) {
        return part.data as ValidationResult;
      }
    }

    return null;
  }

  /**
   * Extract text from A2A response
   */
  extractText(response: A2AResponse): string {
    if (!response.result?.parts) return '';

    const textParts = response.result.parts
      .filter(part => part.kind === 'text')
      .map(part => part.text || '')
      .filter(text => text.length > 0);

    return textParts.join('\n\n');
  }

  /**
   * Check if response has error
   */
  hasError(response: A2AResponse): boolean {
    return !!response.error;
  }

  /**
   * Get error message from response
   */
  getErrorMessage(response: A2AResponse): string {
    if (response.error) {
      return `Error ${response.error.code}: ${response.error.message}`;
    }
    return 'Unknown error';
  }
}

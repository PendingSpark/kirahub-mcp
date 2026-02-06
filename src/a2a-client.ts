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
   * @param text Natural language message text
   * @param contextId Optional conversation context ID
   * @param structuredEntities Optional structured entities to pass alongside NLP text.
   *   These are included as a data part and take precedence over NLP-parsed entities on the backend.
   */
  async sendMessage(text: string, contextId?: string, structuredEntities?: Record<string, any>): Promise<A2AResponse> {
    this.requestCounter++;
    const messageId = uuidv4();

    const parts: Array<{ kind: string; text?: string; data?: any }> = [
      { kind: 'text', text },
    ];

    // Include structured entities as a data part so the backend can use them
    // directly instead of relying on NLP extraction
    if (structuredEntities && Object.keys(structuredEntities).length > 0) {
      parts.push({ kind: 'data', data: { _structuredEntities: structuredEntities } });
    }

    const request = {
      jsonrpc: '2.0',
      method: 'message/send',
      params: {
        message: {
          messageId,
          role: 'user',
          kind: 'message',
          parts,
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
    if (!response.result?.parts) {
      console.error('[A2AClient] extractValidationQuestion: No result.parts in response');
      return null;
    }

    console.error('[A2AClient] extractValidationQuestion: Checking', response.result.parts.length, 'parts');
    for (const part of response.result.parts) {
      console.error('[A2AClient] Part kind:', part.kind, 'data.kind:', part.data?.kind);
      if (part.kind === 'data' && part.data?.kind === 'validation') {
        console.error('[A2AClient] Found validation question:', part.data);
        return part.data as ValidationData;
      }
    }

    console.error('[A2AClient] No validation question found');
    return null;
  }

  /**
   * Extract validation result from A2A response
   */
  extractValidationResult(response: A2AResponse): ValidationResult | null {
    if (!response.result?.parts) {
      console.error('[A2AClient] extractValidationResult: No result.parts in response');
      return null;
    }

    console.error('[A2AClient] extractValidationResult: Checking', response.result.parts.length, 'parts');
    for (const part of response.result.parts) {
      console.error('[A2AClient] Part kind:', part.kind, 'has validationResult:', !!part.data?.validationResult);
      if (part.kind === 'data' && part.data?.validationResult) {
        console.error('[A2AClient] Found validation result:', part.data);
        return part.data as ValidationResult;
      }
    }

    console.error('[A2AClient] No validation result found');
    return null;
  }

  /**
   * Extract task data from A2A response (for claim_task, get_task, etc.)
   */
  extractTaskData(response: A2AResponse): { id: string; readable_id: string; project_id: string } | null {
    if (!response.result?.parts) {
      return null;
    }

    for (const part of response.result.parts) {
      if (part.kind === 'data' && part.data?.kind === 'task' && part.data?.id) {
        return {
          id: part.data.id,
          readable_id: part.data.readable_id,
          project_id: part.data.project_id,
        };
      }
    }

    return null;
  }

  /**
   * Extract text from A2A response
   */
  extractText(response: A2AResponse): string {
    if (!response.result?.parts) {
      console.error('[A2AClient] extractText: No result.parts in response');
      return '';
    }

    console.error('[A2AClient] extractText: Extracting from', response.result.parts.length, 'parts');
    const textParts = response.result.parts
      .filter(part => part.kind === 'text')
      .map(part => part.text || '')
      .filter(text => text.length > 0);

    console.error('[A2AClient] extractText: Found', textParts.length, 'text parts');
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

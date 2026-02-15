/**
 * Activity & Context Client for KiraHub
 * Direct REST API client for activity tracking and shared context
 */

import axios, { AxiosInstance } from 'axios';

export type ActivityEventType =
  // Status Changes
  | 'started'
  | 'completed'
  | 'blocked'
  | 'unblocked'
  | 'progress'

  // Code Changes
  | 'file_created'
  | 'file_modified'
  | 'file_deleted'
  | 'commit'
  | 'pr_created'
  | 'pr_merged'

  // Code Artifacts
  | 'type_created'
  | 'type_modified'
  | 'utility_created'
  | 'api_created'
  | 'api_modified'

  // Build & Test
  | 'test_run'
  | 'build_run'
  | 'lint_run'
  | 'deploy'

  // Decisions & Issues
  | 'decision'
  | 'question'
  | 'warning'
  | 'error'

  // Legacy
  | 'update';

export interface PostActivityParams {
  projectId: string;
  taskId?: string;
  eventType: ActivityEventType;
  message: string;
  metadata?: Record<string, any>;
}

export interface ActivityEvent {
  id: string;
  projectId: string;
  taskId?: string;
  agentId: string;
  eventType: ActivityEventType;
  message: string;
  metadata?: Record<string, any>;
  createdAt: string;
}

export interface GetActivityParams {
  projectId: string;
  taskId?: string;
  eventTypes?: ActivityEventType[];
  limit?: number;
  before?: string;
}

export type ContextCategory = 'contracts' | 'utilities' | 'decisions' | 'config';

export interface ContextItem {
  id: string;
  projectId: string;
  category: ContextCategory;
  key: string;
  value: Record<string, any>;
  createdByTaskId?: string;
  createdByAgentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SetContextParams {
  projectId: string;
  category: ContextCategory;
  key: string;
  value: Record<string, any>;
  taskId?: string;
}

export class ActivityClient {
  private client: AxiosInstance;

  constructor(baseURL: string, apiKey: string) {
    // Ensure baseURL ends with /api if not already
    const apiBaseURL = baseURL.endsWith('/api') ? baseURL : `${baseURL}/api`;

    this.client = axios.create({
      baseURL: apiBaseURL,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
    });
  }

  /**
   * Post an activity event
   */
  async postActivity(params: PostActivityParams): Promise<ActivityEvent> {
    const { projectId, taskId, eventType, message, metadata } = params;

    const response = await this.client.post(`/projects/${projectId}/activity`, {
      taskId,
      eventType,
      message,
      metadata,
    });

    return response.data.activity;
  }

  /**
   * Get activity events for a project
   */
  async getProjectActivity(params: GetActivityParams): Promise<ActivityEvent[]> {
    const { projectId, eventTypes, limit, before } = params;

    const queryParams = new URLSearchParams();
    if (eventTypes?.length) {
      queryParams.set('eventTypes', eventTypes.join(','));
    }
    if (limit) {
      queryParams.set('limit', limit.toString());
    }
    if (before) {
      queryParams.set('before', before);
    }

    const url = `/projects/${projectId}/activity${queryParams.toString() ? `?${queryParams}` : ''}`;
    const response = await this.client.get(url);

    return response.data.activities;
  }

  /**
   * Get activity events for a specific task
   */
  async getTaskActivity(taskId: string, limit?: number): Promise<ActivityEvent[]> {
    const queryParams = limit ? `?limit=${limit}` : '';
    const response = await this.client.get(`/tasks/${taskId}/activity${queryParams}`);

    return response.data.activities;
  }

  /**
   * Get all shared context for a project
   */
  async getContext(projectId: string): Promise<Record<ContextCategory, Record<string, any>>> {
    const response = await this.client.get(`/projects/${projectId}/context`);
    return response.data.context;
  }

  /**
   * Get a specific context item
   */
  async getContextItem(
    projectId: string,
    category: ContextCategory,
    key: string
  ): Promise<ContextItem | null> {
    try {
      const response = await this.client.get(
        `/projects/${projectId}/context/${category}/${key}`
      );
      return response.data.item;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Set (create or update) a context item
   */
  async setContext(params: SetContextParams): Promise<{ item: ContextItem; created: boolean }> {
    const { projectId, category, key, value, taskId } = params;

    const response = await this.client.put(
      `/projects/${projectId}/context/${category}/${key}`,
      { value, taskId }
    );

    return {
      item: response.data.item,
      created: response.data.created,
    };
  }

  /**
   * Delete a context item
   */
  async deleteContext(
    projectId: string,
    category: ContextCategory,
    key: string
  ): Promise<boolean> {
    const response = await this.client.delete(
      `/projects/${projectId}/context/${category}/${key}`
    );
    return response.data.deleted;
  }

  /**
   * Get all context items created by a specific task
   */
  async getContextByTask(
    projectId: string,
    taskId: string
  ): Promise<ContextItem[]> {
    const response = await this.client.get(
      `/projects/${projectId}/context/by-task/${taskId}`
    );
    return response.data.items;
  }

  /**
   * Perform bulk context operations
   */
  async bulkContextOperations(
    projectId: string,
    operations: Array<{
      action: 'set' | 'delete';
      category: ContextCategory;
      key: string;
      value?: Record<string, any>;
    }>
  ): Promise<ContextItem[]> {
    const response = await this.client.patch(`/projects/${projectId}/context`, {
      operations,
    });

    return response.data.items;
  }

  /**
   * Get working notes for a task
   */
  async getTaskNotes(taskId: string): Promise<Array<{ id: string; type: string; status: string; note: string }>> {
    try {
      const response = await this.client.get(`/tasks/${taskId}/working-notes`);
      return response.data;
    } catch {
      return [];
    }
  }
}

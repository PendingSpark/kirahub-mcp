/**
 * Plan Editor Client
 * Provides read-only access to PlanCreator (wiki) data using agent API keys.
 */

import axios, { AxiosInstance } from 'axios';

export interface PlanTaskMetadata {
  id: string;
  title: string;
  description?: string;
  type?: string;
  dependencies?: string[];
  tags?: string[];
  [key: string]: unknown;
}

export interface PlanTask {
  metadata: PlanTaskMetadata;
  content: string;
  file_name: string;
}

export interface PlanManifest {
  name: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  version?: string;
  tasks?: Array<string | Record<string, unknown>>;
  epics?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ProjectPlanResponse {
  project_id: string;
  manifest: PlanManifest;
  tasks: PlanTask[];
  overview?: string;
  kirahub_sync?: Record<string, unknown>;
}

export class PlanEditorClient {
  private client: AxiosInstance;

  constructor(baseURL: string, apiKey: string) {
    this.client = axios.create({
      baseURL,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      timeout: 15000,
    });
  }

  async getProjectPlan(projectId: string): Promise<ProjectPlanResponse> {
    const response = await this.client.get<ProjectPlanResponse>(
      `/plan/${encodeURIComponent(projectId)}`
    );
    return response.data;
  }

  async getPlanTasks(projectId: string): Promise<PlanTask[]> {
    const plan = await this.getProjectPlan(projectId);
    return plan.tasks || [];
  }

  async getTaskDetails(
    projectId: string,
    taskId: string
  ): Promise<PlanTask | null> {
    const tasks = await this.getPlanTasks(projectId);
    return (
      tasks.find(
        task =>
          task.metadata?.id?.toLowerCase() === taskId.toLowerCase() ||
          task.metadata?.title?.toLowerCase() === taskId.toLowerCase() ||
          task.file_name?.replace(/\.md$/, '').toLowerCase() ===
            taskId.toLowerCase()
      ) ?? null
    );
  }

  async searchTasks(
    projectId: string,
    query: string
  ): Promise<{ task: PlanTask; matchType: string }[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const matches: { task: PlanTask; matchType: string }[] = [];
    const tasks = await this.getPlanTasks(projectId);

    for (const task of tasks) {
      const { metadata, content } = task;
      const title = metadata?.title?.toLowerCase() || '';
      const description = metadata?.description?.toLowerCase() || '';
      const tags = (metadata?.tags || []).map(tag => tag.toLowerCase());
      const body = content.toLowerCase();

      if (title.includes(normalizedQuery)) {
        matches.push({ task, matchType: 'title' });
        continue;
      }

      if (description.includes(normalizedQuery)) {
        matches.push({ task, matchType: 'description' });
        continue;
      }

      if (tags.some(tag => tag.includes(normalizedQuery))) {
        matches.push({ task, matchType: 'tag' });
        continue;
      }

      if (body.includes(normalizedQuery)) {
        matches.push({ task, matchType: 'content' });
      }
    }

    return matches;
  }
}

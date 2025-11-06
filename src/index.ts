#!/usr/bin/env node
/**
 * KiraHub MCP Server
 * Model Context Protocol server for integrating KiraHub with Claude Code
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { A2AClient } from './a2a-client.js';
import { PlanEditorClient } from './plan-editor-client.js';
import dotenv from 'dotenv';

dotenv.config();

const KIRAHUB_API_URL = process.env.KIRAHUB_API_URL || 'http://localhost:3000';
const KIRAHUB_API_KEY = process.env.KIRAHUB_API_KEY;

if (!KIRAHUB_API_KEY) {
  console.error('Error: KIRAHUB_API_KEY environment variable is required');
  process.exit(1);
}

const a2aClient = new A2AClient(KIRAHUB_API_URL, KIRAHUB_API_KEY);

const rawPlanEditorUrl =
  process.env.PLANCREATOR_API_URL ||
  process.env.PLAN_EDITOR_API_URL ||
  '';

const planEditorIntegrationDisabled =
  rawPlanEditorUrl.toLowerCase() === 'disabled' ||
  rawPlanEditorUrl.toLowerCase() === 'none';

let planEditorClient: PlanEditorClient | null = null;
let planEditorBaseUrl: string | null = null;

if (!planEditorIntegrationDisabled) {
  planEditorBaseUrl = (
    rawPlanEditorUrl && rawPlanEditorUrl.trim().length > 0
      ? rawPlanEditorUrl.trim()
      : 'http://localhost/api/wiki'
  ).replace(/\/+$/, '');

  try {
    planEditorClient = new PlanEditorClient(
      planEditorBaseUrl,
      KIRAHUB_API_KEY
    );
    console.error(
      `Plan editor integration enabled (PlanCreator API: ${planEditorBaseUrl})`
    );
  } catch (error) {
    console.error(
      `Failed to initialize PlanEditorClient for ${planEditorBaseUrl}:`,
      error
    );
    planEditorClient = null;
  }
} else {
  console.error(
    'Plan editor integration disabled via PLANCREATOR_API_URL/PLAN_EDITOR_API_URL environment variable.'
  );
}

// Define all available tools
const tools: Tool[] = [
  // Task Management
  {
    name: 'get_next_task',
    description: 'Get the next task from the queue based on priority and dependencies',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Optional project ID to filter tasks',
        },
      },
    },
  },
  {
    name: 'claim_task',
    description: 'Claim a task to work on it',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ID of the task to claim',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'complete_task',
    description:
      'Mark a task as completed. This will trigger validation questions based on project knowledge. If validation questions are returned, you must answer them by calling this tool again with the answer in the message parameter.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'ID of the task to complete (optional if currently in validation)',
        },
        message: {
          type: 'string',
          description:
            'Optional message. Use this to answer validation questions when prompted.',
        },
      },
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Task title',
        },
        description: {
          type: 'string',
          description: 'Task description',
        },
        project_id: {
          type: 'string',
          description: 'Project ID (required if epic_id not provided)',
        },
        epic_id: {
          type: 'string',
          description: 'Epic ID (optional)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task tags',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Update task details',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID',
        },
        title: {
          type: 'string',
          description: 'New title',
        },
        description: {
          type: 'string',
          description: 'New description',
        },
        status: {
          type: 'string',
          enum: ['new', 'in-progress', 'blocked', 'completed'],
          description: 'New status',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'New tags',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'get_task_details',
    description: 'Get detailed information about a task including dependencies and notes',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID',
        },
      },
      required: ['task_id'],
    },
  },

  // Epic Management
  {
    name: 'list_epics',
    description: 'List all epics for a project',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project ID',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_epic',
    description: 'Get epic details with all tasks',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: {
          type: 'string',
          description: 'Epic ID',
        },
      },
      required: ['epic_id'],
    },
  },
  {
    name: 'create_epic',
    description: 'Create a new epic',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project ID',
        },
        name: {
          type: 'string',
          description: 'Epic name',
        },
        description: {
          type: 'string',
          description: 'Epic description',
        },
      },
      required: ['project_id', 'name'],
    },
  },
  {
    name: 'update_epic',
    description: 'Update epic details',
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: {
          type: 'string',
          description: 'Epic ID',
        },
        name: {
          type: 'string',
          description: 'New name',
        },
        description: {
          type: 'string',
          description: 'New description',
        },
        status: {
          type: 'string',
          enum: ['active', 'archived'],
          description: 'New status',
        },
      },
      required: ['epic_id'],
    },
  },

  // Working Notes
  {
    name: 'add_working_note',
    description:
      'Add a working note to a task (todo, bug, edge case, or optimization)',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID',
        },
        note: {
          type: 'string',
          description: 'Note content',
        },
        type: {
          type: 'string',
          enum: ['todo', 'bug', 'edge_case', 'optimization'],
          description: 'Type of note',
        },
        priority: {
          type: 'string',
          enum: ['must_fix', 'should_fix', 'nice_to_have'],
          description: 'Priority level',
        },
      },
      required: ['task_id', 'note', 'type', 'priority'],
    },
  },
  {
    name: 'resolve_working_note',
    description: 'Mark a working note as resolved',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID',
        },
        note_id: {
          type: 'string',
          description: 'Note ID',
        },
      },
      required: ['task_id', 'note_id'],
    },
  },
  {
    name: 'escalate_working_note',
    description: 'Escalate a working note to a new task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Current task ID',
        },
        note_id: {
          type: 'string',
          description: 'Note ID to escalate',
        },
        epic_id: {
          type: 'string',
          description: 'Optional epic ID for the new task',
        },
      },
      required: ['task_id', 'note_id'],
    },
  },
  {
    name: 'get_task_notes',
    description: 'Get all working notes for a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'Task ID',
        },
      },
      required: ['task_id'],
    },
  },

  // Task Dependencies
  {
    name: 'add_task_dependency',
    description: 'Add a blocking dependency between tasks (blocked_task waits for blocking_task to complete)',
    inputSchema: {
      type: 'object',
      properties: {
        blocked_task_id: {
          type: 'string',
          description: 'Task ID that is blocked (must wait)',
        },
        blocking_task_id: {
          type: 'string',
          description: 'Task ID that blocks (must be completed first)',
        },
      },
      required: ['blocked_task_id', 'blocking_task_id'],
    },
  },
  {
    name: 'remove_task_dependency',
    description: 'Remove a blocking dependency between tasks',
    inputSchema: {
      type: 'object',
      properties: {
        blocked_task_id: {
          type: 'string',
          description: 'Task ID that is blocked',
        },
        blocking_task_id: {
          type: 'string',
          description: 'Task ID that blocks',
        },
      },
      required: ['blocked_task_id', 'blocking_task_id'],
    },
  },

  // Project Knowledge
  {
    name: 'get_project_knowledge',
    description: 'Search project knowledge base (architecture, best practices, specs)',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project ID',
        },
        search: {
          type: 'string',
          description: 'Search query',
        },
        type: {
          type: 'string',
          description: 'Knowledge type filter',
        },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'add_project_knowledge',
    description: 'Add a new knowledge entry to the project',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project ID',
        },
        knowledge_type: {
          type: 'string',
          description: 'Type of knowledge (architecture, best_practice, spec, etc.)',
        },
        title: {
          type: 'string',
          description: 'Knowledge title',
        },
        content: {
          type: 'string',
          description: 'Knowledge content',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Knowledge tags',
        },
      },
      required: ['project_id', 'knowledge_type', 'title', 'content'],
    },
  },
];

if (planEditorClient) {
  tools.push(
    {
      name: 'get_plan_overview',
      description:
        'Fetch the overview, manifest, and epic metadata from the PlanCreator wiki for a given project',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description:
              'Project identifier as used in PlanCreator (typically matches KiraHub project ID or slug)',
          },
        },
        required: ['project_id'],
      },
    },
    {
      name: 'list_plan_tasks',
      description:
        'List tasks from the PlanCreator wiki along with metadata to understand available plan steps',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project identifier to load tasks for',
          },
        },
        required: ['project_id'],
      },
    },
    {
      name: 'get_plan_task_details',
      description:
        'Retrieve the full markdown content and metadata for a specific plan task from the PlanCreator wiki',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project identifier to load tasks for',
          },
          task_id: {
            type: 'string',
            description:
              'Task identifier or title (case-insensitive) as defined in PlanCreator',
          },
        },
        required: ['project_id', 'task_id'],
      },
    },
    {
      name: 'search_plan_tasks',
      description:
        'Search plan tasks in PlanCreator by title, description, tags, or content to find relevant context',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project identifier to search within',
          },
          query: {
            type: 'string',
            description: 'Search string to match against task metadata or content',
          },
        },
        required: ['project_id', 'query'],
      },
    }
  );
}

// Create MCP server
const server = new Server(
  {
    name: 'kirahub-mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'get_next_task': {
        const message = args?.project_id
          ? `Get my next task from project ${args.project_id}`
          : 'Get my next task';
        const response = await a2aClient.sendMessage(message);

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'claim_task': {
        const { task_id } = args as { task_id: string };
        const response = await a2aClient.sendMessage(`Claim task ${task_id}`);

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'complete_task': {
        const { task_id, message } = args as {
          task_id?: string;
          message?: string;
        };

        // Build the request message based on what parameters are provided
        let requestMessage: string;
        if (task_id && message) {
          // Completing a task with a completion message
          requestMessage = `Mark task ${task_id} as completed with message: ${message}`;
        } else if (message && !task_id) {
          // Answering a validation question (no task_id means we're in validation flow)
          requestMessage = message;
        } else if (task_id && !message) {
          // Completing a task without a message
          requestMessage = `Mark task ${task_id} as completed`;
        } else {
          // No parameters - complete current task
          requestMessage = 'Mark current task as completed';
        }

        console.error(`[complete_task] Sending request: ${requestMessage}`);
        const response = await a2aClient.sendMessage(requestMessage);

        // Log full response structure for debugging
        console.error('[complete_task] Full A2A response:', JSON.stringify(response, null, 2));

        if (a2aClient.hasError(response)) {
          console.error('[complete_task] Error detected in response');
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        // Check for validation question
        const validationQuestion = a2aClient.extractValidationQuestion(response);
        if (validationQuestion) {
          console.error('[complete_task] Validation question detected:', validationQuestion);
          const text = a2aClient.extractText(response);
          return {
            content: [
              {
                type: 'text',
                text: `${text}\n\n**Validation Question ${validationQuestion.currentQuestion.sequenceNumber}** (${validationQuestion.currentQuestion.type}):\n${validationQuestion.currentQuestion.text}\n\n**To answer this question, call complete_task again with the answer in the message parameter.**`,
              },
            ],
          };
        }

        // Check for validation result
        const validationResult = a2aClient.extractValidationResult(response);
        if (validationResult) {
          console.error('[complete_task] Validation result detected:', validationResult);
          const text = a2aClient.extractText(response);
          return {
            content: [
              {
                type: 'text',
                text: `${text}\n\n**Validation ${validationResult.validationResult.toUpperCase()}** - Score: ${validationResult.score}%`,
              },
            ],
          };
        }

        // Normal response - log what we're returning
        const normalText = a2aClient.extractText(response);
        console.error('[complete_task] Normal response (no validation):', normalText);

        return {
          content: [{ type: 'text', text: normalText }],
        };
      }

      case 'create_task': {
        const { title, description, project_id, epic_id, tags } = args as any;
        let message = `Create a new task: ${title}`;
        if (description) message += `\nDescription: ${description}`;
        if (project_id) message += `\nProject: ${project_id}`;
        if (epic_id) message += `\nEpic: ${epic_id}`;
        if (tags) message += `\nTags: ${tags.join(', ')}`;

        const response = await a2aClient.sendMessage(message);

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'update_task': {
        const { task_id, title, description, status, tags } = args as any;
        let message = `Update task ${task_id}:`;
        if (title) message += `\nNew title: ${title}`;
        if (description) message += `\nNew description: ${description}`;
        if (status) message += `\nNew status: ${status}`;
        if (tags) message += `\nNew tags: ${tags.join(', ')}`;

        const response = await a2aClient.sendMessage(message);

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'get_task_details': {
        const { task_id } = args as { task_id: string };
        const response = await a2aClient.sendMessage(
          `Get details for task ${task_id}`
        );

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'list_epics': {
        const { project_id } = args as { project_id: string };
        const response = await a2aClient.sendMessage(
          `List all epics for project ${project_id}`
        );

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'get_epic': {
        const { epic_id } = args as { epic_id: string };
        const response = await a2aClient.sendMessage(
          `Get epic details for ${epic_id}`
        );

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'create_epic': {
        const { project_id, name, description } = args as any;
        let message = `Create a new epic in project ${project_id}: ${name}`;
        if (description) message += `\nDescription: ${description}`;

        const response = await a2aClient.sendMessage(message);

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'update_epic': {
        const { epic_id, name, description, status } = args as any;
        let message = `Update epic ${epic_id}:`;
        if (name) message += `\nNew name: ${name}`;
        if (description) message += `\nNew description: ${description}`;
        if (status) message += `\nNew status: ${status}`;

        const response = await a2aClient.sendMessage(message);

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'add_working_note': {
        const { task_id, note, type, priority } = args as any;
        const message = `Add ${priority} ${type} note to task ${task_id}: ${note}`;

        const response = await a2aClient.sendMessage(message);

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'resolve_working_note': {
        const { task_id, note_id } = args as { task_id: string; note_id: string };
        const response = await a2aClient.sendMessage(
          `Resolve note ${note_id} in task ${task_id}`
        );

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'escalate_working_note': {
        const { task_id, note_id, epic_id } = args as any;
        let message = `Escalate note ${note_id} from task ${task_id} to a new task`;
        if (epic_id) message += ` in epic ${epic_id}`;

        const response = await a2aClient.sendMessage(message);

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'get_task_notes': {
        const { task_id } = args as { task_id: string };
        const response = await a2aClient.sendMessage(
          `Get all notes for task ${task_id}`
        );

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'add_task_dependency': {
        const { blocked_task_id, blocking_task_id } = args as {
          blocked_task_id: string;
          blocking_task_id: string;
        };
        const response = await a2aClient.sendMessage(
          `Add dependency: task ${blocked_task_id} is blocked by ${blocking_task_id}`
        );

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'remove_task_dependency': {
        const { blocked_task_id, blocking_task_id } = args as {
          blocked_task_id: string;
          blocking_task_id: string;
        };
        const response = await a2aClient.sendMessage(
          `Remove dependency: task ${blocked_task_id} no longer blocked by ${blocking_task_id}`
        );

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'get_project_knowledge': {
        const { project_id, search, type } = args as any;
        let message = `Search knowledge base for project ${project_id}`;
        if (search) message += `: ${search}`;
        if (type) message += ` (type: ${type})`;

        const response = await a2aClient.sendMessage(message);

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'add_project_knowledge': {
        const { project_id, knowledge_type, title, content, tags } = args as any;
        let message = `Add ${knowledge_type} knowledge to project ${project_id}: ${title}\nContent: ${content}`;
        if (tags) message += `\nTags: ${tags.join(', ')}`;

        const response = await a2aClient.sendMessage(message);

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text', text: a2aClient.extractText(response) }],
        };
      }

      case 'get_plan_overview': {
        if (!planEditorClient) {
          return {
            content: [
              {
                type: 'text',
                text: 'Plan editor integration is not configured. Set PLANCREATOR_API_URL or PLAN_EDITOR_API_URL to enable.',
              },
            ],
            isError: true,
          };
        }

        const { project_id } = args as { project_id: string };
        const plan = await planEditorClient.getProjectPlan(project_id);
        const manifest = plan.manifest || {};
        const overviewText = plan.overview?.trim() || 'No overview available.';
        const tasksCount = plan.tasks?.length ?? 0;
        const epics = Array.isArray(manifest.epics) ? manifest.epics : [];

        const lines: string[] = [
          `Plan overview for project ${plan.project_id}`,
          `Name: ${manifest.name || 'Untitled plan'}`,
          `Description: ${manifest.description || 'No description set.'}`,
          `Updated: ${manifest.updated_at || 'Unknown'}`,
          `Version: ${manifest.version || 'N/A'}`,
          `Total tasks: ${tasksCount}`,
        ];

        if (epics.length > 0) {
          lines.push(
            'Epics:',
            ...epics.map((epic: any, index: number) => {
              const epicId = epic?.id || `epic-${index + 1}`;
              const epicName = epic?.name || epic?.title || 'Untitled epic';
              const epicStatus = epic?.status ? ` (${epic.status})` : '';
              return `  • ${epicName} [${epicId}]${epicStatus}`;
            })
          );
        }

        if (planEditorBaseUrl) {
          lines.push(
            `PlanCreator API: ${planEditorBaseUrl}/plan/${encodeURIComponent(project_id)}`
          );
        }

        lines.push('', 'Overview:', overviewText);

        return {
          content: [{ type: 'text', text: lines.join('\n') }],
        };
      }

      case 'list_plan_tasks': {
        if (!planEditorClient) {
          return {
            content: [
              {
                type: 'text',
                text: 'Plan editor integration is not configured. Set PLANCREATOR_API_URL or PLAN_EDITOR_API_URL to enable.',
              },
            ],
            isError: true,
          };
        }

        const { project_id } = args as { project_id: string };
        const plan = await planEditorClient.getProjectPlan(project_id);
        const tasks = plan.tasks || [];

        if (!tasks.length) {
          return {
            content: [
              {
                type: 'text',
                text: `No plan tasks found for project ${project_id}.`,
              },
            ],
          };
        }

        const maxTasksToDisplay = 50;
        const formattedTasks = tasks.slice(0, maxTasksToDisplay).map((task, index) => {
          const metadata = task.metadata || {};
          const identifier = metadata.id || metadata.title || `task-${index + 1}`;
          const title = metadata.title || 'Untitled task';
          const type = metadata.type || 'action';
          const deps =
            Array.isArray(metadata.dependencies) && metadata.dependencies.length > 0
              ? metadata.dependencies.join(', ')
              : 'none';
          const tags =
            Array.isArray(metadata.tags) && metadata.tags.length > 0
              ? metadata.tags.join(', ')
              : 'none';
          return `${index + 1}. ${title} [${identifier}] (type: ${type}, deps: ${deps}, tags: ${tags})`;
        });

        if (tasks.length > maxTasksToDisplay) {
          formattedTasks.push(
            '',
            `Showing first ${maxTasksToDisplay} tasks of ${tasks.length} total. Refine your query for more detail.`
          );
        }

        return {
          content: [
            {
              type: 'text',
              text: [`Tasks for project ${project_id}:`, ...formattedTasks].join('\n'),
            },
          ],
        };
      }

      case 'get_plan_task_details': {
        if (!planEditorClient) {
          return {
            content: [
              {
                type: 'text',
                text: 'Plan editor integration is not configured. Set PLANCREATOR_API_URL or PLAN_EDITOR_API_URL to enable.',
              },
            ],
            isError: true,
          };
        }

        const { project_id, task_id } = args as {
          project_id: string;
          task_id: string;
        };

        const task = await planEditorClient.getTaskDetails(project_id, task_id);

        if (!task) {
          return {
            content: [
              {
                type: 'text',
                text: `Task '${task_id}' not found in project ${project_id}. Try 'list_plan_tasks' to view available tasks.`,
              },
            ],
            isError: true,
          };
        }

        const metadata = task.metadata || {};
        const metaLines = [
          `Task metadata for ${metadata.id || task_id}:`,
          `Title: ${metadata.title || 'Untitled task'}`,
          `Type: ${metadata.type || 'action'}`,
          `Description: ${metadata.description || 'No description set.'}`,
          `Dependencies: ${
            Array.isArray(metadata.dependencies) && metadata.dependencies.length > 0
              ? metadata.dependencies.join(', ')
              : 'none'
          }`,
          `Tags: ${
            Array.isArray(metadata.tags) && metadata.tags.length > 0
              ? metadata.tags.join(', ')
              : 'none'
          }`,
          `File: ${task.file_name || 'unknown'}`,
        ];

        const taskContent = task.content || 'This task has no markdown content.';

        return {
          content: [
            {
              type: 'text',
              text: `${metaLines.join('\n')}\n\nMarkdown Content:\n${taskContent}`,
            },
          ],
        };
      }

      case 'search_plan_tasks': {
        if (!planEditorClient) {
          return {
            content: [
              {
                type: 'text',
                text: 'Plan editor integration is not configured. Set PLANCREATOR_API_URL or PLAN_EDITOR_API_URL to enable.',
              },
            ],
            isError: true,
          };
        }

        const { project_id, query } = args as {
          project_id: string;
          query: string;
        };

        const results = await planEditorClient.searchTasks(project_id, query);

        if (!results.length) {
          return {
            content: [
              {
                type: 'text',
                text: `No plan tasks matched '${query}' in project ${project_id}.`,
              },
            ],
          };
        }

        const maxResults = 10;
        const formattedResults = results.slice(0, maxResults).map(({ task, matchType }, index) => {
          const metadata = task.metadata || {};
          const identifier = metadata.id || metadata.title || `task-${index + 1}`;
          const title = metadata.title || 'Untitled task';
          const description =
            metadata.description?.split('\n').join(' ').slice(0, 240) ||
            'No description available.';
          const tags =
            Array.isArray(metadata.tags) && metadata.tags.length > 0
              ? metadata.tags.join(', ')
              : 'none';
          return `${index + 1}. ${title} [${identifier}] — match in ${matchType}\n   Tags: ${tags}\n   Description: ${description}`;
        });

        if (results.length > maxResults) {
          formattedResults.push(
            '',
            `Showing top ${maxResults} of ${results.length} matches. Refine your search for more precise results.`
          );
        }

        return {
          content: [
            {
              type: 'text',
              text: [`Search results for '${query}' in project ${project_id}:`, ...formattedResults].join('\n'),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error executing ${name}: ${error.message || error}`,
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('KiraHub MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});

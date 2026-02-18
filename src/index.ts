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
import { ActivityClient, ActivityEventType, ContextCategory } from './activity-client.js';
import dotenv from 'dotenv';

dotenv.config();

const KIRAHUB_API_URL = process.env.KIRAHUB_API_URL || 'http://localhost:3000';
const KIRAHUB_API_KEY = process.env.KIRAHUB_API_KEY;
const KIRAHUB_PROJECT_ID = process.env.KIRAHUB_PROJECT_ID || null;

// Track current task context for automatic activity posting
let currentTaskId: string | null = null;
let currentProjectId: string | null = null;

// Track context cleanup state
let pendingContextCleanup: {
  items: Array<{ category: string; key: string; value: any }>;
  projectId: string;
  taskId: string;
} | null = null;

if (!KIRAHUB_API_KEY) {
  console.error('Error: KIRAHUB_API_KEY environment variable is required');
  process.exit(1);
}

if (KIRAHUB_PROJECT_ID) {
  console.error(`Default project configured: ${KIRAHUB_PROJECT_ID}`);
}

const a2aClient = new A2AClient(KIRAHUB_API_URL, KIRAHUB_API_KEY);
const activityClient = new ActivityClient(KIRAHUB_API_URL, KIRAHUB_API_KEY);

/**
 * Check if there are context items created by this task that need cleanup review
 */
async function checkForContextCleanup(
  projectId: string,
  taskId: string
): Promise<string | null> {
  try {
    const contextItems = await activityClient.getContextByTask(projectId, taskId);

    if (contextItems.length === 0) {
      console.error('[checkForContextCleanup] No context items found for task');
      return null;
    }

    console.error(`[checkForContextCleanup] Found ${contextItems.length} context items for task ${taskId}`);

    // Store for later processing
    pendingContextCleanup = {
      items: contextItems.map((item) => ({
        category: item.category,
        key: item.key,
        value: item.value,
      })),
      projectId,
      taskId,
    };

    // Build the prompt
    const itemsList = contextItems
      .map((item, index) => `${index + 1}. **${item.category}/${item.key}**: ${JSON.stringify(item.value).slice(0, 100)}${JSON.stringify(item.value).length > 100 ? '...' : ''}`)
      .join('\n');

    return `---
## Context Cleanup

This task created ${contextItems.length} shared context item(s):

${itemsList}

**Please review these items and decide which should be:**
- **Kept** - Permanent project knowledge useful for future tasks
- **Deleted** - Task-specific context no longer needed

**To complete cleanup, call complete_task with a message in this format:**
\`\`\`
keep: 1, 2 (or "all" to keep everything)
delete: 3 (or "all" to delete everything, or "none" to keep everything)
\`\`\`

Example: "keep: 1, 2 delete: 3" or "keep: all" or "delete: all"`;
  } catch (error) {
    console.error('[checkForContextCleanup] Error fetching context:', error);
    return null;
  }
}

/**
 * Process the context cleanup response from the agent
 */
async function processContextCleanup(
  message: string,
  cleanup: {
    items: Array<{ category: string; key: string; value: any }>;
    projectId: string;
    taskId: string;
  }
): Promise<string> {
  const lowerMessage = message.toLowerCase();
  const results: string[] = [];

  // Parse the response
  let itemsToDelete: number[] = [];
  let itemsToKeep: number[] = [];

  // Check for "delete: all" or "keep: all"
  if (lowerMessage.includes('delete: all') || lowerMessage.includes('delete:all')) {
    itemsToDelete = cleanup.items.map((_, i) => i + 1);
  } else if (lowerMessage.includes('keep: all') || lowerMessage.includes('keep:all') || lowerMessage.includes('delete: none') || lowerMessage.includes('delete:none')) {
    itemsToKeep = cleanup.items.map((_, i) => i + 1);
  } else {
    // Parse specific numbers
    const keepMatch = lowerMessage.match(/keep:\s*([0-9,\s]+)/);
    const deleteMatch = lowerMessage.match(/delete:\s*([0-9,\s]+)/);

    if (keepMatch) {
      itemsToKeep = keepMatch[1].split(',').map((n) => parseInt(n.trim())).filter((n) => !isNaN(n));
    }
    if (deleteMatch) {
      itemsToDelete = deleteMatch[1].split(',').map((n) => parseInt(n.trim())).filter((n) => !isNaN(n));
    }

    // If only keep is specified, delete the rest
    if (itemsToKeep.length > 0 && itemsToDelete.length === 0) {
      const allIndices = cleanup.items.map((_, i) => i + 1);
      itemsToDelete = allIndices.filter((i) => !itemsToKeep.includes(i));
    }
  }

  console.error(`[processContextCleanup] Items to keep: ${itemsToKeep}, Items to delete: ${itemsToDelete}`);

  // Delete the specified items
  let deletedCount = 0;
  for (const index of itemsToDelete) {
    if (index >= 1 && index <= cleanup.items.length) {
      const item = cleanup.items[index - 1];
      try {
        const deleted = await activityClient.deleteContext(
          cleanup.projectId,
          item.category as ContextCategory,
          item.key
        );
        if (deleted) {
          deletedCount++;
          results.push(`Deleted: ${item.category}/${item.key}`);
        }
      } catch (error) {
        console.error(`[processContextCleanup] Failed to delete ${item.category}/${item.key}:`, error);
        results.push(`Failed to delete: ${item.category}/${item.key}`);
      }
    }
  }

  const keptCount = cleanup.items.length - deletedCount;

  return `Context cleanup completed:
- ${keptCount} item(s) kept as permanent project knowledge
- ${deletedCount} item(s) deleted

${results.length > 0 ? '\nDetails:\n' + results.join('\n') : ''}`
    .trim();
}

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
          description: 'Optional project identifier (UUID, readable_id, or name/slug) to filter tasks',
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
          description: 'Project identifier - UUID, readable_id, or name/slug (required if epic_id not provided)',
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
          description: 'Project identifier (UUID, readable_id, or name/slug)',
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
          description: 'Project identifier (UUID, readable_id, or name/slug)',
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
      'Add a working note to a task (todo, bug, edge case, optimization, plan, or information). Plan notes auto-resolve previous plans. Priority defaults to informational for plan/information types.',
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
          enum: ['todo', 'bug', 'edge_case', 'optimization', 'plan', 'information'],
          description: 'Type of note',
        },
        priority: {
          type: 'string',
          enum: ['must_fix', 'should_fix', 'nice_to_have', 'informational'],
          description: 'Priority level (defaults to informational for plan/information types)',
        },
      },
      required: ['task_id', 'note', 'type'],
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

  // Plan Syncing
  {
    name: 'sync_plan',
    description:
      'Sync an implementation plan to the currently claimed task as a working note. Uses the current task context automatically - no task_id needed. Previous plan notes are auto-resolved. Call this after exiting plan mode.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'The implementation plan content',
        },
        task_id: {
          type: 'string',
          description: 'Optional task ID override (uses currently claimed task if omitted)',
        },
      },
      required: ['plan'],
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
          description: 'Project identifier (UUID, readable_id, or name/slug)',
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
          description: 'Project identifier (UUID, readable_id, or name/slug)',
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

  // Activity Tracking
  {
    name: 'post_activity',
    description:
      'Post an activity event to track what the agent is doing. You MUST call this proactively throughout your work — do not wait to be asked. Specifically:\n' +
      '- Post `progress` after completing each significant milestone (e.g., "Database schema done, moving to API endpoints")\n' +
      '- Post `file_created` or `file_modified` when you create or change key files\n' +
      '- Post `decision` when you make architectural or technical choices (include rationale)\n' +
      '- Post `commit` after git commits, `pr_created` after creating PRs\n' +
      '- Post `blocked` if you cannot proceed, `error` if something goes wrong\n' +
      '- Post `warning` for things other agents or the team should know about\n' +
      'The project_id and task_id are auto-filled from the currently claimed task if omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project identifier - UUID, readable_id, or name/slug (optional - uses current project from claimed task if not provided)',
        },
        task_id: {
          type: 'string',
          description: 'Task ID (optional - uses current task if not provided)',
        },
        event_type: {
          type: 'string',
          enum: [
            // Status Changes
            'started',
            'completed',
            'blocked',
            'unblocked',
            'progress',
            // Code Changes
            'file_created',
            'file_modified',
            'file_deleted',
            'commit',
            'pr_created',
            'pr_merged',
            // Code Artifacts
            'type_created',
            'type_modified',
            'utility_created',
            'api_created',
            'api_modified',
            // Build & Test
            'test_run',
            'build_run',
            'lint_run',
            'deploy',
            // Decisions & Issues
            'decision',
            'question',
            'warning',
            'error',
          ],
          description: 'Type of activity event',
        },
        message: {
          type: 'string',
          description: 'Description of what happened',
        },
        metadata: {
          type: 'object',
          description:
            'Optional metadata (e.g., { files: ["src/auth.ts"], rationale: "..." })',
        },
      },
      required: ['event_type', 'message'],
    },
  },
  {
    name: 'get_activity',
    description: 'Get recent activity events for a project or task',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project identifier - UUID, readable_id, or name/slug (optional - uses current project from claimed task if not provided)',
        },
        task_id: {
          type: 'string',
          description: 'Task ID (optional - if provided, gets task-specific activity)',
        },
        event_types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by event types (optional)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default: 20)',
        },
      },
      required: [],
    },
  },

  // Shared Context
  {
    name: 'get_shared_context',
    description:
      'Get shared context for a project (contracts, utilities, decisions, config)',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project identifier - UUID, readable_id, or name/slug (optional - uses current project from claimed task if not provided)',
        },
        category: {
          type: 'string',
          enum: ['contracts', 'utilities', 'decisions', 'config'],
          description: 'Optional category filter',
        },
        key: {
          type: 'string',
          description: 'Optional specific key to retrieve',
        },
      },
      required: [],
    },
  },
  {
    name: 'set_shared_context',
    description:
      'Set a shared context item so other agents can see your work. You SHOULD call this when:\n' +
      '- You create or modify a shared interface/type → category: "contracts"\n' +
      '- You create a reusable utility function → category: "utilities"\n' +
      '- You make a technical/architectural decision → category: "decisions" (include rationale)\n' +
      '- You add or change environment variables or config → category: "config"\n' +
      'This enables parallel agents to stay coordinated without reading each other\'s code.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project identifier - UUID, readable_id, or name/slug (optional - uses current project from claimed task if not provided)',
        },
        category: {
          type: 'string',
          enum: ['contracts', 'utilities', 'decisions', 'config'],
          description: 'Context category',
        },
        key: {
          type: 'string',
          description: 'Unique key for this context item',
        },
        value: {
          type: 'object',
          description:
            'Context value (e.g., { definition: "interface User {...}", location: "src/types.ts" })',
        },
      },
      required: ['category', 'key', 'value'],
    },
  },
  {
    name: 'delete_shared_context',
    description: 'Delete a shared context item',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Project identifier - UUID, readable_id, or name/slug (optional - uses current project from claimed task if not provided)',
        },
        category: {
          type: 'string',
          enum: ['contracts', 'utilities', 'decisions', 'config'],
          description: 'Context category',
        },
        key: {
          type: 'string',
          description: 'Key of the context item to delete',
        },
      },
      required: ['category', 'key'],
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

// When a default project is configured, update tool definitions:
// 1. Append default info to project_id descriptions
// 2. Remove project_id from required arrays (since the default covers it)
if (KIRAHUB_PROJECT_ID) {
  for (const tool of tools) {
    const schema = tool.inputSchema as any;
    if (schema?.properties?.project_id) {
      schema.properties.project_id = {
        ...schema.properties.project_id,
        description:
          (schema.properties.project_id.description || '') +
          ` (defaults to configured project: ${KIRAHUB_PROJECT_ID})`,
      };
      if (Array.isArray(schema.required)) {
        schema.required = schema.required.filter((r: string) => r !== 'project_id');
      }
    }
  }
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
        const effectiveProjectId = args?.project_id || KIRAHUB_PROJECT_ID;
        const message = effectiveProjectId
          ? `Get my next task from project ${effectiveProjectId}`
          : 'Get my next task';
        const structuredEntities = effectiveProjectId
          ? { projectId: effectiveProjectId }
          : undefined;
        const response = await a2aClient.sendMessage(message, undefined, structuredEntities);

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
        const response = await a2aClient.sendMessage(
          `Claim task ${task_id}`,
          undefined,
          { taskId: task_id }
        );

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        // Extract task data from response to get the actual UUID
        const taskData = a2aClient.extractTaskData(response);
        const taskUuid = taskData?.id || task_id;
        const projectId = taskData?.project_id || null;

        // Store current task UUID for automatic activity tracking
        currentTaskId = taskUuid;
        currentProjectId = projectId;

        // Try to extract project ID from the response and auto-post activity
        const responseText = a2aClient.extractText(response);

        // Try to post "started" activity (best effort - don't fail if this fails)
        try {
          if (currentProjectId) {
            await activityClient.postActivity({
              projectId: currentProjectId,
              taskId: taskUuid,
              eventType: 'started',
              message: 'Claimed and started working on task',
            });
            console.error(`[claim_task] Auto-posted 'started' activity for task ${taskUuid}`);
          }
        } catch (activityError) {
          console.error('[claim_task] Failed to auto-post activity (non-fatal):', activityError);
        }

        // Fetch project context bundle (knowledge + shared context)
        let contextBundle = '';
        if (projectId) {
          try {
            // Fetch shared context
            const context = await activityClient.getContext(projectId);
            const hasContext = Object.values(context).some(
              (cat) => Object.keys(cat).length > 0
            );

            if (hasContext) {
              const contextLines: string[] = ['\n\n---\n## Project Shared Context'];
              for (const cat of ['contracts', 'utilities', 'decisions', 'config'] as const) {
                const items = context[cat] || {};
                const keys = Object.keys(items);
                if (keys.length > 0) {
                  contextLines.push(`\n### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
                  for (const k of keys) {
                    const value = items[k];
                    contextLines.push(`- **${k}**: ${JSON.stringify(value)}`);
                  }
                }
              }
              contextBundle += contextLines.join('\n');
            }

            // Fetch project knowledge
            const knowledgeResponse = await a2aClient.sendMessage(
              `Search knowledge base for project ${projectId}`
            );
            if (!a2aClient.hasError(knowledgeResponse)) {
              const knowledgeText = a2aClient.extractText(knowledgeResponse);
              if (knowledgeText && !knowledgeText.includes('No knowledge')) {
                contextBundle += '\n\n---\n## Project Knowledge\n' + knowledgeText;
              }
            }

            // Fetch recent activity from other agents
            const activities = await activityClient.getProjectActivity({
              projectId,
              limit: 5,
            });
            if (activities.length > 0) {
              contextBundle += '\n\n---\n## Recent Activity';
              for (const a of activities) {
                contextBundle += `\n- [${a.eventType}] ${a.message}`;
              }
            }
          } catch (contextError) {
            console.error('[claim_task] Failed to fetch context bundle (non-fatal):', contextError);
          }
        }

        const workflowReminder = `\n\n---
## Agent Workflow Guide

### Activity Tracking (IMPORTANT)
You MUST post activity updates proactively throughout your work using \`post_activity\`. Do not wait to be asked.

**When to post:**
| Moment | event_type | Example message |
|--------|-----------|-----------------|
| Starting implementation | \`progress\` | "Beginning database schema design" |
| Completing a milestone | \`progress\` | "API endpoints done, moving to tests" |
| Creating/modifying files | \`file_created\` / \`file_modified\` | "Created src/api/users.ts" |
| Making a technical choice | \`decision\` | "Using JSONB for flexible schema - avoids migrations" |
| After git commit | \`commit\` | "Committed user preferences feature (abc123)" |
| After creating a PR | \`pr_created\` | "Created PR #42 for user preferences" |
| Encountering a blocker | \`blocked\` | "Waiting for auth middleware from other agent" |
| Something goes wrong | \`error\` | "Migration failed - foreign key constraint" |
| Team should know something | \`warning\` | "API rate limit approaching, consider caching" |

### Shared Context
When you create or modify shared interfaces, utilities, or make architectural decisions, call \`set_shared_context\` so other agents stay coordinated.

### Plan Syncing
- After exiting plan mode, call \`sync_plan\` with your plan content to share it with the team.
- Use \`add_working_note\` with \`type: "information"\` for progress updates during implementation.`;


        return {
          content: [{ type: 'text', text: responseText + contextBundle + workflowReminder }],
        };
      }

      case 'complete_task': {
        const { task_id, message } = args as {
          task_id?: string;
          message?: string;
        };

        // Check if we're in context cleanup flow
        if (pendingContextCleanup && message) {
          console.error('[complete_task] Processing context cleanup response');
          const cleanupResult = await processContextCleanup(message, pendingContextCleanup);
          pendingContextCleanup = null;
          // Don't clear currentTaskId here — the agent may still post activities
          // (e.g., a descriptive "completed" summary). It resets on next claim_task.
          return {
            content: [{ type: 'text', text: cleanupResult }],
          };
        }

        // Check if a plan was ever synced (best effort, non-blocking)
        let planWarning = '';
        const taskIdToCheck = task_id || currentTaskId;
        if (taskIdToCheck && !message) {
          // Only check on initial completion call, not validation answers
          try {
            const notes = await activityClient.getTaskNotes(taskIdToCheck);
            const hasPlan = notes.some(n => n.type === 'plan');
            if (!hasPlan) {
              planWarning = '\n\n**Note:** No implementation plan was synced for this task. Consider calling `sync_plan` before completing to share your approach with the team.';
            }
          } catch (e) {
            console.error('[complete_task] Failed to check plan notes (non-fatal):', e);
          }
        }

        // Build the request message based on what parameters are provided
        let requestMessage: string;
        let structuredEntities: Record<string, any> | undefined;

        if (task_id && message) {
          // Completing a task with a completion message — pass it as structured entity
          requestMessage = `Mark task ${task_id} as completed with message: ${message}`;
          structuredEntities = {
            taskId: task_id,
            status: 'completed',
            completionMessage: message,
          };
        } else if (message && !task_id) {
          // Answering a validation question (no task_id means we're in validation flow)
          requestMessage = message;
        } else if (task_id && !message) {
          // Completing a task without a message
          requestMessage = `Mark task ${task_id} as completed`;
          structuredEntities = {
            taskId: task_id,
            status: 'completed',
          };
        } else {
          // No parameters - complete current task
          requestMessage = 'Mark current task as completed';
          structuredEntities = {
            status: 'completed',
          };
        }

        console.error(`[complete_task] Sending request: ${requestMessage}`);
        const response = await a2aClient.sendMessage(requestMessage, undefined, structuredEntities);

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
                text: `${text}\n\n**Validation Question ${validationQuestion.currentQuestion.sequenceNumber}** (${validationQuestion.currentQuestion.type}):\n${validationQuestion.currentQuestion.text}\n\n**To answer this question, call complete_task again with the answer in the message parameter.**${planWarning}`,
              },
            ],
          };
        }

        // Check for validation result
        const validationResult = a2aClient.extractValidationResult(response);
        if (validationResult) {
          console.error('[complete_task] Validation result detected:', validationResult);
          const text = a2aClient.extractText(response);

          // If validation passed, post completed activity and check for context cleanup
          if (validationResult.validationResult === 'passed' && currentProjectId && currentTaskId) {
            try {
              await activityClient.postActivity({
                projectId: currentProjectId,
                taskId: currentTaskId,
                eventType: 'completed',
                message: `Task completed with validation score: ${validationResult.score}%`,
              });
              console.error(`[complete_task] Auto-posted 'completed' activity for task ${currentTaskId}`);
            } catch (activityError) {
              console.error('[complete_task] Failed to auto-post activity (non-fatal):', activityError);
            }

            // Check for context items created by this task
            const cleanupPrompt = await checkForContextCleanup(currentProjectId, currentTaskId);
            if (cleanupPrompt) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `${text}\n\n**Validation ${validationResult.validationResult.toUpperCase()}** - Score: ${validationResult.score}%\n\n${cleanupPrompt}`,
                  },
                ],
              };
            }

            // Don't clear currentTaskId — the agent may still post activities after completion.
            // It resets on next claim_task.
          }

          return {
            content: [
              {
                type: 'text',
                text: `${text}\n\n**Validation ${validationResult.validationResult.toUpperCase()}** - Score: ${validationResult.score}%`,
              },
            ],
          };
        }

        // Normal response (no validation) - task was completed directly
        const normalText = a2aClient.extractText(response);
        console.error('[complete_task] Normal response (no validation):', normalText);

        // Check if the response indicates success and post activity
        const taskIdToComplete = task_id || currentTaskId;
        if (taskIdToComplete && currentProjectId && !normalText.toLowerCase().includes('error')) {
          try {
            await activityClient.postActivity({
              projectId: currentProjectId,
              taskId: taskIdToComplete,
              eventType: 'completed',
              message: 'Task completed',
            });
            console.error(`[complete_task] Auto-posted 'completed' activity for task ${taskIdToComplete}`);
          } catch (activityError) {
            console.error('[complete_task] Failed to auto-post activity (non-fatal):', activityError);
          }

          // Check for context items created by this task
          const cleanupPrompt = await checkForContextCleanup(currentProjectId, taskIdToComplete);
          if (cleanupPrompt) {
            return {
              content: [{ type: 'text', text: `${normalText}\n\n${cleanupPrompt}` }],
            };
          }

          // Don't clear currentTaskId — the agent may still post activities after completion.
          // It resets on next claim_task.
        }

        return {
          content: [{ type: 'text', text: normalText + planWarning }],
        };
      }

      case 'create_task': {
        const { title, description, project_id, epic_id, tags } = args as any;
        const effectiveProjectId = project_id || KIRAHUB_PROJECT_ID;
        let message = `Create a new task: ${title}`;
        if (description) message += `\nDescription: ${description}`;
        if (effectiveProjectId) message += `\nProject: ${effectiveProjectId}`;
        if (epic_id) message += `\nEpic: ${epic_id}`;
        if (tags) message += `\nTags: ${tags.join(', ')}`;

        const entities: Record<string, any> = { title };
        if (description) entities.description = description;
        if (effectiveProjectId) entities.projectId = effectiveProjectId;
        if (epic_id) entities.epicId = epic_id;
        if (tags) entities.tags = tags;

        const response = await a2aClient.sendMessage(message, undefined, entities);

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

        const entities: Record<string, any> = { taskId: task_id };
        if (title) entities.title = title;
        if (description) entities.description = description;
        if (status) entities.status = status;
        if (tags) entities.tags = tags;

        const response = await a2aClient.sendMessage(message, undefined, entities);

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
          `Get details for task ${task_id}`,
          undefined,
          { taskId: task_id }
        );

        if (a2aClient.hasError(response)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(response) },
            ],
            isError: true,
          };
        }

        const responseText = a2aClient.extractText(response);

        // Try to extract project ID and fetch context bundle
        let contextBundle = '';
        const projectMatch = responseText.match(/project[:\s]+([a-f0-9-]{36})/i);
        const projectId = projectMatch ? projectMatch[1] : null;

        if (projectId) {
          try {
            // Fetch shared context
            const context = await activityClient.getContext(projectId);
            const hasContext = Object.values(context).some(
              (cat) => Object.keys(cat).length > 0
            );

            if (hasContext) {
              const contextLines: string[] = ['\n\n---\n## Project Shared Context'];
              for (const cat of ['contracts', 'utilities', 'decisions', 'config'] as const) {
                const items = context[cat] || {};
                const keys = Object.keys(items);
                if (keys.length > 0) {
                  contextLines.push(`\n### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
                  for (const k of keys) {
                    const value = items[k];
                    contextLines.push(`- **${k}**: ${JSON.stringify(value)}`);
                  }
                }
              }
              contextBundle += contextLines.join('\n');
            }

            // Fetch project knowledge
            const knowledgeResponse = await a2aClient.sendMessage(
              `Search knowledge base for project ${projectId}`
            );
            if (!a2aClient.hasError(knowledgeResponse)) {
              const knowledgeText = a2aClient.extractText(knowledgeResponse);
              if (knowledgeText && !knowledgeText.includes('No knowledge')) {
                contextBundle += '\n\n---\n## Project Knowledge\n' + knowledgeText;
              }
            }

            // Fetch recent activity
            const activities = await activityClient.getProjectActivity({
              projectId,
              limit: 5,
            });
            if (activities.length > 0) {
              contextBundle += '\n\n---\n## Recent Activity';
              for (const a of activities) {
                contextBundle += `\n- [${a.eventType}] ${a.message}`;
              }
            }
          } catch (contextError) {
            console.error('[get_task_details] Failed to fetch context bundle (non-fatal):', contextError);
          }
        }

        return {
          content: [{ type: 'text', text: responseText + contextBundle }],
        };
      }

      case 'list_epics': {
        const effectiveProjectId = (args as any)?.project_id || KIRAHUB_PROJECT_ID;
        if (!effectiveProjectId) {
          return {
            content: [{ type: 'text', text: 'project_id is required. Provide it explicitly or set KIRAHUB_PROJECT_ID.' }],
            isError: true,
          };
        }
        const response = await a2aClient.sendMessage(
          `List all epics for project ${effectiveProjectId}`,
          undefined,
          { projectId: effectiveProjectId }
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
        const effectiveProjectId = project_id || KIRAHUB_PROJECT_ID;
        if (!effectiveProjectId) {
          return {
            content: [{ type: 'text', text: 'project_id is required. Provide it explicitly or set KIRAHUB_PROJECT_ID.' }],
            isError: true,
          };
        }
        let message = `Create a new epic in project ${effectiveProjectId}: ${name}`;
        if (description) message += `\nDescription: ${description}`;

        const entities: Record<string, any> = { epicName: name };
        entities.projectId = effectiveProjectId;
        if (description) entities.epicDescription = description;

        const response = await a2aClient.sendMessage(message, undefined, entities);

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
        const effectivePriority = priority || (type === 'plan' || type === 'information' ? 'informational' : 'should_fix');
        // For plan/information notes, keep NLP text short and pass full content via structured entities
        const shortNote = note.length > 200 ? note.substring(0, 200) + '...' : note;
        const message = `Add ${effectivePriority} ${type} note to task ${task_id}: ${shortNote}`;

        const response = await a2aClient.sendMessage(message, undefined, {
          taskId: task_id,
          noteText: note,
          noteType: type,
          notePriority: effectivePriority,
        });

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

      case 'sync_plan': {
        const { plan, task_id: explicitTaskId } = args as { plan: string; task_id?: string };
        const targetTaskId = explicitTaskId || currentTaskId;

        if (!targetTaskId) {
          return {
            content: [
              { type: 'text', text: 'No task is currently claimed. Either claim a task first or provide a task_id.' },
            ],
            isError: true,
          };
        }

        // Use the same approach as add_working_note but with plan defaults
        const shortNote = plan.length > 200 ? plan.substring(0, 200) + '...' : plan;
        const syncMessage = `Add informational plan note to task ${targetTaskId}: ${shortNote}`;

        const syncResponse = await a2aClient.sendMessage(syncMessage, undefined, {
          taskId: targetTaskId,
          noteText: plan,
          noteType: 'plan',
          notePriority: 'informational',
        });

        if (a2aClient.hasError(syncResponse)) {
          return {
            content: [
              { type: 'text', text: a2aClient.getErrorMessage(syncResponse) },
            ],
            isError: true,
          };
        }

        // Also post a progress activity
        if (currentProjectId) {
          try {
            await activityClient.postActivity({
              projectId: currentProjectId,
              taskId: targetTaskId,
              eventType: 'progress',
              message: 'Implementation plan synced to task',
            });
          } catch (activityError) {
            console.error('[sync_plan] Failed to post activity (non-fatal):', activityError);
          }
        }

        return {
          content: [{ type: 'text', text: `Plan synced to task ${targetTaskId}. Previous plan notes (if any) were auto-resolved.` }],
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
        const effectiveProjectId = project_id || KIRAHUB_PROJECT_ID;
        if (!effectiveProjectId) {
          return {
            content: [{ type: 'text', text: 'project_id is required. Provide it explicitly or set KIRAHUB_PROJECT_ID.' }],
            isError: true,
          };
        }
        let message = `Search knowledge base for project ${effectiveProjectId}`;
        if (search) message += `: ${search}`;
        if (type) message += ` (type: ${type})`;

        const entities: Record<string, any> = { projectId: effectiveProjectId };
        if (search) entities.query = search;
        if (type) entities.knowledgeType = type;

        const response = await a2aClient.sendMessage(message, undefined, entities);

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
        const effectiveProjectId = project_id || KIRAHUB_PROJECT_ID;
        if (!effectiveProjectId) {
          return {
            content: [{ type: 'text', text: 'project_id is required. Provide it explicitly or set KIRAHUB_PROJECT_ID.' }],
            isError: true,
          };
        }
        let message = `Add ${knowledge_type} knowledge to project ${effectiveProjectId}: ${title}\nContent: ${content}`;
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

      // Activity Tracking Handlers
      case 'post_activity': {
        const { project_id, task_id, event_type, message, metadata } = args as {
          project_id?: string;
          task_id?: string;
          event_type: ActivityEventType;
          message: string;
          metadata?: Record<string, any>;
        };

        // Use provided project_id, or fall back to currentProjectId, or default project
        const resolvedProjectId = project_id || currentProjectId || KIRAHUB_PROJECT_ID;
        if (!resolvedProjectId) {
          return {
            content: [
              {
                type: 'text',
                text: 'No project context available. Either provide project_id or claim a task first.',
              },
            ],
            isError: true,
          };
        }

        try {
          const activity = await activityClient.postActivity({
            projectId: resolvedProjectId,
            taskId: task_id || currentTaskId || undefined,
            eventType: event_type,
            message,
            metadata,
          });

          return {
            content: [
              {
                type: 'text',
                text: `Activity posted: [${activity.eventType}] ${activity.message}\nID: ${activity.id}`,
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to post activity: ${error.message || error}`,
              },
            ],
            isError: true,
          };
        }
      }

      case 'get_activity': {
        const { project_id, task_id, event_types, limit } = args as {
          project_id?: string;
          task_id?: string;
          event_types?: string[];
          limit?: number;
        };

        // Use provided project_id, or fall back to currentProjectId, or default project
        const resolvedProjectId = project_id || currentProjectId || KIRAHUB_PROJECT_ID;

        try {
          let activities;
          if (task_id) {
            activities = await activityClient.getTaskActivity(task_id, limit);
          } else if (resolvedProjectId) {
            activities = await activityClient.getProjectActivity({
              projectId: resolvedProjectId,
              eventTypes: event_types as ActivityEventType[],
              limit: limit || 20,
            });
          } else {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No project context available. Either provide project_id, task_id, or claim a task first.',
                },
              ],
              isError: true,
            };
          }

          if (activities.length === 0) {
            return {
              content: [{ type: 'text', text: 'No activity events found.' }],
            };
          }

          const formatted = activities
            .map(
              (a) =>
                `[${a.eventType}] ${a.message}${a.taskId ? ` (task: ${a.taskId.slice(0, 8)}...)` : ''}\n  ${new Date(a.createdAt).toLocaleString()}`
            )
            .join('\n\n');

          return {
            content: [
              {
                type: 'text',
                text: `Recent Activity (${activities.length} events):\n\n${formatted}`,
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to get activity: ${error.message || error}`,
              },
            ],
            isError: true,
          };
        }
      }

      // Shared Context Handlers
      case 'get_shared_context': {
        const { project_id, category, key } = args as {
          project_id?: string;
          category?: ContextCategory;
          key?: string;
        };

        // Use provided project_id, or fall back to currentProjectId, or default project
        const resolvedProjectId = project_id || currentProjectId || KIRAHUB_PROJECT_ID;
        if (!resolvedProjectId) {
          return {
            content: [
              {
                type: 'text',
                text: 'No project context available. Either provide project_id or claim a task first.',
              },
            ],
            isError: true,
          };
        }

        try {
          if (category && key) {
            // Get specific item
            const item = await activityClient.getContextItem(
              resolvedProjectId,
              category,
              key
            );
            if (!item) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Context item not found: ${category}/${key}`,
                  },
                ],
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: `Context: ${category}/${key}\n\n${JSON.stringify(item.value, null, 2)}`,
                },
              ],
            };
          }

          // Get all context
          const context = await activityClient.getContext(resolvedProjectId);

          const lines: string[] = ['Project Shared Context:'];

          for (const cat of ['contracts', 'utilities', 'decisions', 'config'] as ContextCategory[]) {
            const items = context[cat] || {};
            const keys = Object.keys(items);
            if (keys.length > 0) {
              lines.push(`\n## ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
              for (const k of keys) {
                lines.push(`  - ${k}`);
              }
            }
          }

          if (lines.length === 1) {
            lines.push('\n(No context items found)');
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to get context: ${error.message || error}`,
              },
            ],
            isError: true,
          };
        }
      }

      case 'set_shared_context': {
        const { project_id, category, key, value } = args as {
          project_id?: string;
          category: ContextCategory;
          key: string;
          value: Record<string, any>;
        };

        // Use provided project_id, or fall back to currentProjectId, or default project
        const resolvedProjectId = project_id || currentProjectId || KIRAHUB_PROJECT_ID;
        if (!resolvedProjectId) {
          return {
            content: [
              {
                type: 'text',
                text: 'No project context available. Either provide project_id or claim a task first.',
              },
            ],
            isError: true,
          };
        }

        try {
          const result = await activityClient.setContext({
            projectId: resolvedProjectId,
            category,
            key,
            value,
            taskId: currentTaskId || undefined,
          });

          return {
            content: [
              {
                type: 'text',
                text: `Context ${result.created ? 'created' : 'updated'}: ${category}/${key}`,
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to set context: ${error.message || error}`,
              },
            ],
            isError: true,
          };
        }
      }

      case 'delete_shared_context': {
        const { project_id, category, key } = args as {
          project_id?: string;
          category: ContextCategory;
          key: string;
        };

        // Use provided project_id, or fall back to currentProjectId, or default project
        const resolvedProjectId = project_id || currentProjectId || KIRAHUB_PROJECT_ID;
        if (!resolvedProjectId) {
          return {
            content: [
              {
                type: 'text',
                text: 'No project context available. Either provide project_id or claim a task first.',
              },
            ],
            isError: true,
          };
        }

        try {
          const deleted = await activityClient.deleteContext(
            resolvedProjectId,
            category,
            key
          );

          return {
            content: [
              {
                type: 'text',
                text: deleted
                  ? `Context deleted: ${category}/${key}`
                  : `Context item not found: ${category}/${key}`,
              },
            ],
          };
        } catch (error: any) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to delete context: ${error.message || error}`,
              },
            ],
            isError: true,
          };
        }
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

        const effectiveProjectId = (args as any)?.project_id || KIRAHUB_PROJECT_ID;
        if (!effectiveProjectId) {
          return {
            content: [{ type: 'text', text: 'project_id is required. Provide it explicitly or set KIRAHUB_PROJECT_ID.' }],
            isError: true,
          };
        }
        const plan = await planEditorClient.getProjectPlan(effectiveProjectId);
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
            `PlanCreator API: ${planEditorBaseUrl}/plan/${encodeURIComponent(effectiveProjectId)}`
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

        const effectiveProjectId = (args as any)?.project_id || KIRAHUB_PROJECT_ID;
        if (!effectiveProjectId) {
          return {
            content: [{ type: 'text', text: 'project_id is required. Provide it explicitly or set KIRAHUB_PROJECT_ID.' }],
            isError: true,
          };
        }
        const plan = await planEditorClient.getProjectPlan(effectiveProjectId);
        const tasks = plan.tasks || [];

        if (!tasks.length) {
          return {
            content: [
              {
                type: 'text',
                text: `No plan tasks found for project ${effectiveProjectId}.`,
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
              text: [`Tasks for project ${effectiveProjectId}:`, ...formattedTasks].join('\n'),
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

        const { task_id } = args as { task_id: string };
        const effectiveProjectId = (args as any)?.project_id || KIRAHUB_PROJECT_ID;
        if (!effectiveProjectId) {
          return {
            content: [{ type: 'text', text: 'project_id is required. Provide it explicitly or set KIRAHUB_PROJECT_ID.' }],
            isError: true,
          };
        }

        const task = await planEditorClient.getTaskDetails(effectiveProjectId, task_id);

        if (!task) {
          return {
            content: [
              {
                type: 'text',
                text: `Task '${task_id}' not found in project ${effectiveProjectId}. Try 'list_plan_tasks' to view available tasks.`,
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

        const { query } = args as { query: string };
        const effectiveProjectId = (args as any)?.project_id || KIRAHUB_PROJECT_ID;
        if (!effectiveProjectId) {
          return {
            content: [{ type: 'text', text: 'project_id is required. Provide it explicitly or set KIRAHUB_PROJECT_ID.' }],
            isError: true,
          };
        }

        const results = await planEditorClient.searchTasks(effectiveProjectId, query);

        if (!results.length) {
          return {
            content: [
              {
                type: 'text',
                text: `No plan tasks matched '${query}' in project ${effectiveProjectId}.`,
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
              text: [`Search results for '${query}' in project ${effectiveProjectId}:`, ...formattedResults].join('\n'),
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

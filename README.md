# KiraHub MCP Server

Model Context Protocol (MCP) server for integrating KiraHub with Claude Code and other MCP-compatible clients.

## Features

This MCP server provides comprehensive access to KiraHub's task management capabilities through standardized tool calls:

### Task Management
- **get_next_task** - Get the next task from the queue
- **claim_task** - Claim a task to work on
- **complete_task** - Mark task complete with automatic validation Q&A
- **create_task** - Create new tasks
- **update_task** - Update task details
- **get_task_details** - Get full task information

### Epic Management
- **list_epics** - List project epics
- **get_epic** - Get epic details with tasks
- **create_epic** - Create new epics
- **update_epic** - Update epic details

### Working Notes
- **add_working_note** - Add todo/bug/edge_case/optimization notes
- **resolve_working_note** - Mark notes as resolved
- **escalate_working_note** - Escalate note to a new task
- **get_task_notes** - Get all notes for a task

### Project Knowledge
- **get_project_knowledge** - Search project knowledge base
- **add_project_knowledge** - Add knowledge entries

### Plan Wiki Integration (PlanCreator)
- **get_plan_overview** - Get project plan overview with epics and statistics
- **list_plan_tasks** - List all tasks in the project plan
- **get_plan_task_details** - Get detailed task documentation from plan wiki
- **search_plan_tasks** - Search for tasks in the plan wiki

## Automatic Validation Conversations

The `complete_task` tool handles multi-turn validation automatically:

1. **Complete Task**: Call `complete_task` with task_id
2. **Validation Question**: If KiraHub needs validation, the response contains a question
3. **Answer Question**: Call `complete_task` again with the answer in the `message` parameter
4. **Repeat**: Continue answering questions until validation completes
5. **Result**: Final response shows validation result (passed/failed) with score

### Example Validation Flow

```
# Step 1: Complete task
complete_task(task_id="AUTH-5")
→ Response: "Task completion noted. I have a few questions...
   **Validation Question 1** (architecture):
   Which OAuth 2.0 flow(s) did you implement and why?
   **To answer this question, call complete_task again with the answer in the message parameter.**"

# Step 2: Answer question
complete_task(message="I implemented OAuth 2.0 Authorization Code flow with PKCE...")
→ Response: "Answer recorded. Next question:
   **Validation Question 2** (best_practice):
   How did you implement token refresh and rotation?
   **To answer this question, call complete_task again with the answer in the message parameter.**"

# Step 3: Answer next question
complete_task(message="Refresh token rotation is implemented with a 7-day rotation window...")
→ Response: "Validation complete! ✅ All questions answered satisfactorily
   **Validation PASSED** - Score: 85%"
```

## Installation

The KiraHub MCP server is available as an npm package and can be used directly with `npx`:

```bash
# No installation needed! Use with npx:
npx -y @pendingspark/kirahub-mcp@latest

# Or install globally:
npm install -g @pendingspark/kirahub-mcp

# Or install locally for development:
git clone https://github.com/PendingSpark/kirahub-mcp.git
cd kirahub-mcp
npm install
npm run build
```

## Getting Your API Key

### Option 1: Using the Dashboard (Recommended)

1. **Start KiraHub:**
   ```bash
   cd kirahub
   make up
   ```

2. **Open the Dashboard:**
   Navigate to http://localhost and login with:
   - Email: `demo@kirahub.com`
   - Password: `demo123`

3. **Create API Key:**
   - Go to **Settings** → **API Keys**
   - Click **Generate New Key**
   - Fill in the form:
     - **Key Name**: `Claude Code Agent`
     - **Agent ID**: `claude-code-mcp`
     - **Project Assignment**: Select a project or leave as "All Projects"
     - **Capabilities**: Select all capabilities (or customize as needed)
   - Click **Generate Key**
   - **Copy the API key** (you won't see it again!)

4. **Update your MCP configuration** with the generated API key (see Usage section below)

## Usage with Claude Code

### Complete Setup Guide

Follow these steps to integrate KiraHub with Claude Code:

#### Step 1: Get Your API Key

Use the Dashboard (Option 1 above) to create an API key.

#### Step 2: Configure Claude Code

1. **Find your Claude Code config directory:**
   - macOS: `~/Library/Application Support/Claude/`
   - Linux: `~/.config/Claude/`
   - Windows: `%APPDATA%\Claude\`

2. **Create or edit `.mcp.json` in your project root** (recommended) or in the Claude config directory:

   ```json
   {
     "mcpServers": {
       "kirahub": {
         "command": "npx",
         "args": [
           "-y",
           "@pendingspark/kirahub-mcp@latest"
         ],
         "env": {
           "KIRAHUB_API_URL": "http://localhost",
           "KIRAHUB_API_KEY": "kh_live_your-api-key-here"
         }
       }
     }
   }
   ```

   **Important:**
   - Replace `kh_live_your-api-key-here` with the API key you generated
   - The API key starts with `kh_live_`
   - The `@latest` tag ensures you always get the newest version

3. **Restart Claude Code** to load the MCP server

#### Step 3: Verify Setup

In Claude Code, try:
```
"Get my next task"
```

If successful, Claude will use the `get_next_task` tool and show you a task from your assigned project!

### Configuration Options

#### Option A: Project-Root Config (Recommended)
Place `.mcp.json` in your project root. This keeps MCP config with your project.

#### Option B: Global Config
Place `.mcp.json` in Claude's config directory. This makes the MCP server available in all projects.

#### Option C: Using Specific Version

For production or to pin to a specific version:

```json
{
  "mcpServers": {
    "kirahub": {
      "command": "npx",
      "args": [
        "-y",
        "@pendingspark/kirahub-mcp@0.1.0"
      ],
      "env": {
        "KIRAHUB_API_URL": "http://localhost",
        "KIRAHUB_API_KEY": "kh_live_your-api-key-here"
      }
    }
  }
}
```

## Plan Wiki Integration Setup

The Plan Wiki integration allows agents to access detailed task documentation from PlanCreator while managing tasks in KiraHub. This provides rich context and instructions for each task.

### Prerequisites

1. **PlanCreator must be running** alongside KiraHub
2. **Project-scoped API key** is required for agents to access plan documentation

### Step-by-Step Setup

#### Step 1: Verify PlanCreator is Running

```bash
# Check if PlanCreator is accessible
curl http://localhost/api/wiki/health

# Should return: {"status":"ok"}
```

#### Step 2: Add Plan Wiki URL to MCP Configuration

Update your `.mcp.json` to include the `PLAN_EDITOR_API_URL` environment variable:

```json
{
  "mcpServers": {
    "kirahub": {
      "command": "npx",
      "args": [
        "-y",
        "@pendingspark/kirahub-mcp@latest"
      ],
      "env": {
        "KIRAHUB_API_URL": "http://localhost",
        "KIRAHUB_API_KEY": "kh_live_your-api-key-here",
        "PLAN_EDITOR_API_URL": "http://localhost/api/wiki"
      }
    }
  }
}
```

**Important:** The `PLAN_EDITOR_API_URL` should point to the wiki API endpoint, typically `http://localhost/api/wiki`.

#### Step 3: Create a Project-Scoped API Key

Plan Wiki integration requires a **project-scoped API key** so agents can access the plan documentation for their assigned project.

**Option A: Using the Dashboard**

1. Navigate to http://localhost and login
2. Go to **Settings** → **API Keys**
3. Click **Generate New Key**
4. Fill in the form:
   - **Key Name**: `claude-code-project-beta` (or your project name)
   - **Agent ID**: `claude-code-mcp`
   - **Project Assignment**: **Select a specific project** (e.g., "Project Beta")
   - **Capabilities**: Select all or customize as needed
5. Click **Generate Key**
6. **Copy the API key** immediately (format: `kh_live_...`)

**Option B: Using the API**

```bash
#!/bin/bash
# Get JWT token
TOKEN=$(curl -s -X POST http://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@kirahub.com","password":"demo123"}' | jq -r '.token')

# Get project UUID (replace "project-beta" with your project slug)
PROJECT_ID=$(curl -s -X GET http://localhost/api/projects \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[] | select(.slug == "project-beta") | .id')

# Create API key
curl -s -X POST http://localhost/api/agent-api-keys \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"keyName\": \"claude-code-project-beta\",
    \"agentId\": \"claude-code-mcp\",
    \"projectId\": \"$PROJECT_ID\",
    \"capabilities\": []
  }" | jq '.'
```

#### Step 4: Update MCP Configuration with New API Key

Replace the API key in your `.mcp.json` with the newly created project-scoped key:

```json
{
  "mcpServers": {
    "kirahub": {
      "command": "npx",
      "args": [
        "-y",
        "@pendingspark/kirahub-mcp@latest"
      ],
      "env": {
        "KIRAHUB_API_URL": "http://localhost",
        "KIRAHUB_API_KEY": "kh_live_ee805f5304771831c9d10db36733803e6ec8f6a243c0fc0eb8859cc8c70d0419",
        "PLAN_EDITOR_API_URL": "http://localhost/api/wiki"
      }
    }
  }
}
```

#### Step 5: Restart Claude Code

After updating the configuration, restart Claude Code to load the new settings.

#### Step 6: Test Plan Wiki Integration

Test the integration with natural language commands:

```
You: "Get my next task and show me the detailed plan documentation"

Claude will:
1. Call get_next_task to fetch a task from KiraHub
2. Automatically call get_plan_task_details to fetch detailed instructions from Plan Wiki
3. Present both the task summary and detailed documentation
```

### Plan Wiki Workflow Example

Here's a typical workflow using Plan Wiki integration:

```
You: "Get the next task"
Claude: [Calls get_next_task]
        "Task AUTH-5: Implement OAuth Authentication
         Description: Set up OAuth 2.0 authentication flow
         Wiki: http://localhost/wiki?project=project-beta&task=auth-oauth"

You: "Show me the detailed plan for this task"
Claude: [Calls get_plan_task_details with task description]
        "# OAuth Authentication Implementation

         ## Overview
         Implement OAuth 2.0 authorization code flow with PKCE...

         ## Technical Requirements
         - Support for multiple OAuth providers (Google, GitHub)
         - PKCE for mobile apps
         - Refresh token rotation

         ## Implementation Steps
         1. Create OAuth provider configuration
         2. Implement authorization endpoint
         3. Implement token exchange
         ..."

You: "What other tasks are in the plan related to auth?"
Claude: [Calls search_plan_tasks with query="auth"]
        "Found 3 related tasks:
         1. AUTH-5: OAuth Authentication
         2. AUTH-6: Session Management
         3. AUTH-7: API Key Validation"
```

### Plan Wiki Tools Reference

#### get_plan_overview
Get high-level overview of the project plan including epics and statistics.

**Parameters:**
- `project_id` (optional): Project ID (defaults to agent's assigned project)

**Returns:**
- Project name, description, version
- List of epics with descriptions
- Total task count
- Project overview markdown

**Example:**
```typescript
get_plan_overview({ project_id: "89bc9621-ac3a-4b0f-b69f-9de10358de2c" })
```

#### list_plan_tasks
List all tasks in the project plan with metadata.

**Parameters:**
- `project_id` (required): Project ID

**Returns:**
- Array of task summaries with id, title, description, tags, dependencies

**Example:**
```typescript
list_plan_tasks({ project_id: "89bc9621-ac3a-4b0f-b69f-9de10358de2c" })
```

#### get_plan_task_details
Get full detailed documentation for a specific plan task.

**Parameters:**
- `task_id` (required): Task ID or title from the plan

**Returns:**
- Complete task documentation in markdown
- Task metadata (type, tags, dependencies)
- Epic information if task belongs to an epic
- Project overview excerpt

**Example:**
```typescript
// Automatically extracts wiki URL from KiraHub task description
get_plan_task_details({ task_id: "AUTH-5" })

// Or directly with plan task ID
get_plan_task_details({ task_id: "implement-oauth" })
```

**Note:** This tool can extract plan information from KiraHub task descriptions that contain wiki URLs in the format: `http://localhost/wiki?project={project_id}&task={task_id}`

#### search_plan_tasks
Search for tasks in the plan wiki by keyword.

**Parameters:**
- `query` (required): Search string
- `project_id` (optional): Project ID (defaults to agent's assigned project)

**Returns:**
- Array of matching tasks (up to 10 results)
- Each result includes id, title, description, tags, file name

**Example:**
```typescript
search_plan_tasks({
  query: "authentication",
  project_id: "89bc9621-ac3a-4b0f-b69f-9de10358de2c"
})
```

### Troubleshooting Plan Wiki Integration

#### "Plan Editor integration is not enabled"
**Cause:** `PLAN_EDITOR_API_URL` is not set or is set to "disabled"/"none"

**Fix:**
```json
"env": {
  "PLAN_EDITOR_API_URL": "http://localhost/api/wiki"
}
```

#### "Unable to verify project access" (401)
**Cause:** API key is not being passed to PlanCreator, or PlanCreator cannot verify it with KiraHub

**Fix:**
1. Ensure your API key is valid: `curl http://localhost/api/agents/verify -H "x-api-key: kh_live_..."`
2. Check KiraHub logs for agent verification errors
3. Verify PlanCreator can reach KiraHub API

#### "Unable to verify project access" (403)
**Cause:** Your API key is assigned to a different project than the one you're trying to access

**Fix:**
1. Check your API key's project assignment:
   - Dashboard → Settings → API Keys → Check "Project" column
2. Either:
   - Create a new API key for the correct project
   - Create an "All Projects" API key (less secure but more flexible)

#### "No wiki link found in task description"
**Cause:** KiraHub task doesn't have a wiki URL in its description

**Fix:**
- Ensure tasks are created with wiki URLs in format: `http://localhost/wiki?project={project_id}&task={task_id}`
- Or use `list_plan_tasks` and `get_plan_task_details` with explicit task IDs instead

#### PlanCreator not responding
**Check if PlanCreator is running:**
```bash
# Test health endpoint
curl http://localhost/api/wiki/health

# Check Kubernetes pods
kubectl get pods | grep plancreator
```

#### API key works for KiraHub but not PlanCreator
**Cause:** PlanCreator verifies agents by calling KiraHub's `/api/agents/verify` endpoint. Network connectivity or API key format may be wrong.

**Debug:**
```bash
# Test agent verification endpoint
curl -s http://localhost/api/agents/verify \
  -H "x-api-key: kh_live_your-key-here" | jq '.'

# Should return agent details including projectId
```

## Example Usage in Claude Code

Once configured, you can use natural language commands with Claude Code:

```
You: "Get my next task and start working on it"
Claude: [Calls get_next_task and claim_task tools]
        "I've claimed task AUTH-5: Implement OAuth authentication.
         This task requires implementing OAuth 2.0 with PKCE..."

You: "Mark this task as complete"
Claude: [Calls complete_task tool]
        "KiraHub is asking validation questions.
         Question 1 (architecture): Which OAuth 2.0 flow(s) did you implement?"

You: "I implemented Authorization Code flow with PKCE"
Claude: [Calls complete_task with your answer]
        "Question 2 (best_practice): How did you implement token refresh?"

You: "Using refresh token rotation with 7-day window"
Claude: [Calls complete_task with your answer]
        "Validation passed! ✅ Score: 85%
         The task has been marked as completed."
```

## Tool Reference

### Task Management Tools

#### get_next_task
Get the next task from the queue based on priority and dependencies.

**Parameters:**
- `project_id` (optional): Filter tasks by project

**Example:**
```typescript
get_next_task({ project_id: "proj-123" })
```

#### claim_task
Claim a task to work on it.

**Parameters:**
- `task_id` (required): ID of the task to claim

**Example:**
```typescript
claim_task({ task_id: "AUTH-5" })
```

#### complete_task
Mark a task as completed. Handles automatic validation Q&A.

**Parameters:**
- `task_id` (optional): ID of the task to complete
- `message` (optional): Answer to validation question

**Examples:**
```typescript
// Initial completion
complete_task({ task_id: "AUTH-5" })

// Answer validation question
complete_task({ message: "I implemented OAuth 2.0 with PKCE..." })
```

#### create_task
Create a new task.

**Parameters:**
- `title` (required): Task title
- `description` (optional): Task description
- `project_id` (optional): Project ID
- `epic_id` (optional): Epic ID
- `tags` (optional): Array of tags

**Example:**
```typescript
create_task({
  title: "Implement login page",
  description: "Create login UI with OAuth",
  project_id: "proj-123",
  tags: ["frontend", "auth"]
})
```

#### update_task
Update task details.

**Parameters:**
- `task_id` (required): Task ID
- `title` (optional): New title
- `description` (optional): New description
- `status` (optional): New status (new/in-progress/blocked/completed)
- `tags` (optional): New tags

**Example:**
```typescript
update_task({
  task_id: "AUTH-5",
  status: "in-progress",
  tags: ["backend", "auth", "oauth"]
})
```

#### get_task_details
Get detailed information about a task.

**Parameters:**
- `task_id` (required): Task ID

**Example:**
```typescript
get_task_details({ task_id: "AUTH-5" })
```

### Epic Management Tools

#### list_epics
List all epics for a project.

**Parameters:**
- `project_id` (required): Project ID

**Example:**
```typescript
list_epics({ project_id: "proj-123" })
```

#### get_epic
Get epic details with all tasks.

**Parameters:**
- `epic_id` (required): Epic ID

**Example:**
```typescript
get_epic({ epic_id: "PROJ-1" })
```

#### create_epic
Create a new epic.

**Parameters:**
- `project_id` (required): Project ID
- `name` (required): Epic name
- `description` (optional): Epic description

**Example:**
```typescript
create_epic({
  project_id: "proj-123",
  name: "Authentication System",
  description: "Complete OAuth 2.0 implementation"
})
```

#### update_epic
Update epic details.

**Parameters:**
- `epic_id` (required): Epic ID
- `name` (optional): New name
- `description` (optional): New description
- `status` (optional): New status (active/archived)

**Example:**
```typescript
update_epic({
  epic_id: "PROJ-1",
  status: "archived"
})
```

### Working Notes Tools

#### add_working_note
Add a working note to a task.

**Parameters:**
- `task_id` (required): Task ID
- `note` (required): Note content
- `type` (required): Note type (todo/bug/edge_case/optimization)
- `priority` (required): Priority (must_fix/should_fix/nice_to_have)

**Example:**
```typescript
add_working_note({
  task_id: "AUTH-5",
  note: "Need to handle token expiry edge case",
  type: "edge_case",
  priority: "must_fix"
})
```

#### resolve_working_note
Mark a working note as resolved.

**Parameters:**
- `task_id` (required): Task ID
- `note_id` (required): Note ID

**Example:**
```typescript
resolve_working_note({
  task_id: "AUTH-5",
  note_id: "note-123"
})
```

#### escalate_working_note
Escalate a working note to a new task.

**Parameters:**
- `task_id` (required): Current task ID
- `note_id` (required): Note ID to escalate
- `epic_id` (optional): Epic ID for the new task

**Example:**
```typescript
escalate_working_note({
  task_id: "AUTH-5",
  note_id: "note-123",
  epic_id: "PROJ-1"
})
```

#### get_task_notes
Get all working notes for a task.

**Parameters:**
- `task_id` (required): Task ID

**Example:**
```typescript
get_task_notes({ task_id: "AUTH-5" })
```

### Project Knowledge Tools

#### get_project_knowledge
Search project knowledge base.

**Parameters:**
- `project_id` (required): Project ID
- `search` (optional): Search query
- `type` (optional): Knowledge type filter

**Example:**
```typescript
get_project_knowledge({
  project_id: "proj-123",
  search: "OAuth authentication",
  type: "architecture"
})
```

#### add_project_knowledge
Add a new knowledge entry.

**Parameters:**
- `project_id` (required): Project ID
- `knowledge_type` (required): Type (architecture/best_practice/spec/etc.)
- `title` (required): Knowledge title
- `content` (required): Knowledge content
- `tags` (optional): Array of tags

**Example:**
```typescript
add_project_knowledge({
  project_id: "proj-123",
  knowledge_type: "best_practice",
  title: "OAuth Token Storage",
  content: "Store tokens in httpOnly cookies with SameSite=Strict...",
  tags: ["auth", "security"]
})
```

## Development

### Build
```bash
npm run build
```

### Watch Mode
```bash
npm run dev
```

### Test Locally

**Option 1: Using npx (Quick Test)**
```bash
# Make sure KiraHub is running
KIRAHUB_API_URL=http://localhost \
KIRAHUB_API_KEY=your-api-key \
npx -y @pendingspark/kirahub-mcp@latest
```

**Option 2: Local Development**
```bash
# Clone and build from source
git clone https://github.com/PendingSpark/kirahub-mcp.git
cd kirahub-mcp
npm install
npm run build

# Test the local build
KIRAHUB_API_URL=http://localhost \
KIRAHUB_API_KEY=your-api-key \
node dist/index.js
```

## Troubleshooting

### "Error: KIRAHUB_API_KEY environment variable is required"
Set the `KIRAHUB_API_KEY` in your `.env` file or MCP configuration.

### Connection errors
- Verify KiraHub is running: `curl http://localhost:3000/api/health`
- Check `KIRAHUB_API_URL` is correct
- Verify API key is valid

### "No available tasks found"
- **Check project assignment:** Your API key may be assigned to a specific project
  - Go to Dashboard → Settings → API Keys
  - Check the "Project" column for your agent
  - If assigned to a project, you'll only see tasks from that project
- **Create tasks in the assigned project:**
  - Use `create_task` or create tasks via the dashboard
  - Make sure they're in the same project as your agent
- **Change project assignment:**
  - Delete the current API key
  - Create a new one with "All Projects" or a different project

### Validation questions not appearing
- Ensure the task has relevant tags
- Check that project has knowledge base entries with matching tags
- Verify knowledge base is populated: `get_project_knowledge(project_id="...")`

### Agent gets tasks from wrong project
- Check your API key's project assignment in the dashboard
- Update the API key or create a new one with the correct project
- Remember: If `projectId` is set, the agent ONLY sees tasks from that project

## Architecture

The MCP server consists of:

1. **index.ts** - Main MCP server with tool handlers
2. **a2a-client.ts** - A2A protocol client wrapper
3. **MCP SDK** - Handles stdio communication with Claude Code

The server translates MCP tool calls into A2A protocol messages, sends them to KiraHub, and returns the responses in a format Claude Code understands.

## Related Documentation

- [KiraHub Main Repository](https://github.com/PendingSpark/kirahub)
- [A2A Protocol Documentation](https://github.com/PendingSpark/kirahub/blob/main/docs/A2A_VALIDATION_CONVERSATION.md)
- [Agent Integration Guide](https://github.com/PendingSpark/kirahub/blob/main/docs/AGENT_INTEGRATION.md)

## License

MIT

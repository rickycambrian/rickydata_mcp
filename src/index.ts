import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { verifyWalletToken, WALLET_TOKEN_PREFIX } from "./wallet-token.js";
import { MarketplaceManager, MARKETPLACE_TOOLS } from "./marketplace.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const RESPONSE_MAX_LENGTH = parseInt(process.env.RESPONSE_MAX_LENGTH || "200000", 10);
const CANVAS_API_URL = process.env.CANVAS_API_URL || "https://agents.rickydata.org";
const AGENT_GATEWAY_URL = process.env.AGENT_GATEWAY_URL || "https://agents.rickydata.org";

// ============================================================================
// NODE TYPE CATALOG (static reference for canvas_get_available_tools)
// ============================================================================

const NODE_TYPE_CATALOG = [
  { type: "text-input", name: "Text Input", category: "inputs", description: "Provides text input to the workflow. Used as the starting point for user prompts or static text.", configFields: ["label", "value", "placeholder"] },
  { type: "agent", name: "Agent", category: "agents", description: "An AI agent node that processes input using a configurable model and prompt. Can use MCP tools.", configFields: ["label", "sourceType", "sourceAgentId", "model", "prompt", "maxTurns", "allowedTools", "allowedServers"] },
  { type: "mcp-tool", name: "MCP Tool", category: "tools", description: "Calls a specific MCP tool from an enabled marketplace server with configured parameters.", configFields: ["label", "toolName", "serverName", "serverId", "parameters", "inputSchema"] },
  { type: "results", name: "Results", category: "output", description: "Displays the final output of the workflow. Collects results from upstream nodes.", configFields: ["label"] },
  { type: "agent-team-orchestrator", name: "Agent Team Orchestrator", category: "agents", description: "Orchestrates a team of agent teammates. Coordinates multi-agent workflows with a shared objective.", configFields: ["label", "teamName", "prompt", "model", "executionMode", "continueEnabled", "allowedServers"] },
  { type: "agent-team-teammate", name: "Agent Team Teammate", category: "agents", description: "A teammate agent within an orchestrated team. Has a specific role and capabilities.", configFields: ["label", "teammateName", "sourceType", "sourceAgentId", "rolePrompt", "model", "allowedServers"] },
  { type: "approval-gate", name: "Approval Gate", category: "control", description: "Pauses workflow execution until human approval is granted or rejected.", configFields: ["label", "message"] },
  { type: "github-repo", name: "GitHub Repository", category: "github", description: "Connects to a GitHub repository. Provides repo context for downstream GitHub nodes.", configFields: ["label", "owner", "repo", "branch", "installationId"] },
  { type: "github-create-branch", name: "GitHub Create Branch", category: "github", description: "Creates a new branch in the connected GitHub repository.", configFields: ["label", "branchName", "baseBranch"] },
  { type: "github-create-issue", name: "GitHub Create Issue", category: "github", description: "Creates an issue in the connected GitHub repository.", configFields: ["label", "title", "body", "labels", "assignees"] },
  { type: "github-commit-files", name: "GitHub Commit Files", category: "github", description: "Commits files to a branch in the connected GitHub repository.", configFields: ["label", "branch", "message", "filesJson", "consumeUpstream"] },
  { type: "github-open-draft-pr", name: "GitHub Open Draft PR", category: "github", description: "Opens a draft pull request in the connected GitHub repository.", configFields: ["label", "head", "base", "title", "body", "consumeUpstream"] },
  { type: "github-mark-pr-ready", name: "GitHub Mark PR Ready", category: "github", description: "Marks a draft pull request as ready for review.", configFields: ["label", "prNumber", "ciPolicy"] },
  { type: "browser-verify", name: "Browser Verify", category: "browser", description: "Runs browser-based verification steps and assertions against a URL.", configFields: ["label", "serverId", "sessionConfigJson", "stepsJson", "assertionsJson", "timeoutMs"] },
];

// ============================================================================
// CANVAS AI SYSTEM PROMPT
// ============================================================================

const CANVAS_AI_SYSTEM_PROMPT = `You are a canvas workflow assistant. You help users build and modify visual workflows.

Available node types:
${NODE_TYPE_CATALOG.map(n => `- ${n.type} (${n.category}): ${n.description}`).join("\n")}

When the user asks to create or modify a workflow, respond with a JSON action block inside <action> tags.

Action formats:

1. Create a new workflow:
<action>
{"action": "create_workflow", "message": "Description of what was created", "data": {"name": "workflow name", "description": "workflow description", "nodes": [{"id": "node_1", "type": "text-input", "position": {"x": 0, "y": 0}, "data": {"label": "Input", "value": ""}}], "connections": [{"source": "node_1", "target": "node_2"}]}}
</action>

2. Add a node to an existing workflow:
<action>
{"action": "add_node", "message": "Added an agent node", "data": {"node": {"id": "node_3", "type": "agent", "position": {"x": 300, "y": 0}, "data": {"label": "My Agent", "model": "claude-sonnet-4-6"}}, "connections": [{"source": "node_2", "target": "node_3"}]}}
</action>

3. Connect two nodes:
<action>
{"action": "connect", "message": "Connected nodes", "data": {"connections": [{"source": "node_1", "target": "node_2"}]}}
</action>

4. Update a node's configuration:
<action>
{"action": "update_node", "message": "Updated node prompt", "data": {"node_id": "node_2", "updates": {"prompt": "Analyze the input text"}}}
</action>

Always include a human-readable "message" explaining what you did. Position nodes with reasonable spacing (200-300px apart).`;

// ============================================================================
// HELPERS
// ============================================================================

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function truncateResponse(data: any): any {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  if (text.length <= RESPONSE_MAX_LENGTH) return data;
  // For large responses, return as truncated string to avoid broken JSON
  return text.slice(0, RESPONSE_MAX_LENGTH) + `\n... [truncated at ${RESPONSE_MAX_LENGTH} chars of ${text.length} total]`;
}

// Model shorthand → full ID mapping (canvas runtime requires full IDs)
const MODEL_NAME_MAP: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-6",
};

function normalizeModelName(name: string): string {
  return MODEL_NAME_MAP[name?.toLowerCase()] || name;
}

/** Normalize model names in workflow nodes before execution. */
function normalizeWorkflowNodes(nodes: any[]): any[] {
  return nodes.map(n => {
    if (n.data?.model) {
      return { ...n, data: { ...n.data, model: normalizeModelName(n.data.model) } };
    }
    return n;
  });
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const CANVAS_TOOLS = [
  {
    name: "canvas_execute_workflow",
    description: "Execute a canvas workflow synchronously. Pass nodes and connections, get results back.",
    inputSchema: {
      type: "object",
      properties: {
        nodes: { type: "array", description: "Array of workflow nodes" },
        connections: { type: "array", description: "Array of connections" },
        userPrompt: { type: "string", description: "Optional user input for text-input nodes" }
      },
      required: ["nodes", "connections"]
    }
  },
  {
    name: "canvas_execute_workflow_async",
    description: "Start a workflow asynchronously. Returns run_id for polling with canvas_get_workflow_run.",
    inputSchema: {
      type: "object",
      properties: {
        nodes: { type: "array", description: "Array of workflow nodes" },
        connections: { type: "array", description: "Array of connections" },
        userPrompt: { type: "string", description: "Optional user input" },
        workflowId: { type: "string", description: "Optional workflow ID if running a saved workflow" }
      },
      required: ["nodes", "connections"]
    }
  },
  {
    name: "canvas_get_workflow_run",
    description: "Get status and results of an async workflow run.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Run ID from canvas_execute_workflow_async" }
      },
      required: ["runId"]
    }
  },
  {
    name: "canvas_list_workflow_runs",
    description: "List recent workflow runs. Filter by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: running, completed, failed" },
        limit: { type: "number", description: "Max results (default: 20)" }
      }
    }
  },
  {
    name: "canvas_save_workflow",
    description: "Save a canvas workflow definition.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Workflow name" },
        description: { type: "string", description: "Workflow description" },
        nodes: { type: "array", description: "Array of workflow nodes" },
        connections: { type: "array", description: "Array of connections" }
      },
      required: ["name", "nodes", "connections"]
    }
  },
  {
    name: "canvas_get_workflows",
    description: "Get saved canvas workflows. Use to find existing workflows to run or modify.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search in name/description" },
        limit: { type: "number", description: "Max results (default: 20)" }
      }
    }
  },
  {
    name: "run_saved_canvas_workflow",
    description: "Run a saved workflow by ID or name. Returns run_id for polling.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow UUID" },
        workflow_name: { type: "string", description: "Workflow name to search for" },
        user_prompt: { type: "string", description: "Optional context/input" }
      }
    }
  },
  {
    name: "run_workflow_and_wait",
    description: "Run a workflow and wait for completion. Best for autonomous agents.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow UUID" },
        workflow_name: { type: "string", description: "Workflow name to search for" },
        user_prompt: { type: "string", description: "Optional context/input" },
        max_wait_seconds: { type: "number", description: "Max wait time (default: 300, max: 600)" },
        poll_interval_seconds: { type: "number", description: "Poll interval (default: 5)" }
      }
    }
  },
  {
    name: "canvas_get_available_tools",
    description: "Get available canvas node types and MCP tools for building workflows. Returns a catalog of all node types (agent, text-input, mcp-tool, github nodes, etc.) and optionally enabled MCP tools.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category: inputs, agents, tools, output, control, github, browser" }
      }
    }
  },
  {
    name: "canvas_get_workflow_messages",
    description: "Get per-node messages and results from a workflow run. Shows status, results, approvals, and logs for each node.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID to get messages for" },
        node_id: { type: "string", description: "Optional: filter to a single node's data" }
      },
      required: ["run_id"]
    }
  },
  {
    name: "canvas_ai_assistant",
    description: "AI assistant for canvas workflows. Provide a natural language request and optionally the current canvas state to get structured workflow actions (create_workflow, add_node, connect, update_node).",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Natural language request (e.g., 'Create a workflow with text input and agent')" },
        canvas_state: { type: "object", description: "Optional current canvas state with nodes and connections" }
      },
      required: ["message"]
    }
  },
  {
    name: "canvas_ai_assistant_voice",
    description: "Voice variant of the canvas AI assistant. Takes a voice transcription instead of text message.",
    inputSchema: {
      type: "object",
      properties: {
        transcription: { type: "string", description: "Voice transcription text" },
        canvas_state: { type: "object", description: "Optional current canvas state with nodes and connections" }
      },
      required: ["transcription"]
    }
  },
  {
    name: "update_canvas_workflow",
    description: "Update a saved canvas workflow. Fetches the existing workflow, merges your changes, and saves as a new version (Geo storage is immutable).",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow entityId to update" },
        name: { type: "string", description: "New workflow name" },
        description: { type: "string", description: "New workflow description" },
        nodes: { type: "array", description: "Updated nodes array (replaces existing)" },
        connections: { type: "array", description: "Updated connections array (replaces existing)" }
      },
      required: ["workflow_id"]
    }
  },
  {
    name: "update_workflow_node",
    description: "Update a single node within a saved workflow. Modifies the node's data/type/position and saves as a new version.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow entityId containing the node" },
        node_id: { type: "string", description: "ID of the node to update" },
        type: { type: "string", description: "Optional new node type" },
        position: { type: "object", description: "Optional new position {x, y}" },
        data: { type: "object", description: "Data fields to merge into the node's existing data" }
      },
      required: ["workflow_id", "node_id"]
    }
  },
  {
    name: "canvas_approve_gate",
    description: "Approve or reject an approval gate in a running workflow. Use canvas_get_workflow_run to find pending approvals.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID of the workflow" },
        approval_id: { type: "string", description: "Approval ID from the run's approvals array" },
        decision: { type: "string", enum: ["approve", "reject"], description: "Whether to approve or reject" }
      },
      required: ["run_id", "approval_id", "decision"]
    }
  },
  {
    name: "canvas_cancel_workflow",
    description: "Get cancellation options for a running workflow. Shows current status and pending approvals that can be rejected to stop execution.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID of the workflow to cancel" }
      },
      required: ["run_id"]
    }
  },
];

const AGENT_TOOLS = [
  {
    name: "agent_list",
    description: "List available agents from the Agent Gateway.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max agents to return (default: 10)" }
      }
    }
  },
  {
    name: "agent_create_session",
    description: "Create a new chat session with an agent. Returns session ID for agent_chat.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID from agent_list" },
        model: { type: "string", description: "Model: 'haiku', 'sonnet', or 'opus' (default: 'haiku')" }
      },
      required: ["agent_id"]
    }
  },
  {
    name: "agent_chat",
    description: "Send a message to an agent and get the full response via SSE streaming.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        message: { type: "string", description: "Message to send" },
        session_id: { type: "string", description: "Session ID (auto-creates if omitted)" },
        model: { type: "string", description: "Model: 'haiku', 'sonnet', or 'opus'" }
      },
      required: ["agent_id", "message"]
    }
  },
  {
    name: "agent_list_sessions",
    description: "List chat sessions for an agent.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" }
      },
      required: ["agent_id"]
    }
  },
  {
    name: "agent_get_session",
    description: "Get details of a specific chat session including message history.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        session_id: { type: "string", description: "Session ID" },
        message_limit: { type: "number", description: "Max messages to return (default: 10, use 0 for all)" }
      },
      required: ["agent_id", "session_id"]
    }
  },
  {
    name: "agent_resume_session",
    description: "Resume an existing chat session by sending a new message. Unlike agent_chat, this requires an existing session_id.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        session_id: { type: "string", description: "Session ID to resume" },
        message: { type: "string", description: "Message to send" },
        model: { type: "string", description: "Model: 'haiku', 'sonnet', or 'opus'" }
      },
      required: ["agent_id", "session_id", "message"]
    }
  },
  {
    name: "agent_delete_session",
    description: "Delete a chat session.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        session_id: { type: "string", description: "Session ID to delete" }
      },
      required: ["agent_id", "session_id"]
    }
  },
];

const A2A_TOOLS = [
  {
    name: "a2a_get_agent_card",
    description: "Get the A2A agent card with capabilities, skills, and discovery info.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "a2a_send_message",
    description: "Send a message via the A2A protocol. Returns a task with status and results.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message text to send" },
        context_id: { type: "string", description: "Optional context ID for conversation continuity" },
        blocking: { type: "boolean", description: "Wait for completion (default: true)" }
      },
      required: ["message"]
    }
  },
  {
    name: "a2a_get_task",
    description: "Get status and results of an A2A task.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" }
      },
      required: ["task_id"]
    }
  },
  {
    name: "a2a_list_tasks",
    description: "List A2A tasks with optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 20)" },
        status: { type: "string", description: "Filter by status: submitted, working, completed, failed, canceled" },
        context_id: { type: "string", description: "Filter by context ID" }
      }
    }
  },
  {
    name: "a2a_cancel_task",
    description: "Cancel a running A2A task.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID to cancel" }
      },
      required: ["task_id"]
    }
  },
];

const WALLET_TOOLS = [
  {
    name: "wallet_get_balance",
    description: "Get wallet USDC and ETH balance on Base network.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "wallet_get_transactions",
    description: "Get recent wallet transactions and payment history.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (default: 5)" }
      }
    }
  },
  {
    name: "wallet_apikey_status",
    description: "Check if an Anthropic API key is configured for BYOK agents.",
    inputSchema: { type: "object", properties: {} }
  },
];

const TOOLS = [...CANVAS_TOOLS, ...AGENT_TOOLS, ...A2A_TOOLS, ...WALLET_TOOLS, ...MARKETPLACE_TOOLS];

// ============================================================================
// CANVAS TOOL HANDLERS
// ============================================================================

/** Parse an SSE response from the canvas execution endpoint into a structured result. */
function parseSSEResult(sseText: string): any {
  const events: any[] = [];
  let runId = "";
  let status = "unknown";
  let results: Record<string, any> = {};
  const logs: string[] = [];

  for (const line of sseText.split("\n")) {
    const dataStr = line.startsWith("data: ") ? line.slice(6) : line.startsWith("data:") ? line.slice(5) : null;
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      const event = JSON.parse(dataStr);
      events.push(event);
      if (event.type === "run_started") runId = event.data?.runId || runId;
      if (event.type === "node_log") logs.push(event.data?.message || "");
      if (event.type === "run_completed") {
        runId = event.data?.runId || runId;
        status = event.data?.status || "completed";
        results = event.data?.results || results;
      }
      if (event.type === "run_failed") {
        runId = event.data?.runId || runId;
        status = event.data?.status || "failed";
      }
      if (event.type === "error") status = "failed";
    } catch (e) { console.error("[sse] Dropped malformed SSE line:", dataStr?.slice(0, 200)); }
  }

  return { runId, status, results, logs, event_count: events.length };
}

async function handleCanvasTool(name: string, args: Record<string, any>, marketplace: MarketplaceManager): Promise<any> {
  const token = marketplace.getUserToken();
  if (!token) throw new Error("No auth token. Authenticate with a wallet token first.");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  };

  switch (name) {
    case "canvas_execute_workflow": {
      // Synchronous execution via SSE streaming — collect all events and return final result
      const execArgs = { ...args, nodes: normalizeWorkflowNodes(args.nodes || []), connections: args.connections || [] };
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows/execute/stream`,
        { method: "POST", headers, body: JSON.stringify(execArgs) },
        300000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const sseText = await response.text();
      return parseSSEResult(sseText);
    }

    case "canvas_execute_workflow_async": {
      // Async execution via SSE — return run ID immediately after run_started event
      const execArgs = { ...args, nodes: normalizeWorkflowNodes(args.nodes || []), connections: args.connections || [] };
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows/execute/stream`,
        { method: "POST", headers, body: JSON.stringify(execArgs) },
        300000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const sseText = await response.text();
      const result = parseSSEResult(sseText);
      return { runId: result.runId, status: result.status, message: `Workflow started. Use canvas_get_workflow_run("${result.runId}") to check status.` };
    }

    case "canvas_get_workflow_run": {
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/runs/${args.runId}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "canvas_list_workflow_runs": {
      const params = new URLSearchParams();
      if (args.status) params.append("status", args.status);
      if (args.limit) params.append("limit", String(args.limit));
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/runs?${params}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "canvas_save_workflow": {
      // Normalize model names in nodes before saving
      const saveArgs = { ...args };
      if (Array.isArray(saveArgs.nodes)) saveArgs.nodes = normalizeWorkflowNodes(saveArgs.nodes);
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
        { method: "POST", headers, body: JSON.stringify(saveArgs) },
        60000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "canvas_get_workflows": {
      const params = new URLSearchParams();
      if (args.search) params.append("search", args.search);
      const requestedLimit = args.limit || 10;
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
        { headers },
        30000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const wfData = await response.json() as any;
      let workflows = wfData.workflows || [];
      // Client-side search filtering (gateway may not support search param)
      if (args.search) {
        const q = args.search.toLowerCase();
        workflows = workflows.filter((w: any) =>
          (w.name || "").toLowerCase().includes(q) || (w.description || "").toLowerCase().includes(q)
        );
      }
      // Apply limit
      workflows = workflows.slice(0, requestedLimit);
      // Strip verbose fields for compact output
      const compact = workflows.map((w: any) => ({
        entityId: w.entityId,
        name: w.name,
        description: w.description || "",
        createdAt: w.createdAt,
        nodeCount: (() => { try { return (typeof w.nodesJson === "string" ? JSON.parse(w.nodesJson) : w.nodes || []).length; } catch { return 0; } })(),
      }));
      return { workflows: compact, count: compact.length, total: (wfData.workflows || []).length };
    }

    case "run_saved_canvas_workflow": {
      // Load saved workflow and execute via SSE
      const wfResponse = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
        { headers },
        30000
      );
      if (!wfResponse.ok) throw new Error(`Failed to load workflows: ${await wfResponse.text()}`);
      const wfData = await wfResponse.json() as any;
      const workflows = wfData.workflows || [];
      const wf = workflows.find((w: any) =>
        (args.workflow_id && (w.entityId === args.workflow_id || w.name === args.workflow_id)) ||
        (args.workflow_name && w.name === args.workflow_name)
      );
      const searchTerm = args.workflow_id || args.workflow_name || "unknown";
      if (!wf) throw new Error(`Workflow "${searchTerm}" not found`);

      let nodes: any[], edges: any[];
      try {
        nodes = typeof wf.nodesJson === "string" ? JSON.parse(wf.nodesJson) : (wf.nodes || []);
        edges = typeof wf.edgesJson === "string" ? JSON.parse(wf.edgesJson) : (wf.edges || []);
      } catch (e) {
        throw new Error("Workflow nodes/edges JSON is corrupted: " + (e as Error).message);
      }
      if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`Workflow "${searchTerm}" has no nodes`);
      const request: Record<string, any> = {
        nodes: normalizeWorkflowNodes(nodes.map((n: any) => ({ id: n.id, type: n.type, data: n.data }))),
        connections: (Array.isArray(edges) ? edges : []).map((e: any) => ({ source: e.source, target: e.target })),
        ...(args.inputs ? { inputs: args.inputs } : {})
      };

      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows/execute/stream`,
        { method: "POST", headers, body: JSON.stringify(request) },
        300000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const sseText = await response.text();
      return parseSSEResult(sseText);
    }

    case "run_workflow_and_wait": {
      // Same as run_saved_canvas_workflow — SSE blocks until completion
      const wfResponse = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
        { headers },
        30000
      );
      if (!wfResponse.ok) throw new Error(`Failed to load workflows: ${await wfResponse.text()}`);
      const wfData = await wfResponse.json() as any;
      const workflows = wfData.workflows || [];
      const wf = workflows.find((w: any) =>
        (args.workflow_id && (w.entityId === args.workflow_id || w.name === args.workflow_id)) ||
        (args.workflow_name && w.name === args.workflow_name)
      );
      const searchTerm = args.workflow_id || args.workflow_name || "unknown";
      if (!wf) throw new Error(`Workflow "${searchTerm}" not found`);

      let nodes: any[], edges: any[];
      try {
        nodes = typeof wf.nodesJson === "string" ? JSON.parse(wf.nodesJson) : (wf.nodes || []);
        edges = typeof wf.edgesJson === "string" ? JSON.parse(wf.edgesJson) : (wf.edges || []);
      } catch (e) {
        throw new Error("Workflow nodes/edges JSON is corrupted: " + (e as Error).message);
      }
      if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`Workflow "${searchTerm}" has no nodes`);
      const request: Record<string, any> = {
        nodes: normalizeWorkflowNodes(nodes.map((n: any) => ({ id: n.id, type: n.type, data: n.data }))),
        connections: (Array.isArray(edges) ? edges : []).map((e: any) => ({ source: e.source, target: e.target })),
        ...(args.inputs ? { inputs: args.inputs } : {})
      };

      const start = Date.now();
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows/execute/stream`,
        { method: "POST", headers, body: JSON.stringify(request) },
        Math.min(args.max_wait_seconds || 300, 600) * 1000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const sseText = await response.text();
      const result = parseSSEResult(sseText);
      return { ...result, elapsed_seconds: Math.round((Date.now() - start) / 1000) };
    }

    case "canvas_get_available_tools": {
      // Static catalog of node types + dynamic MCP tools from marketplace
      let catalog = [...NODE_TYPE_CATALOG];
      if (args.category) {
        catalog = catalog.filter(n => n.category === args.category);
      }

      // Append enabled MCP tools as mcp-tool entries
      const enabledResult = await marketplace.handleListEnabled();
      const mcpToolEntries: typeof NODE_TYPE_CATALOG = [];
      for (const server of enabledResult.enabled_servers || []) {
        for (const tool of server.tools || []) {
          mcpToolEntries.push({
            type: "mcp-tool",
            name: tool.name,
            category: "tools",
            description: `[${server.server_name}] ${tool.description || ""}`,
            configFields: ["toolName", "serverName", "serverId", "parameters"]
          });
        }
      }

      if (!args.category || args.category === "tools") {
        catalog = [...catalog, ...mcpToolEntries];
      }

      return { node_types: catalog, count: catalog.length, mcp_tools_count: mcpToolEntries.length };
    }

    case "canvas_get_workflow_messages": {
      // Fetch run details and transform into per-node messages
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/runs/${encodeURIComponent(args.run_id)}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const run = await response.json() as any;

      const nodeStatuses: Record<string, string> = run.nodeStatuses || {};
      const nodeResults: Record<string, any> = run.nodeResults || {};
      const approvals: any[] = run.approvals || [];
      const logs: string[] = run.logs || [];

      let messages: any[] = [];
      for (const [nodeId, status] of Object.entries(nodeStatuses)) {
        messages.push({ nodeId, status, result: nodeResults[nodeId] || null });
      }

      // Filter to single node if requested
      if (args.node_id) {
        messages = messages.filter(m => m.nodeId === args.node_id);
      }

      return {
        run_id: run.runId || args.run_id,
        status: run.status,
        messages,
        approvals: args.node_id ? approvals.filter((a: any) => a.nodeId === args.node_id) : approvals,
        logs,
        error: run.error
      };
    }

    case "canvas_ai_assistant":
    case "canvas_ai_assistant_voice": {
      // Use agent chat endpoint with a structured prompt
      const userMessage = name === "canvas_ai_assistant_voice" ? args.transcription : args.message;
      if (!userMessage) throw new Error("Message or transcription is required");

      // Find a suitable agent
      const agentsResponse = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents`,
        { headers: { "Content-Type": "application/json", ...(token ? { "Authorization": `Bearer ${token}` } : {}) } },
        15000
      );
      if (!agentsResponse.ok) throw new Error(`Failed to list agents: ${agentsResponse.status}`);
      const agentsData = await agentsResponse.json() as any;
      const agents = agentsData.agents || [];
      const agent = agents.find((a: any) => !a.requiredSecrets?.length) || agents[0];
      if (!agent) throw new Error("No agents available for AI assistant");

      // Build the prompt
      let prompt = CANVAS_AI_SYSTEM_PROMPT + "\n\n";
      if (args.canvas_state) {
        prompt += `Current canvas state:\n${JSON.stringify(args.canvas_state, null, 2)}\n\n`;
      }
      prompt += `User request: ${userMessage}`;

      // Create session and chat
      const sessionResponse = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agent.id)}/sessions`,
        { method: "POST", headers, body: JSON.stringify({ model: "sonnet" }) },
        15000
      );
      if (!sessionResponse.ok) throw new Error(`Failed to create session: ${sessionResponse.status}`);
      const sessionData = await sessionResponse.json() as any;

      const chatResponse = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agent.id)}/sessions/${encodeURIComponent(sessionData.id)}/chat`,
        { method: "POST", headers: { ...headers, "Accept": "text/event-stream" }, body: JSON.stringify({ message: prompt, model: "sonnet" }) },
        120000
      );
      if (!chatResponse.ok) throw new Error(`Chat failed: ${chatResponse.status} ${await chatResponse.text()}`);

      // Parse SSE response
      const responseText = await chatResponse.text();
      let accumulatedText = "";
      for (const line of responseText.split("\n")) {
        const dataStr = line.startsWith("data: ") ? line.slice(6) : line.startsWith("data:") ? line.slice(5) : null;
        if (!dataStr || dataStr === "[DONE]") continue;
        try {
          const event = JSON.parse(dataStr) as any;
          if (event.type === "text") {
            if (typeof event.data === "string") accumulatedText += event.data;
            else if (event.data?.text) accumulatedText += event.data.text;
          }
          if (event.type === "content_block_delta" && event.delta?.text) accumulatedText += event.delta.text;
        } catch { /* skip */ }
      }

      // Extract action from <action> tags
      const actionMatch = accumulatedText.match(/<action>\s*([\s\S]*?)\s*<\/action>/);
      let action: any = null;
      if (actionMatch) {
        try { action = JSON.parse(actionMatch[1]); } catch { /* keep null */ }
      }

      return {
        response: accumulatedText,
        action,
        agent_used: agent.id,
        message: action ? `AI suggested action: ${action.action}` : "AI responded without a structured action"
      };
    }

    case "update_canvas_workflow": {
      // Fetch → merge → save as new version (with retry for Geo propagation delay)
      const findWorkflow = async (): Promise<any> => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const wfResponse = await fetchWithTimeout(`${CANVAS_API_URL}/canvas/workflows`, { headers }, 30000);
          if (!wfResponse.ok) throw new Error(`Failed to load workflows: ${await wfResponse.text()}`);
          const wfData = await wfResponse.json() as any;
          const workflows = wfData.workflows || [];
          const wf = workflows.find((w: any) => w.entityId === args.workflow_id || w.name === args.workflow_id);
          if (wf) return wf;
          if (attempt === 0) await new Promise(r => setTimeout(r, 3000)); // wait for Geo propagation
        }
        throw new Error(`Workflow "${args.workflow_id}" not found. If recently saved, try again in a few seconds.`);
      };
      const wf = await findWorkflow();

      let existingNodes: any[], existingEdges: any[];
      try {
        existingNodes = typeof wf.nodesJson === "string" ? JSON.parse(wf.nodesJson) : (wf.nodes || []);
        existingEdges = typeof wf.edgesJson === "string" ? JSON.parse(wf.edgesJson) : (wf.edges || []);
      } catch (e) {
        throw new Error("Workflow nodes/edges JSON is corrupted: " + (e as Error).message);
      }

      const updatedNodes = args.nodes ? normalizeWorkflowNodes(args.nodes) : existingNodes;
      const savePayload: Record<string, any> = {
        name: args.name || wf.name,
        description: args.description !== undefined ? args.description : (wf.description || ""),
        nodes: updatedNodes,
        connections: args.connections || existingEdges.map((e: any) => ({ source: e.source, target: e.target }))
      };

      const saveResponse = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
        { method: "POST", headers, body: JSON.stringify(savePayload) },
        60000
      );
      if (!saveResponse.ok) throw new Error(`Failed to save workflow: ${await saveResponse.text()}`);
      const saved = await saveResponse.json() as any;

      return {
        success: true,
        previous_id: args.workflow_id,
        new_entity_id: saved.entityId || saved.id || saved.workflow?.entityId || saved.workflow?.id || "check canvas_get_workflows for new version",
        name: savePayload.name,
        message: "Saved as new version (Geo storage is immutable). Use the new entityId for future references."
      };
    }

    case "update_workflow_node": {
      // Fetch → modify single node → save as new version (with retry for Geo propagation)
      const findWf = async (): Promise<any> => {
        for (let attempt = 0; attempt < 2; attempt++) {
          const wfResponse = await fetchWithTimeout(`${CANVAS_API_URL}/canvas/workflows`, { headers }, 30000);
          if (!wfResponse.ok) throw new Error(`Failed to load workflows: ${await wfResponse.text()}`);
          const wfData = await wfResponse.json() as any;
          const workflows = wfData.workflows || [];
          const wf = workflows.find((w: any) => w.entityId === args.workflow_id || w.name === args.workflow_id);
          if (wf) return wf;
          if (attempt === 0) await new Promise(r => setTimeout(r, 3000)); // wait for Geo propagation
        }
        throw new Error(`Workflow "${args.workflow_id}" not found. If recently saved, try again in a few seconds.`);
      };
      const wf = await findWf();

      let nodes: any[], edges: any[];
      try {
        nodes = typeof wf.nodesJson === "string" ? JSON.parse(wf.nodesJson) : (wf.nodes || []);
        edges = typeof wf.edgesJson === "string" ? JSON.parse(wf.edgesJson) : (wf.edges || []);
      } catch (e) {
        throw new Error("Workflow nodes/edges JSON is corrupted: " + (e as Error).message);
      }

      const targetNode = nodes.find((n: any) => n.id === args.node_id);
      if (!targetNode) throw new Error(`Node "${args.node_id}" not found in workflow "${args.workflow_id}"`);

      // Apply updates
      if (args.type) targetNode.type = args.type;
      if (args.position) targetNode.position = args.position;
      if (args.data) {
        targetNode.data = { ...targetNode.data, ...args.data };
        // Normalize model name if updated
        if (targetNode.data.model) targetNode.data.model = normalizeModelName(targetNode.data.model);
      }

      const savePayload = {
        name: wf.name,
        description: wf.description || "",
        nodes,
        connections: edges.map((e: any) => ({ source: e.source, target: e.target }))
      };

      const saveResponse = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
        { method: "POST", headers, body: JSON.stringify(savePayload) },
        60000
      );
      if (!saveResponse.ok) throw new Error(`Failed to save workflow: ${await saveResponse.text()}`);
      const saved = await saveResponse.json() as any;

      return {
        success: true,
        previous_id: args.workflow_id,
        new_entity_id: saved.entityId || saved.id || saved.workflow?.entityId || saved.workflow?.id || "check canvas_get_workflows for new version",
        updated_node_id: args.node_id,
        message: "Node updated and saved as new version (Geo storage is immutable)."
      };
    }

    case "canvas_approve_gate": {
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/runs/${encodeURIComponent(args.run_id)}/approvals/${encodeURIComponent(args.approval_id)}`,
        { method: "POST", headers, body: JSON.stringify({ decision: args.decision }) },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      let result: Record<string, any>;
      try { result = await response.json() as Record<string, any>; } catch { result = { success: true }; }
      return { success: true, run_id: args.run_id, approval_id: args.approval_id, decision: args.decision, ...result };
    }

    case "canvas_cancel_workflow": {
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/runs/${encodeURIComponent(args.run_id)}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const run = await response.json() as any;
      const pendingApprovals = (run.approvals || []).filter((a: any) => a.status === "pending");

      if (run.status === "completed" || run.status === "failed") {
        return { run_id: args.run_id, status: run.status, message: "Workflow already finished.", canCancel: false };
      }

      return {
        run_id: args.run_id,
        status: run.status,
        canCancel: pendingApprovals.length > 0,
        pendingApprovals: pendingApprovals.map((a: any) => ({ approvalId: a.approvalId, nodeId: a.nodeId, message: a.message })),
        message: pendingApprovals.length > 0
          ? `Workflow is ${run.status}. Reject ${pendingApprovals.length} pending approval(s) with canvas_approve_gate to stop execution.`
          : `Workflow is ${run.status}. No pending approvals to reject. Workflow will complete or timeout on its own.`
      };
    }

    default:
      throw new Error(`Unknown canvas tool: ${name}`);
  }
}

// ============================================================================
// AGENT TOOL HANDLERS
// ============================================================================

async function handleAgentTool(name: string, args: Record<string, any>, marketplace: MarketplaceManager): Promise<any> {
  const token = marketplace.getUserToken();

  switch (name) {
    case "agent_list": {
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents`,
        { headers: {
          "Content-Type": "application/json",
          ...(token ? { "Authorization": `Bearer ${token}` } : {})
        } },
        15000
      );
      if (!response.ok) throw new Error(`Agent Gateway returned ${response.status}: ${await response.text()}`);
      const data = await response.json() as any;
      const allAgents = data.agents || [];
      const limit = args.limit || 10;
      const agents = allAgents.slice(0, limit).map((a: any) => ({
        id: a.id,
        name: a.name,
        description: (a.description || "").slice(0, 120),
        model: a.model,
        requiredSecrets: a.requiredSecrets,
      }));
      return { success: true, agents, count: agents.length, total: allAgents.length };
    }

    case "agent_create_session": {
      if (!token) return { success: false, error: "No auth token available." };
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(args.agent_id)}/sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ model: args.model || "haiku" })
        },
        15000
      );
      if (!response.ok) throw new Error(`Failed to create session: ${response.status} ${await response.text()}`);
      const data = await response.json() as any;
      return { success: true, session_id: data.id, agent_id: args.agent_id, model: args.model || "haiku" };
    }

    case "agent_chat": {
      if (!token) return { success: false, error: "No auth token available." };
      const { agent_id, message, session_id, model = "haiku" } = args;

      // Get or create session
      let sessionId = session_id;
      if (!sessionId) {
        const sessionResponse = await fetchWithTimeout(
          `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agent_id)}/sessions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ model })
          },
          15000
        );
        if (!sessionResponse.ok) throw new Error(`Failed to create session: ${sessionResponse.status} ${await sessionResponse.text()}`);
        const sessionData = await sessionResponse.json() as any;
        sessionId = sessionData.id;
      }

      // Send chat message
      const chatResponse = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agent_id)}/sessions/${encodeURIComponent(sessionId!)}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "Accept": "text/event-stream" },
          body: JSON.stringify({ message, model })
        },
        300000
      );
      if (!chatResponse.ok) throw new Error(`Chat failed: ${chatResponse.status} ${await chatResponse.text()}`);

      // Parse SSE stream
      const responseText = await chatResponse.text();
      let accumulatedText = "";
      let cost: string | undefined;
      const lines = responseText.split("\n");
      for (const line of lines) {
        if (!line.startsWith("data: ") && !line.startsWith("data:")) continue;
        const dataStr = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
        if (dataStr === "[DONE]") break;
        try {
          const event = JSON.parse(dataStr) as any;
          if (event.type === "text") {
            if (typeof event.data === "string") accumulatedText += event.data;
            else if (event.data?.text) accumulatedText += event.data.text;
          }
          if (event.type === "content_block_delta" && event.delta?.text) {
            accumulatedText += event.delta.text;
          }
          if (event.type === "done" && event.data?.cost) cost = event.data.cost;
          if (event.type === "usage" && event.data?.cost) cost = event.data.cost;
          if (event.type === "error") {
            const errMsg = event.data?.message || JSON.stringify(event.data);
            throw new Error(`Agent error: ${errMsg}`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Agent error:")) throw e;
          console.error("[sse] Dropped malformed SSE line:", dataStr?.slice(0, 200));
        }
      }

      return {
        success: true,
        agent_id,
        session_id: sessionId,
        text: accumulatedText,
        cost,
        message: `Use session_id="${sessionId}" for follow-up messages.`
      };
    }

    case "agent_list_sessions": {
      if (!token) return { success: false, error: "No auth token available." };
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(args.agent_id)}/sessions`,
        { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` } },
        15000
      );
      if (!response.ok) throw new Error(`Failed to list sessions: ${response.status} ${await response.text()}`);
      const data = await response.json() as any;
      return { success: true, agent_id: args.agent_id, sessions: data.sessions || data || [], count: (data.sessions || data || []).length };
    }

    case "agent_get_session": {
      if (!token) return { success: false, error: "No auth token available." };
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(args.agent_id)}/sessions/${encodeURIComponent(args.session_id)}`,
        { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` } },
        15000
      );
      if (!response.ok) throw new Error(`Failed to get session: ${response.status} ${await response.text()}`);
      const data = await response.json() as any;
      // Limit messages to avoid huge outputs
      const msgLimit = args.message_limit !== undefined ? args.message_limit : 10;
      if (msgLimit > 0 && Array.isArray(data.messages) && data.messages.length > msgLimit) {
        const totalMessages = data.messages.length;
        data.messages = data.messages.slice(-msgLimit); // keep most recent
        data.messages_truncated = true;
        data.total_messages = totalMessages;
        data.showing_last = msgLimit;
      }
      // Compact message content (truncate long text blocks)
      if (Array.isArray(data.messages)) {
        data.messages = data.messages.map((m: any) => {
          if (typeof m.content === "string" && m.content.length > 500) {
            return { ...m, content: m.content.slice(0, 500) + "... [truncated]" };
          }
          return m;
        });
      }
      return { success: true, ...data };
    }

    case "agent_resume_session": {
      if (!token) return { success: false, error: "No auth token available." };
      const { agent_id, session_id, message, model = "haiku" } = args;
      const chatResponse = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agent_id)}/sessions/${encodeURIComponent(session_id)}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "Accept": "text/event-stream" },
          body: JSON.stringify({ message, model })
        },
        300000
      );
      if (!chatResponse.ok) throw new Error(`Chat failed: ${chatResponse.status} ${await chatResponse.text()}`);
      const responseText = await chatResponse.text();
      let accumulatedText = "";
      let cost: string | undefined;

      // Check if response is SSE format or plain JSON
      const isSSE = responseText.includes("data: ") || responseText.includes("data:");
      if (isSSE) {
        for (const line of responseText.split("\n")) {
          if (!line.startsWith("data: ") && !line.startsWith("data:")) continue;
          const dataStr = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
          if (dataStr === "[DONE]") break;
          try {
            const event = JSON.parse(dataStr) as any;
            if (event.type === "text") {
              if (typeof event.data === "string") accumulatedText += event.data;
              else if (event.data?.text) accumulatedText += event.data.text;
            }
            if (event.type === "content_block_delta" && event.delta?.text) accumulatedText += event.delta.text;
            if (event.type === "done" && event.data?.cost) cost = event.data.cost;
            if (event.type === "usage" && event.data?.cost) cost = event.data.cost;
            if (event.type === "error") throw new Error(`Agent error: ${event.data?.message || JSON.stringify(event.data)}`);
          } catch (e) {
            if (e instanceof Error && e.message.startsWith("Agent error:")) throw e;
            console.error("[sse] Dropped malformed SSE line:", dataStr?.slice(0, 200));
          }
        }
      } else {
        // Fallback: try parsing as JSON response
        try {
          const jsonResp = JSON.parse(responseText) as any;
          accumulatedText = jsonResp.text || jsonResp.response || jsonResp.content || responseText;
          cost = jsonResp.cost;
        } catch {
          accumulatedText = responseText; // raw text fallback
        }
      }

      if (!accumulatedText && responseText.length > 0) {
        // Last resort: return raw response info for debugging
        accumulatedText = `[No text extracted from response. Raw length: ${responseText.length}, starts with: ${responseText.slice(0, 100)}]`;
      }

      return { success: true, agent_id, session_id, text: accumulatedText, cost, message: `Session "${session_id}" resumed.` };
    }

    case "agent_delete_session": {
      if (!token) return { success: false, error: "No auth token available." };
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(args.agent_id)}/sessions/${encodeURIComponent(args.session_id)}`,
        { method: "DELETE", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` } },
        15000
      );
      if (!response.ok) throw new Error(`Failed to delete session: ${response.status} ${await response.text()}`);
      let result: Record<string, any>;
      try { result = await response.json() as Record<string, any>; } catch { result = { success: true }; }
      return { success: true, agent_id: args.agent_id, session_id: args.session_id, ...result, message: "Session deleted." };
    }

    default:
      throw new Error(`Unknown agent tool: ${name}`);
  }
}

// ============================================================================
// A2A TOOL HANDLERS
// ============================================================================

async function handleA2ATool(name: string, args: Record<string, any>, marketplace: MarketplaceManager): Promise<any> {
  const token = marketplace.getUserToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "A2A-Version": "0.3",
    ...(token ? { "Authorization": `Bearer ${token}` } : {})
  };

  switch (name) {
    case "a2a_get_agent_card": {
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/.well-known/agent.json`,
        { headers: { "Accept": "application/json" } },
        15000
      );
      if (!response.ok) throw new Error(`Failed to get agent card: ${response.status} ${await response.text()}`);
      const card = await response.json() as any;
      // Compact: truncate skills list to avoid massive output
      if (Array.isArray(card.skills) && card.skills.length > 5) {
        const totalSkills = card.skills.length;
        card.skills = card.skills.slice(0, 5);
        card.skills_truncated = true;
        card.total_skills = totalSkills;
      }
      // Strip verbose capability details
      if (card.capabilities) {
        card.capabilities = Object.keys(card.capabilities);
      }
      return card;
    }

    case "a2a_send_message": {
      if (!token) throw new Error("No auth token. Authenticate with a wallet token first.");
      const body = {
        message: {
          role: "user",
          parts: [{ type: "text", text: args.message }]
        },
        configuration: {
          blocking: args.blocking !== false,
          ...(args.context_id ? { contextId: args.context_id } : {})
        }
      };
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/a2a/messages`,
        { method: "POST", headers, body: JSON.stringify(body) },
        300000
      );
      if (!response.ok) throw new Error(`A2A message failed: ${response.status} ${await response.text()}`);
      return await response.json();
    }

    case "a2a_get_task": {
      if (!token) throw new Error("No auth token. Authenticate with a wallet token first.");
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/a2a/tasks/${encodeURIComponent(args.task_id)}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`Failed to get task: ${response.status} ${await response.text()}`);
      return await response.json();
    }

    case "a2a_list_tasks": {
      if (!token) throw new Error("No auth token. Authenticate with a wallet token first.");
      const params = new URLSearchParams();
      if (args.limit) params.append("limit", String(args.limit));
      if (args.status) params.append("status", args.status);
      if (args.context_id) params.append("contextId", args.context_id);
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/a2a/tasks?${params}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`Failed to list tasks: ${response.status} ${await response.text()}`);
      return await response.json();
    }

    case "a2a_cancel_task": {
      if (!token) throw new Error("No auth token. Authenticate with a wallet token first.");
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/a2a/tasks/${encodeURIComponent(args.task_id)}:cancel`,
        { method: "POST", headers },
        15000
      );
      if (!response.ok) throw new Error(`Failed to cancel task: ${response.status} ${await response.text()}`);
      return await response.json();
    }

    default:
      throw new Error(`Unknown A2A tool: ${name}`);
  }
}

// ============================================================================
// WALLET TOOL HANDLERS
// ============================================================================

async function handleWalletTool(name: string, args: Record<string, any>, marketplace: MarketplaceManager): Promise<any> {
  const token = marketplace.getUserToken();
  if (!token) throw new Error("No auth token. Authenticate with a wallet token first.");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  };

  switch (name) {
    case "wallet_get_balance": {
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/wallet/balance`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`Failed to get balance: ${response.status} ${await response.text()}`);
      const balance = await response.json() as any;
      // Return compact summary — strip per-agent breakdowns
      return {
        walletAddress: balance.walletAddress || balance.address,
        usdc: balance.usdc || balance.usdcBalance,
        eth: balance.eth || balance.ethBalance,
        network: balance.network || "base",
        ...(balance.totalSpent ? { totalSpent: balance.totalSpent } : {}),
      };
    }

    case "wallet_get_transactions": {
      const params = new URLSearchParams();
      params.append("limit", String(args.limit || 5));
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/wallet/transactions?${params}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`Failed to get transactions: ${response.status} ${await response.text()}`);
      const txData = await response.json() as any;
      // Compact transaction output
      const transactions = (txData.transactions || txData || []).slice(0, args.limit || 5);
      return { transactions, count: transactions.length };
    }

    case "wallet_apikey_status": {
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/wallet/apikey/status`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`Failed to get API key status: ${response.status} ${await response.text()}`);
      return await response.json();
    }

    default:
      throw new Error(`Unknown wallet tool: ${name}`);
  }
}

// ============================================================================
// SERVER SETUP
// ============================================================================

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
// Permissive rate limits: 1k/min, 10k/10min, 50k/hr
const rlOpts = { validate: { xForwardedForHeader: false }, standardHeaders: true, legacyHeaders: false };
app.use(rateLimit({ windowMs: 1 * 60 * 1000, max: 1000, ...rlOpts }));
app.use(rateLimit({ windowMs: 10 * 60 * 1000, max: 10000, ...rlOpts }));
app.use(rateLimit({ windowMs: 60 * 60 * 1000, max: 50000, ...rlOpts }));

// Auth middleware — wallet tokens only
// Users authenticate via `rickydata auth login` and connect via `rickydata mcp connect-server`
const authMiddleware: express.RequestHandler = (req, res, next) => {
  const authHeader = req.headers["authorization"] || "";
  const token = typeof authHeader === "string" ? authHeader.replace("Bearer ", "") : "";

  if (!token) {
    res.status(401).json({ error: "Missing Authorization header. Run `rickydata auth login` then `rickydata mcp connect-server`." });
    return;
  }

  if (!token.startsWith(WALLET_TOKEN_PREFIX)) {
    res.status(403).json({ error: "Invalid token format. Use a wallet token (mcpwt_). Run `rickydata auth login`." });
    return;
  }

  const result = verifyWalletToken(token);
  if (!result) {
    res.status(403).json({ error: "Invalid or expired wallet token. Run `rickydata auth login` to get a new one." });
    return;
  }

  (req as any).user = `wallet:${result.walletAddress}`;
  next();
};

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Root info
app.get("/", (_req, res) => {
  res.json({
    name: "rickydata MCP Server",
    version: "1.0.0",
    tools: TOOLS.length,
    endpoints: { health: "/health", mcp: "/mcp" },
    authentication: "wallet-token (mcpwt_)"
  });
});

// Session management — each MCP session gets its own server, transport, and marketplace state
interface MCPSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  marketplace: MarketplaceManager;
  createdAt: number;
}

const sessions = new Map<string, MCPSession>();

// Clean up sessions older than 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 2 * 60 * 60 * 1000) {
      session.transport.close();
      session.server.close();
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1000);

function setupMCPHandlers(server: Server, marketplace: MarketplaceManager): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS, ...marketplace.getDynamicTools()]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    let result: any;

    try {
      if (name.startsWith("canvas_") || name.startsWith("update_canvas_") || name.startsWith("update_workflow_") || name === "run_saved_canvas_workflow" || name === "run_workflow_and_wait") {
        result = await handleCanvasTool(name, args, marketplace);
      } else if (name.startsWith("agent_")) {
        result = await handleAgentTool(name, args, marketplace);
      } else if (name.startsWith("a2a_")) {
        result = await handleA2ATool(name, args, marketplace);
      } else if (name.startsWith("wallet_")) {
        result = await handleWalletTool(name, args, marketplace);
      } else if (name === "marketplace_search") {
        result = await marketplace.handleSearch(args as any);
      } else if (name === "marketplace_server_info") {
        result = await marketplace.handleServerInfo(args as any);
      } else if (name === "marketplace_enable_server") {
        result = await marketplace.handleEnableServer(args as any);
      } else if (name === "marketplace_disable_server") {
        result = await marketplace.handleDisableServer(args as any);
      } else if (name === "marketplace_list_enabled") {
        result = await marketplace.handleListEnabled();
      } else if (marketplace.isDynamicTool(name)) {
        result = await marketplace.handleDynamicToolCall(name, args);
      } else {
        result = { error: `Unknown tool: ${name}` };
      }
    } catch (error: any) {
      result = { success: false, error: error.message };
    }

    const content = truncateResponse(result);
    return {
      content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }]
    };
  });
}

// HTTP routes — session-based: state persists across requests
app.post("/mcp", authMiddleware, async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const userToken = typeof authHeader === "string" ? authHeader.replace("Bearer ", "") : "";

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.marketplace.setUserToken(userToken);
    await session.transport.handleRequest(req, res, req.body);
  } else {
    // New session: pre-generate ID so we can store it before handleRequest
    const newId = randomUUID();
    const marketplace = new MarketplaceManager();
    marketplace.setUserToken(userToken);

    const server = new Server(
      { name: "rickydata", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );
    marketplace.setServer(server);
    setupMCPHandlers(server, marketplace);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => newId });
    await server.connect(transport);

    sessions.set(newId, { server, transport, marketplace, createdAt: Date.now() });
    await transport.handleRequest(req, res, req.body);
  }
});

app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "Invalid or missing session. Send initialize first via POST." });
    return;
  }
  await sessions.get(sessionId)!.transport.handleRequest(req, res);
});

app.delete("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
    session.transport.close();
    session.server.close();
    sessions.delete(sessionId);
  } else {
    res.status(400).json({ error: "Invalid or missing session." });
  }
});

// Start
const isStdio = process.argv.includes("--stdio");

if (isStdio) {
  console.log = console.error;
  const stdioMarketplace = new MarketplaceManager();
  const stdioServer = new Server(
    { name: "rickydata", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } }
  );
  stdioMarketplace.setServer(stdioServer);
  stdioServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS, ...stdioMarketplace.getDynamicTools()]
  }));
  stdioServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    let result: any;
    try {
      if (name.startsWith("canvas_") || name.startsWith("update_canvas_") || name.startsWith("update_workflow_") || name === "run_saved_canvas_workflow" || name === "run_workflow_and_wait") {
        result = await handleCanvasTool(name, args, stdioMarketplace);
      } else if (name.startsWith("agent_")) {
        result = await handleAgentTool(name, args, stdioMarketplace);
      } else if (name.startsWith("a2a_")) {
        result = await handleA2ATool(name, args, stdioMarketplace);
      } else if (name.startsWith("wallet_")) {
        result = await handleWalletTool(name, args, stdioMarketplace);
      } else if (name === "marketplace_search") {
        result = await stdioMarketplace.handleSearch(args as any);
      } else if (name === "marketplace_server_info") {
        result = await stdioMarketplace.handleServerInfo(args as any);
      } else if (name === "marketplace_enable_server") {
        result = await stdioMarketplace.handleEnableServer(args as any);
      } else if (name === "marketplace_disable_server") {
        result = await stdioMarketplace.handleDisableServer(args as any);
      } else if (name === "marketplace_list_enabled") {
        result = await stdioMarketplace.handleListEnabled();
      } else if (stdioMarketplace.isDynamicTool(name)) {
        result = await stdioMarketplace.handleDynamicToolCall(name, args);
      } else {
        result = { error: `Unknown tool: ${name}` };
      }
    } catch (error: any) {
      result = { success: false, error: error.message };
    }
    const content = truncateResponse(result);
    return {
      content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }]
    };
  });
  const stdioTransport = new StdioServerTransport();
  await stdioServer.connect(stdioTransport);
  console.error("rickydata MCP Server running on stdio");
} else {
  const port = parseInt(process.env.PORT || "8080", 10);
  app.listen(port, () => {
    console.log(`rickydata MCP Server running on port ${port}`);
    console.log(`Tools: ${TOOLS.length}`);
    console.log(`Endpoints: /health /mcp`);
    console.log(`Authentication: wallet-token (mcpwt_)`);
  });
}

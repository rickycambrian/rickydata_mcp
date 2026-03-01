import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { verifyWalletToken, WALLET_TOKEN_PREFIX } from "./wallet-token.js";
import { marketplaceManager, MARKETPLACE_TOOLS } from "./marketplace.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const REQUIRE_AUTH = process.env.REQUIRE_AUTH === "true";
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "1000", 10);
const RATE_WINDOW_MINUTES = parseInt(process.env.RATE_WINDOW_MINUTES || "10", 10);
const RESPONSE_MAX_LENGTH = parseInt(process.env.RESPONSE_MAX_LENGTH || "50000", 10);
const CANVAS_API_URL = process.env.CANVAS_API_URL || "https://agents.rickydata.org";
const CANVAS_SERVICE_TOKEN = process.env.CANVAS_SERVICE_TOKEN || "";
const AGENT_GATEWAY_URL = process.env.AGENT_GATEWAY_URL || "https://agents.rickydata.org";

// User API key mapping
const USER_API_KEYS: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith("USER_") && key.endsWith("_KEY") && value) {
    const name = key.slice(5, -4).charAt(0) + key.slice(6, -4).toLowerCase();
    USER_API_KEYS[value] = name;
  }
}
if (CANVAS_SERVICE_TOKEN) {
  USER_API_KEYS[CANVAS_SERVICE_TOKEN] = "ServiceAccount";
}

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
  const truncated = text.slice(0, RESPONSE_MAX_LENGTH);
  return typeof data === "string"
    ? truncated + `\n... [truncated at ${RESPONSE_MAX_LENGTH} chars]`
    : JSON.parse(truncated.slice(0, truncated.lastIndexOf("}") + 1) || "{}");
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const CANVAS_TOOLS = [
  {
    name: "canvas_get_available_tools",
    description: "Get all available tools for canvas workflow building.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", description: "Filter by category" }
      }
    }
  },
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
    name: "canvas_get_workflow_messages",
    description: "Get detailed messages from a workflow run for debugging or live visibility.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Workflow run ID" },
        after_index: { type: "number", description: "Only return messages after this index" },
        node_id: { type: "string", description: "Filter to specific node" },
        limit: { type: "number", description: "Max messages (default: 100)" }
      },
      required: ["run_id"]
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
    name: "update_canvas_workflow",
    description: "Update an existing workflow by ID.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow UUID to update" },
        name: { type: "string", description: "New name" },
        description: { type: "string", description: "New description" },
        nodes: { type: "array", description: "New nodes" },
        connections: { type: "array", description: "New connections" }
      },
      required: ["workflow_id"]
    }
  },
  {
    name: "update_workflow_node",
    description: "Update a specific node in a workflow without rewriting the entire thing.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow UUID" },
        node_id: { type: "string", description: "Node ID to update" },
        config_updates: { type: "object", description: "Partial config updates to merge" },
        name: { type: "string", description: "New node name" }
      },
      required: ["workflow_id", "node_id"]
    }
  },
  {
    name: "canvas_ai_assistant",
    description: "Use AI to build workflows from natural language.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Natural language instruction" },
        currentWorkflow: {
          type: "object",
          description: "Current workflow state",
          properties: { nodes: { type: "array" }, connections: { type: "array" } }
        }
      },
      required: ["message"]
    }
  },
  {
    name: "canvas_ai_assistant_voice",
    description: "Voice-optimized Canvas AI Assistant for smartwatch/mobile.",
    inputSchema: {
      type: "object",
      properties: {
        transcription: { type: "string", description: "Transcribed voice input" },
        currentWorkflow: {
          type: "object",
          properties: { nodes: { type: "array" }, connections: { type: "array" } }
        },
        sessionId: { type: "string", description: "Session ID for context tracking" }
      },
      required: ["transcription"]
    }
  }
];

const AGENT_TOOLS = [
  {
    name: "agent_list",
    description: "List available agents from the Agent Gateway.",
    inputSchema: { type: "object", properties: {} }
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
  }
];

const TOOLS = [...CANVAS_TOOLS, ...AGENT_TOOLS, ...MARKETPLACE_TOOLS];

// ============================================================================
// CANVAS TOOL HANDLERS
// ============================================================================

async function handleCanvasTool(name: string, args: Record<string, any>): Promise<any> {
  const token = marketplaceManager.getUserToken() || CANVAS_SERVICE_TOKEN;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { "Authorization": `Bearer ${token}` } : {}),
    ...(CANVAS_SERVICE_TOKEN ? { "X-Service-Token": CANVAS_SERVICE_TOKEN } : {})
  };

  switch (name) {
    case "canvas_get_available_tools": {
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/available-tools`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const data = await response.json() as any;
      if (args.category && data.tools) {
        data.tools = data.tools.filter((t: any) => t.category === args.category || t.category?.startsWith(args.category));
      }
      return data;
    }

    case "canvas_execute_workflow": {
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/workflows/execute-sync`,
        { method: "POST", headers, body: JSON.stringify(args) },
        300000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "canvas_execute_workflow_async": {
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/workflows/execute-async`,
        { method: "POST", headers, body: JSON.stringify(args) },
        30000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "canvas_get_workflow_run": {
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/workflows/runs/${args.runId}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "canvas_get_workflow_messages": {
      const params = new URLSearchParams();
      if (args.after_index) params.append("after_index", String(args.after_index));
      if (args.node_id) params.append("node_id", args.node_id);
      if (args.limit) params.append("limit", String(args.limit));
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/workflows/runs/${args.run_id}/messages?${params}`,
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
        `${CANVAS_API_URL}/api/canvas/workflows/runs?${params}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "canvas_save_workflow": {
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/workflows`,
        { method: "POST", headers, body: JSON.stringify(args) },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "canvas_get_workflows": {
      const params = new URLSearchParams();
      if (args.search) params.append("search", args.search);
      if (args.limit) params.append("limit", String(args.limit));
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/workflows?${params}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "run_saved_canvas_workflow": {
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/workflows/run`,
        { method: "POST", headers, body: JSON.stringify(args) },
        30000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "run_workflow_and_wait": {
      // Start workflow
      const startResponse = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/workflows/run`,
        { method: "POST", headers, body: JSON.stringify(args) },
        30000
      );
      if (!startResponse.ok) throw new Error(`Failed to start: ${await startResponse.text()}`);
      const startResult = await startResponse.json() as any;
      const runId = startResult.runId || startResult.run_id;
      if (!runId) throw new Error("No run_id returned");

      // Poll for completion
      const maxWait = Math.min(args.max_wait_seconds || 300, 600) * 1000;
      const interval = (args.poll_interval_seconds || 5) * 1000;
      const start = Date.now();

      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, interval));
        const pollResponse = await fetchWithTimeout(
          `${CANVAS_API_URL}/api/canvas/workflows/runs/${runId}`,
          { headers },
          15000
        );
        if (!pollResponse.ok) continue;
        const pollResult = await pollResponse.json() as any;
        if (pollResult.status === "completed" || pollResult.status === "failed") {
          return { ...pollResult, run_id: runId, elapsed_seconds: Math.round((Date.now() - start) / 1000) };
        }
      }

      return { status: "timeout", run_id: runId, elapsed_seconds: Math.round((Date.now() - start) / 1000), message: `Still running after ${Math.round((Date.now() - start) / 1000)}s. Use canvas_get_workflow_run("${runId}") to check later.` };
    }

    case "update_canvas_workflow": {
      const { workflow_id, ...updates } = args;
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/workflows/${workflow_id}`,
        { method: "PUT", headers, body: JSON.stringify(updates) },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "update_workflow_node": {
      const { workflow_id, node_id, config_updates, name: nodeName } = args;
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/api/canvas/workflows/${workflow_id}/nodes/${node_id}`,
        { method: "PATCH", headers, body: JSON.stringify({ config_updates, name: nodeName }) },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "canvas_ai_assistant": {
      const toolsResponse = await fetch(`${CANVAS_API_URL}/api/canvas/available-tools`, { headers });
      const availableTools = toolsResponse.ok ? await toolsResponse.json() : null;
      const response = await fetch(`${CANVAS_API_URL}/api/canvas/ai-assistant`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: args.message,
          canvasState: args.currentWorkflow || { nodes: [], connections: [] },
          availableTools
        })
      });
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "canvas_ai_assistant_voice": {
      const toolsResponse = await fetch(`${CANVAS_API_URL}/api/canvas/available-tools`, { headers });
      const availableTools = toolsResponse.ok ? await toolsResponse.json() : null;
      const response = await fetch(`${CANVAS_API_URL}/api/canvas/ai-assistant`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: args.transcription,
          canvasState: args.currentWorkflow || { nodes: [], connections: [] },
          availableTools,
          voiceOptimized: true,
          sessionId: args.sessionId
        })
      });
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const data = await response.json() as any;
      let voiceResponse = data.finalMessage || data.message || "Done.";
      if (voiceResponse.length > 200) voiceResponse = voiceResponse.substring(0, 197) + "...";
      return { ...data, voiceResponse, voiceOptimized: true };
    }

    default:
      throw new Error(`Unknown canvas tool: ${name}`);
  }
}

// ============================================================================
// AGENT TOOL HANDLERS
// ============================================================================

async function handleAgentTool(name: string, args: Record<string, any>): Promise<any> {
  const token = marketplaceManager.getUserToken() || CANVAS_SERVICE_TOKEN;

  switch (name) {
    case "agent_list": {
      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents`,
        { headers: { "Content-Type": "application/json" } },
        15000
      );
      if (!response.ok) throw new Error(`Agent Gateway returned ${response.status}: ${await response.text()}`);
      const data = await response.json() as any;
      return { success: true, agents: data.agents || [], count: (data.agents || []).length };
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
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
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
          if (event.type === "text") accumulatedText += typeof event.data === "string" ? event.data : "";
          if (event.type === "usage" && event.data?.cost) cost = event.data.cost;
        } catch { /* skip malformed SSE lines */ }
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

    default:
      throw new Error(`Unknown agent tool: ${name}`);
  }
}

// ============================================================================
// SERVER SETUP
// ============================================================================

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(rateLimit({ windowMs: RATE_WINDOW_MINUTES * 60 * 1000, max: RATE_LIMIT }));

// Auth middleware
const authMiddleware: express.RequestHandler = (req, res, next) => {
  if (!REQUIRE_AUTH) return next();

  const authHeader = req.headers["authorization"] || "";
  const apiKey = typeof authHeader === "string" ? authHeader.replace("Bearer ", "") : "";

  if (!apiKey) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  if (apiKey.startsWith(WALLET_TOKEN_PREFIX)) {
    const result = verifyWalletToken(apiKey);
    if (!result) {
      res.status(403).json({ error: "Invalid or expired wallet token. Get a new one at https://mcpmarketplace.rickydata.org/auth/cli" });
      return;
    }
    (req as any).user = `wallet:${result.walletAddress}`;
    return next();
  }

  const userName = USER_API_KEYS[apiKey];
  if (!userName) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }
  (req as any).user = userName;
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
    authentication: REQUIRE_AUTH ? "enabled" : "disabled"
  });
});

// MCP Server
const server = new Server(
  { name: "rickydata", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } }
);

marketplaceManager.setServer(server);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...TOOLS, ...marketplaceManager.getDynamicTools()]
}));

// Call tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let result: any;

  try {
    // Canvas tools
    if (name.startsWith("canvas_") || name === "run_saved_canvas_workflow" || name === "run_workflow_and_wait" || name === "update_canvas_workflow" || name === "update_workflow_node") {
      result = await handleCanvasTool(name, args);
    }
    // Agent tools
    else if (name.startsWith("agent_")) {
      result = await handleAgentTool(name, args);
    }
    // Marketplace tools
    else if (name === "marketplace_search") {
      result = await marketplaceManager.handleSearch(args as any);
    } else if (name === "marketplace_server_info") {
      result = await marketplaceManager.handleServerInfo(args as any);
    } else if (name === "marketplace_enable_server") {
      result = await marketplaceManager.handleEnableServer(args as any);
    } else if (name === "marketplace_disable_server") {
      result = await marketplaceManager.handleDisableServer(args as any);
    } else if (name === "marketplace_list_enabled") {
      result = await marketplaceManager.handleListEnabled();
    }
    // Dynamic marketplace tools
    else if (marketplaceManager.isDynamicTool(name)) {
      result = await marketplaceManager.handleDynamicToolCall(name, args);
    }
    // Unknown
    else {
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

// HTTP transport
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

app.post("/mcp", authMiddleware, async (req, res) => {
  // Extract user token and pass to marketplace manager
  const authHeader = req.headers["authorization"] || "";
  const userToken = typeof authHeader === "string" ? authHeader.replace("Bearer ", "") : "";
  marketplaceManager.setUserToken(userToken);

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", authMiddleware, async (req, res) => {
  await transport.handleRequest(req, res);
});

app.delete("/mcp", authMiddleware, async (req, res) => {
  await transport.handleRequest(req, res);
});

// Connect MCP server to transport
await server.connect(transport);

// Start
const isStdio = process.argv.includes("--stdio");

if (isStdio) {
  console.log = console.error;
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error("rickydata MCP Server running on stdio");
} else {
  const port = parseInt(process.env.PORT || "8080", 10);
  app.listen(port, () => {
    console.log(`rickydata MCP Server running on port ${port}`);
    console.log(`Tools: ${TOOLS.length}`);
    console.log(`Endpoints: /health /mcp`);
    console.log(`Authentication: ${REQUIRE_AUTH ? "ENABLED" : "DISABLED"}`);
  });
}

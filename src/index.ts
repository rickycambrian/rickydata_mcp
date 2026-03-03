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
    } catch { /* skip malformed lines */ }
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
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows/execute/stream`,
        { method: "POST", headers, body: JSON.stringify(args) },
        300000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const sseText = await response.text();
      return parseSSEResult(sseText);
    }

    case "canvas_execute_workflow_async": {
      // Async execution via SSE — return run ID immediately after run_started event
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows/execute/stream`,
        { method: "POST", headers, body: JSON.stringify(args) },
        30000
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
      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
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
        `${CANVAS_API_URL}/canvas/workflows?${params}`,
        { headers },
        15000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await response.json();
    }

    case "run_saved_canvas_workflow": {
      // Load saved workflow and execute via SSE
      const wfResponse = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
        { headers },
        15000
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

      const nodes = typeof wf.nodesJson === "string" ? JSON.parse(wf.nodesJson) : (wf.nodes || []);
      const edges = typeof wf.edgesJson === "string" ? JSON.parse(wf.edgesJson) : (wf.edges || []);
      if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`Workflow "${searchTerm}" has no nodes`);
      const request: Record<string, any> = {
        nodes: nodes.map((n: any) => ({ id: n.id, type: n.type, data: n.data })),
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
        15000
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

      const nodes = typeof wf.nodesJson === "string" ? JSON.parse(wf.nodesJson) : (wf.nodes || []);
      const edges = typeof wf.edgesJson === "string" ? JSON.parse(wf.edgesJson) : (wf.edges || []);
      if (!Array.isArray(nodes) || nodes.length === 0) throw new Error(`Workflow "${searchTerm}" has no nodes`);
      const request: Record<string, any> = {
        nodes: nodes.map((n: any) => ({ id: n.id, type: n.type, data: n.data })),
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
          /* skip malformed SSE lines */
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

    default:
      throw new Error(`Unknown agent tool: ${name}`);
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
      if (name.startsWith("canvas_") || name === "run_saved_canvas_workflow" || name === "run_workflow_and_wait") {
        result = await handleCanvasTool(name, args, marketplace);
      } else if (name.startsWith("agent_")) {
        result = await handleAgentTool(name, args, marketplace);
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
      if (name.startsWith("canvas_") || name === "run_saved_canvas_workflow" || name === "run_workflow_and_wait") {
        result = await handleCanvasTool(name, args, stdioMarketplace);
      } else if (name.startsWith("agent_")) {
        result = await handleAgentTool(name, args, stdioMarketplace);
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

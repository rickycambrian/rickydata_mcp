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
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { RickydataOAuthProvider, oauthCompleteHandler, oauthCallbackHandler, pruneOAuthStores } from "./oauth.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const RESPONSE_MAX_LENGTH = parseInt(process.env.RESPONSE_MAX_LENGTH || "200000", 10);
const CANVAS_API_URL = process.env.CANVAS_API_URL || "https://agents.rickydata.org";
const AGENT_GATEWAY_URL = process.env.AGENT_GATEWAY_URL || "https://agents.rickydata.org";
const MCP_DISABLE_TIMEOUTS = process.env.MCP_DISABLE_TIMEOUTS !== "false";
const MCP_HTTP_TIMEOUT_MS = parseInt(process.env.MCP_HTTP_TIMEOUT_MS || "0", 10);
const WORKFLOW_CACHE_TTL_MS = parseInt(process.env.WORKFLOW_CACHE_TTL_MS || "900000", 10);
const WORKFLOW_LOOKUP_LIMIT = parseInt(process.env.WORKFLOW_LOOKUP_LIMIT || "100", 10);
const RUN_TAIL_TTL_MS = parseInt(process.env.RUN_TAIL_TTL_MS || "1800000", 10);
const RUN_TAIL_MAX_EVENTS = parseInt(process.env.RUN_TAIL_MAX_EVENTS || "500", 10);
const RUN_TAIL_MAX_RUNS = parseInt(process.env.RUN_TAIL_MAX_RUNS || "200", 10);
const AGENT_STATUS_TTL_MS = parseInt(process.env.AGENT_STATUS_TTL_MS || "1800000", 10);
const AGENT_RESUME_WAIT_SECONDS = parseInt(process.env.AGENT_RESUME_WAIT_SECONDS || "20", 10);
const AGENT_STATUS_POLL_INTERVAL_MS = parseInt(process.env.AGENT_STATUS_POLL_INTERVAL_MS || "3000", 10);
const AGENT_STATUS_POLL_MAX_MS = parseInt(process.env.AGENT_STATUS_POLL_MAX_MS || "90000", 10);
const MAX_CITATION_VALIDATIONS = parseInt(process.env.MAX_CITATION_VALIDATIONS || "12", 10);
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || "https://rickydata-mcp-server-2dbp4scmrq-uc.a.run.app";

interface WorkflowLike {
  entityId?: string;
  workflowId?: string;
  id?: string;
  name?: string;
  description?: string;
  nodesJson?: string;
  edgesJson?: string;
  nodes?: any[];
  edges?: any[];
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any;
}

interface WorkflowCacheEntry {
  workflow: WorkflowLike;
  cachedAt: number;
}

interface ParsedSSEOptions {
  includeEvents?: boolean;
  includeLiveLogs?: boolean;
  liveLogLimit?: number;
  streamProgress?: boolean;
}

interface NodeMetric {
  node_id: string;
  status: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  retry_count: number;
  last_error?: string;
}

interface ParsedSSEResult {
  runId: string;
  status: string;
  results: Record<string, any>;
  logs: string[];
  event_count: number;
  error?: string;
  events?: any[];
  per_node_metrics?: NodeMetric[];
  retry_summary?: {
    total_retries: number;
    nodes_with_retries: number;
  };
}

interface RunTailEvent {
  index: number;
  timestamp: string;
  type: string;
  node_id?: string;
  message?: string;
  data?: any;
}

interface RunTailState {
  run_id: string;
  status: string;
  next_index: number;
  events: RunTailEvent[];
  last_updated_at: number;
}

type AgentRequestStatus = "queued" | "running" | "still_running" | "completed" | "failed";

interface AgentResumeStatusRequest {
  request_id: string;
  agent_id: string;
  session_id: string;
  status: AgentRequestStatus;
  created_at: string;
  updated_at: string;
  user_message: string;
  partial_text?: string;
  final_text?: string;
  cost?: string;
  error?: string;
  recovered?: boolean;
  previous_session_id?: string;
  next_action?: string;
}

type ResearchQualityPolicy = "none" | "warn" | "strict";

interface CitationFlag {
  url: string;
  domain: string;
  trusted: boolean;
  verified: boolean;
  reason?: string;
}

interface CitationReport {
  policy: ResearchQualityPolicy;
  trusted_domains: string[];
  total_citations: number;
  trusted_count: number;
  unverified_count: number;
  flags: CitationFlag[];
}

interface AgentCostControls {
  max_tokens?: number | null;
  max_tool_calls?: number | null;
  max_turns?: number | null;
  response_style?: "concise" | "detailed";
}

const workflowCacheById = new Map<string, WorkflowCacheEntry>();
const workflowCacheByName = new Map<string, WorkflowCacheEntry>();
const runTailById = new Map<string, RunTailState>();
const agentResumeRequestsById = new Map<string, AgentResumeStatusRequest>();

const DEFAULT_TRUSTED_DOMAINS = [
  "nature.com",
  "science.org",
  "arxiv.org",
  "pubmed.ncbi.nlm.nih.gov",
  "nejm.org",
  "thelancet.com",
  "cell.com",
];

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

function resolveTimeoutMs(requestedMs?: number): number | undefined {
  if (MCP_DISABLE_TIMEOUTS) return undefined;
  if (Number.isFinite(requestedMs) && (requestedMs as number) > 0) return requestedMs;
  if (Number.isFinite(MCP_HTTP_TIMEOUT_MS) && MCP_HTTP_TIMEOUT_MS > 0) return MCP_HTTP_TIMEOUT_MS;
  return undefined;
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs?: number): Promise<Response> {
  const effectiveTimeoutMs = resolveTimeoutMs(timeoutMs);
  if (!effectiveTimeoutMs) {
    return await fetch(url, options);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
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

// Canvas runtime expects full model IDs for workflow agent nodes.
const CANVAS_MODEL_NAME_MAP: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-6",
};

// Agent Gateway chat/session endpoints are alias-first; normalize full IDs to aliases.
const GATEWAY_MODEL_NAME_MAP: Record<string, string> = {
  sonnet: "sonnet",
  "claude-sonnet-4-6": "sonnet",
  haiku: "haiku",
  "claude-haiku-4-5-20251001": "haiku",
  opus: "opus",
  "claude-opus-4-6": "opus",
};

function normalizeCanvasModelName(name?: string): string | undefined {
  if (!name) return undefined;
  return CANVAS_MODEL_NAME_MAP[name.toLowerCase()] || name;
}

function normalizeGatewayModelName(name?: string, fallback = "haiku"): string {
  if (!name) return fallback;
  return GATEWAY_MODEL_NAME_MAP[name.toLowerCase()] || name;
}

/** Normalize model names in workflow nodes before execution. */
function normalizeWorkflowNodes(nodes: any[]): any[] {
  return nodes.map(n => {
    if (n.data?.model) {
      return { ...n, data: { ...n.data, model: normalizeCanvasModelName(n.data.model) } };
    }
    return n;
  });
}

function getWorkflowId(workflow: WorkflowLike): string | undefined {
  const direct = typeof workflow.entityId === "string"
    ? workflow.entityId
    : typeof workflow.workflowId === "string"
      ? workflow.workflowId
      : typeof workflow.id === "string"
        ? workflow.id
        : undefined;
  if (direct) return direct;
  const nested = workflow.workflow;
  if (nested && typeof nested === "object") {
    if (typeof nested.entityId === "string") return nested.entityId;
    if (typeof nested.workflowId === "string") return nested.workflowId;
    if (typeof nested.id === "string") return nested.id;
  }
  return undefined;
}

function normalizeWorkflowForCache(workflow: WorkflowLike): WorkflowLike {
  const normalized: WorkflowLike = { ...workflow };
  if (!normalized.entityId) {
    const id = getWorkflowId(normalized);
    if (id) normalized.entityId = id;
  }
  return normalized;
}

function pruneWorkflowCache(now = Date.now()): void {
  for (const [id, entry] of workflowCacheById.entries()) {
    if (now - entry.cachedAt > WORKFLOW_CACHE_TTL_MS) workflowCacheById.delete(id);
  }
  for (const [name, entry] of workflowCacheByName.entries()) {
    if (now - entry.cachedAt > WORKFLOW_CACHE_TTL_MS) workflowCacheByName.delete(name);
  }
}

function cacheWorkflow(workflow: WorkflowLike): void {
  const normalized = normalizeWorkflowForCache(workflow);
  const entry: WorkflowCacheEntry = {
    workflow: normalized,
    cachedAt: Date.now(),
  };
  const id = getWorkflowId(normalized);
  if (id) workflowCacheById.set(id, entry);
  if (typeof normalized.name === "string" && normalized.name.trim()) {
    workflowCacheByName.set(normalized.name.trim().toLowerCase(), entry);
  }
}

function getCachedWorkflow(workflowId?: string, workflowName?: string): WorkflowLike | null {
  pruneWorkflowCache();
  if (workflowId) {
    const byId = workflowCacheById.get(workflowId);
    if (byId) return byId.workflow;
    const byNameAsId = workflowCacheByName.get(workflowId.toLowerCase());
    if (byNameAsId) return byNameAsId.workflow;
  }
  if (workflowName) {
    const byName = workflowCacheByName.get(workflowName.toLowerCase());
    if (byName) return byName.workflow;
  }
  return null;
}

function pruneRunTailCache(now = Date.now()): void {
  for (const [runId, state] of runTailById.entries()) {
    if (now - state.last_updated_at > RUN_TAIL_TTL_MS) runTailById.delete(runId);
  }
  while (runTailById.size > RUN_TAIL_MAX_RUNS) {
    const oldest = Array.from(runTailById.entries()).sort((a, b) => a[1].last_updated_at - b[1].last_updated_at)[0];
    if (!oldest) break;
    runTailById.delete(oldest[0]);
  }
}

function ensureRunTail(runId: string): RunTailState {
  pruneRunTailCache();
  const existing = runTailById.get(runId);
  if (existing) return existing;
  const created: RunTailState = {
    run_id: runId,
    status: "unknown",
    next_index: 0,
    events: [],
    last_updated_at: Date.now(),
  };
  runTailById.set(runId, created);
  return created;
}

function appendRunTailEvent(runId: string, event: any, stateStatus?: string): void {
  if (!runId) return;
  const tail = ensureRunTail(runId);
  const nodeId = event?.data?.nodeId || event?.data?.node_id || event?.nodeId || event?.node_id;
  const message = typeof event?.data?.message === "string" ? event.data.message : undefined;
  tail.events.push({
    index: tail.next_index,
    timestamp: new Date().toISOString(),
    type: typeof event?.type === "string" ? event.type : "event",
    node_id: typeof nodeId === "string" ? nodeId : undefined,
    message,
    data: event?.data,
  });
  tail.next_index += 1;
  if (tail.events.length > RUN_TAIL_MAX_EVENTS) {
    tail.events = tail.events.slice(-RUN_TAIL_MAX_EVENTS);
  }
  tail.last_updated_at = Date.now();
  if (stateStatus) tail.status = stateStatus;
}

function pruneAgentResumeStatusCache(now = Date.now()): void {
  for (const [requestId, request] of agentResumeRequestsById.entries()) {
    const updatedAt = new Date(request.updated_at).getTime();
    if (now - updatedAt > AGENT_STATUS_TTL_MS) {
      agentResumeRequestsById.delete(requestId);
    }
  }
}

function createAgentResumeRequest(agentId: string, sessionId: string, message: string): AgentResumeStatusRequest {
  pruneAgentResumeStatusCache();
  const nowIso = new Date().toISOString();
  const request: AgentResumeStatusRequest = {
    request_id: randomUUID(),
    agent_id: agentId,
    session_id: sessionId,
    status: "queued",
    created_at: nowIso,
    updated_at: nowIso,
    user_message: message,
  };
  agentResumeRequestsById.set(request.request_id, request);
  return request;
}

function updateAgentResumeRequest(requestId: string, updates: Partial<AgentResumeStatusRequest>): AgentResumeStatusRequest | null {
  const existing = agentResumeRequestsById.get(requestId);
  if (!existing) return null;
  const merged: AgentResumeStatusRequest = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  };
  agentResumeRequestsById.set(requestId, merged);
  return merged;
}

function listUnique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function normalizeTrustedDomains(input?: unknown): string[] {
  const provided = Array.isArray(input)
    ? input.map((d) => String(d || "").toLowerCase().trim()).filter(Boolean)
    : [];
  return listUnique(provided.length ? provided : DEFAULT_TRUSTED_DOMAINS);
}

function domainMatchesTrusted(domain: string, trustedDomains: string[]): boolean {
  return trustedDomains.some((trusted) => domain === trusted || domain.endsWith(`.${trusted}`));
}

function extractCitationUrls(text: string): string[] {
  if (!text) return [];
  const markdownLinks = Array.from(text.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/gi)).map((m) => m[1]);
  const plainUrls = Array.from(text.matchAll(/\bhttps?:\/\/[^\s<>)\]]+/gi)).map((m) => m[0]);
  const urls: string[] = [];
  for (const raw of [...markdownLinks, ...plainUrls]) {
    try {
      urls.push(new URL(raw).toString());
    } catch {
      // skip invalid URL
    }
  }
  return listUnique(urls);
}

async function verifyCitationUrl(url: string): Promise<{ verified: boolean; reason?: string }> {
  try {
    const headResponse = await fetchWithTimeout(url, { method: "HEAD", redirect: "follow" }, 5000);
    if (headResponse.ok) return { verified: true };
    if (headResponse.status === 405 || headResponse.status === 403) {
      const getResponse = await fetchWithTimeout(url, { method: "GET", redirect: "follow" }, 5000);
      return getResponse.ok ? { verified: true } : { verified: false, reason: `HTTP ${getResponse.status}` };
    }
    return { verified: false, reason: `HTTP ${headResponse.status}` };
  } catch (error) {
    return { verified: false, reason: error instanceof Error ? error.message : "request_failed" };
  }
}

function normalizeResearchQualityPolicy(input: unknown, agentId: string): ResearchQualityPolicy {
  const raw = String(input || "").trim().toLowerCase();
  if (raw === "warn" || raw === "strict" || raw === "none") return raw;
  return agentId.toLowerCase().includes("research") ? "warn" : "none";
}

function buildResearchPolicyPrompt(policy: ResearchQualityPolicy, trustedDomains: string[]): string {
  if (policy === "none") return "";
  return [
    "",
    "Source policy:",
    `- Prefer trusted domains: ${trustedDomains.join(", ")}`,
    "- Include verifiable URLs for cited claims.",
    policy === "strict"
      ? "- Do not include a citation unless it is verifiable and from trusted sources when possible."
      : "- If a citation is uncertain, explicitly label uncertainty.",
  ].join("\n");
}

function applyResponseStyle(text: string, style: unknown): { text: string; truncated: boolean } {
  const responseStyle = String(style || "concise").toLowerCase();
  if (responseStyle !== "concise") return { text, truncated: false };
  const conciseLimit = 6000;
  if (text.length <= conciseLimit) return { text, truncated: false };
  return { text: `${text.slice(0, conciseLimit)}\n... [truncated for concise response style]`, truncated: true };
}

function parsePositiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function extractNodeId(event: any): string | null {
  const value = event?.data?.nodeId || event?.data?.node_id || event?.nodeId || event?.node_id;
  return typeof value === "string" && value ? value : null;
}

function extractEventTimestamp(event: any): string {
  const raw = event?.timestamp || event?.data?.timestamp || event?.data?.at || event?.data?.createdAt;
  if (typeof raw === "string" && raw) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return new Date(raw).toISOString();
  return new Date().toISOString();
}

function ensureNodeMetric(
  map: Map<string, NodeMetric>,
  nodeId: string,
): NodeMetric {
  const existing = map.get(nodeId);
  if (existing) return existing;
  const created: NodeMetric = {
    node_id: nodeId,
    status: "unknown",
    started_at: null,
    ended_at: null,
    duration_ms: null,
    retry_count: 0,
  };
  map.set(nodeId, created);
  return created;
}

function finalizeNodeMetrics(map: Map<string, NodeMetric>): { perNodeMetrics: NodeMetric[]; retrySummary: { total_retries: number; nodes_with_retries: number } } {
  const perNodeMetrics = Array.from(map.values()).sort((a, b) => (a.node_id > b.node_id ? 1 : -1));
  const totalRetries = perNodeMetrics.reduce((sum, metric) => sum + metric.retry_count, 0);
  return {
    perNodeMetrics,
    retrySummary: {
      total_retries: totalRetries,
      nodes_with_retries: perNodeMetrics.filter((metric) => metric.retry_count > 0).length,
    },
  };
}

function extractCanonicalWorkflowId(workflow: any): string | undefined {
  return getWorkflowId(workflow);
}

async function resolveCanonicalWorkflowId(
  headers: Record<string, string>,
  savedWorkflow: any,
  workflowName?: string,
): Promise<string> {
  const directId = extractCanonicalWorkflowId(savedWorkflow);
  if (directId) return directId;
  if (workflowName) {
    const byName = await findWorkflow(headers, undefined, workflowName);
    const idByName = byName ? extractCanonicalWorkflowId(byName) : undefined;
    if (idByName) return idByName;
  }
  throw new Error("Unable to resolve canonical workflow id from save/update response.");
}

function sameWorkflowDefinition(
  existing: WorkflowLike,
  candidate: { name?: string; description?: string; nodes?: any[]; connections?: any[] },
): boolean {
  try {
    const existingNodes = typeof existing.nodesJson === "string" ? JSON.parse(existing.nodesJson) : (existing.nodes || []);
    const existingConnections = typeof existing.edgesJson === "string" ? JSON.parse(existing.edgesJson) : (existing.edges || []);
    const normalizedExisting = JSON.stringify({
      name: existing.name || "",
      description: existing.description || "",
      nodes: normalizeWorkflowNodes(existingNodes || []),
      connections: existingConnections || [],
    });
    const normalizedCandidate = JSON.stringify({
      name: candidate.name || "",
      description: candidate.description || "",
      nodes: normalizeWorkflowNodes(candidate.nodes || []),
      connections: candidate.connections || [],
    });
    return normalizedExisting === normalizedCandidate;
  } catch {
    return false;
  }
}

function resolveAgentCostControls(args: Record<string, any>): AgentCostControls {
  const maxTokens = parsePositiveNumber(args.max_tokens);
  const maxToolCalls = parsePositiveNumber(args.max_tool_calls);
  const maxTurns = parsePositiveNumber(args.max_turns);
  const responseStyle = String(args.response_style || "concise").toLowerCase() === "detailed" ? "detailed" : "concise";
  return {
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(maxToolCalls ? { max_tool_calls: maxToolCalls } : {}),
    ...(maxTurns ? { max_turns: maxTurns } : {}),
    response_style: responseStyle,
  };
}

function isSessionMismatchError(errorMessage: string): boolean {
  return errorMessage.includes("tool_use") && errorMessage.includes("tool_result") && errorMessage.includes("without");
}

function parseWorkflowGraph(workflow: WorkflowLike, searchTerm: string): { nodes: any[]; edges: any[] } {
  let nodes: any[] = [];
  let edges: any[] = [];
  try {
    nodes = typeof workflow.nodesJson === "string" ? JSON.parse(workflow.nodesJson) : (workflow.nodes || []);
    edges = typeof workflow.edgesJson === "string" ? JSON.parse(workflow.edgesJson) : (workflow.edges || []);
  } catch (e) {
    throw new Error(`Workflow "${searchTerm}" has invalid nodes/edges JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error(`Workflow "${searchTerm}" has no nodes`);
  }
  return { nodes, edges: Array.isArray(edges) ? edges : [] };
}

function applySSEEvent(
  state: ParsedSSEResult,
  event: any,
  options: ParsedSSEOptions,
  nodeMetrics: Map<string, NodeMetric>,
): void {
  if (options.includeEvents) {
    if (!state.events) state.events = [];
    state.events.push(event);
  }

  if (event?.type === "run_started") {
    state.runId = event.data?.runId || state.runId;
  }

  const runHint = state.runId || event?.data?.runId || "";
  if (runHint) {
    appendRunTailEvent(runHint, event, state.status);
  }

  const nodeId = extractNodeId(event);
  if (nodeId) {
    const metric = ensureNodeMetric(nodeMetrics, nodeId);
    const eventType = String(event?.type || "").toLowerCase();
    const eventTimestamp = extractEventTimestamp(event);
    if (eventType.includes("node_retry") || eventType.includes("node_retr")) {
      metric.retry_count += 1;
    }
    if (
      eventType === "node_started" ||
      eventType === "node_running" ||
      eventType === "node_executing" ||
      eventType === "node_queued"
    ) {
      if (!metric.started_at) metric.started_at = eventTimestamp;
      metric.status = eventType.replace("node_", "");
    }
    if (eventType === "node_failed" || eventType === "node_error") {
      metric.status = "failed";
      metric.ended_at = eventTimestamp;
      if (metric.started_at && metric.ended_at) {
        metric.duration_ms = Math.max(0, new Date(metric.ended_at).getTime() - new Date(metric.started_at).getTime());
      }
      if (typeof event?.data?.error === "string") metric.last_error = event.data.error;
    }
    if (eventType === "node_completed" || eventType === "node_succeeded" || eventType === "node_done") {
      metric.status = "completed";
      metric.ended_at = eventTimestamp;
      if (metric.started_at && metric.ended_at) {
        metric.duration_ms = Math.max(0, new Date(metric.ended_at).getTime() - new Date(metric.started_at).getTime());
      }
    }
  }

  if (event?.type === "node_log") {
    const message = typeof event.data?.message === "string" ? event.data.message : "";
    if (message) {
      if (options.includeLiveLogs !== false) {
        state.logs.push(message);
        const liveLogLimit = Number.isFinite(options.liveLogLimit) ? Math.max(1, Number(options.liveLogLimit)) : 300;
        if (state.logs.length > liveLogLimit) {
          state.logs = state.logs.slice(-liveLogLimit);
        }
      }
      if (options.streamProgress) {
        const progressRunHint = state.runId || "pending";
        const nodeHint = event.data?.nodeId || "node";
        console.error(`[canvas:${progressRunHint}] ${nodeHint}: ${message}`);
      }
    }
  }

  if (event?.type === "run_completed") {
    state.runId = event.data?.runId || state.runId;
    state.status = event.data?.status || "completed";
    state.results = event.data?.results || state.results;
    if (state.runId) {
      const tail = ensureRunTail(state.runId);
      tail.status = state.status;
      tail.last_updated_at = Date.now();
    }
  }

  if (event?.type === "run_failed") {
    state.runId = event.data?.runId || state.runId;
    state.status = event.data?.status || "failed";
    if (typeof event.data?.error === "string") {
      state.error = event.data.error;
    }
    if (state.runId) {
      const tail = ensureRunTail(state.runId);
      tail.status = state.status;
      tail.last_updated_at = Date.now();
    }
  }

  if (event?.type === "error") {
    state.status = "failed";
    if (typeof event.data?.message === "string") {
      state.error = event.data.message;
    }
    if (state.runId) {
      const tail = ensureRunTail(state.runId);
      tail.status = state.status;
      tail.last_updated_at = Date.now();
    }
  }
}

function parseSSELine(line: string): any | null {
  const dataStr = line.startsWith("data: ")
    ? line.slice(6)
    : line.startsWith("data:")
      ? line.slice(5)
      : null;
  if (!dataStr || dataStr === "[DONE]") return null;
  return JSON.parse(dataStr);
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
        connections: { type: "array", description: "Array of connections" },
        upsert_by_name: { type: "boolean", description: "If true, reuse an existing workflow with the same name when the definition is unchanged." }
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
    description: "Run a workflow and wait for completion. Supports optional live log collection and progress streaming.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Workflow UUID" },
        workflow_name: { type: "string", description: "Workflow name to search for" },
        user_prompt: { type: "string", description: "Optional context/input" },
        max_wait_seconds: { type: "number", description: "Optional max wait time in seconds. Omit or set <= 0 to disable MCP-layer timeout." },
        poll_interval_seconds: { type: "number", description: "Compatibility field for clients expecting polling semantics (not used by stream execution)." },
        stale_threshold_seconds: { type: "number", description: "Compatibility field for stale-run detection (not used by stream execution)." },
        include_live_logs: { type: "boolean", description: "Include node_log entries in the final response (default: true)." },
        live_log_limit: { type: "number", description: "Max live log entries to keep (default: 300)." },
        stream_progress: { type: "boolean", description: "Emit incremental progress lines to server logs while waiting (default: false)." },
        include_events: { type: "boolean", description: "Include raw SSE events in final output for debugging." }
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
    name: "canvas_tail_run",
    description: "Poll incremental logs/events for a run started through this MCP server.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID to tail" },
        after_index: { type: "number", description: "Return events with index > after_index (default: -1)" },
        limit: { type: "number", description: "Max events to return (default: 100)" }
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
        canvas_state: { type: "object", description: "Optional current canvas state with nodes and connections" },
        agent_id: { type: "string", description: "Optional preferred orchestration agent (default: agent-builder)." },
        model: { type: "string", description: "Optional model alias/id for assistant chat (default: sonnet)." }
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
        canvas_state: { type: "object", description: "Optional current canvas state with nodes and connections" },
        agent_id: { type: "string", description: "Optional preferred orchestration agent (default: agent-builder)." },
        model: { type: "string", description: "Optional model alias/id for assistant chat (default: sonnet)." }
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
        connections: { type: "array", description: "Updated connections array (replaces existing)" },
        upsert_by_name: { type: "boolean", description: "If true, no-op when same-name workflow already matches requested definition." }
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
        data: { type: "object", description: "Data fields to merge into the node's existing data" },
        upsert_by_name: { type: "boolean", description: "If true, no-op when resulting workflow matches an existing same-name version." }
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
    description: "List available agents from the Agent Gateway. Supports targeted lookup by agent_id to avoid full-list scans.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max agents to return (default: 10)" },
        search: { type: "string", description: "Optional case-insensitive search on id/name/description." },
        agent_id: { type: "string", description: "Optional exact agent id for targeted lookup." }
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
        model: { type: "string", description: "Model: 'haiku', 'sonnet', or 'opus'" },
        max_tokens: { type: "number", description: "Optional max output tokens (default: unlimited)." },
        max_tool_calls: { type: "number", description: "Optional max tool calls for this request (default: unlimited)." },
        max_turns: { type: "number", description: "Optional max internal turns (default: unlimited)." },
        response_style: { type: "string", enum: ["concise", "detailed"], description: "Output verbosity style (default: concise)." },
        research_quality_policy: { type: "string", enum: ["none", "warn", "strict"], description: "Citation/source quality policy." },
        trusted_domains: { type: "array", description: "Preferred trusted source domains." },
        validate_citations: { type: "boolean", description: "Verify cited URLs via HTTP checks." },
        min_trusted_citations: { type: "number", description: "Strict-mode minimum trusted citations." }
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
        model: { type: "string", description: "Model: 'haiku', 'sonnet', or 'opus'" },
        wait_for_terminal_seconds: { type: "number", description: "How long to wait for terminal assistant output before returning still_running." },
        max_tokens: { type: "number", description: "Optional max output tokens." },
        max_tool_calls: { type: "number", description: "Optional max tool calls." },
        max_turns: { type: "number", description: "Optional max turns." },
        response_style: { type: "string", enum: ["concise", "detailed"], description: "Output verbosity style (default: concise)." },
        research_quality_policy: { type: "string", enum: ["none", "warn", "strict"], description: "Citation/source quality policy." },
        trusted_domains: { type: "array", description: "Preferred trusted source domains." },
        validate_citations: { type: "boolean", description: "Verify cited URLs via HTTP checks." },
        min_trusted_citations: { type: "number", description: "Strict-mode minimum trusted citations." }
      },
      required: ["agent_id", "session_id", "message"]
    }
  },
  {
    name: "agent_resume_session_async",
    description: "Resume an existing session asynchronously. Poll completion via agent_get_session_status.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        session_id: { type: "string", description: "Session ID to resume" },
        message: { type: "string", description: "Message to send" },
        model: { type: "string", description: "Model: 'haiku', 'sonnet', or 'opus'" },
        max_tokens: { type: "number", description: "Optional max output tokens." },
        max_tool_calls: { type: "number", description: "Optional max tool calls." },
        max_turns: { type: "number", description: "Optional max turns." },
        response_style: { type: "string", enum: ["concise", "detailed"], description: "Output verbosity style (default: concise)." },
        research_quality_policy: { type: "string", enum: ["none", "warn", "strict"], description: "Citation/source quality policy." },
        trusted_domains: { type: "array", description: "Preferred trusted source domains." },
        validate_citations: { type: "boolean", description: "Verify cited URLs via HTTP checks." },
        min_trusted_citations: { type: "number", description: "Strict-mode minimum trusted citations." }
      },
      required: ["agent_id", "session_id", "message"]
    }
  },
  {
    name: "agent_get_session_status",
    description: "Get status/result for agent_resume_session_async or a still_running resume request.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string", description: "Request ID returned by async resume APIs." }
      },
      required: ["request_id"]
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
        limit: { type: "number", description: "Max results (default: 5)" },
        cost_view: { type: "string", enum: ["summary", "full"], description: "summary (default) or full ledger entries." }
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

/** Parse an SSE payload string from canvas execution into a structured result. */
function parseSSEResult(sseText: string, options: ParsedSSEOptions = {}): ParsedSSEResult {
  const state: ParsedSSEResult = {
    runId: "",
    status: "unknown",
    results: {},
    logs: [],
    event_count: 0,
  };
  const nodeMetrics = new Map<string, NodeMetric>();

  for (const line of sseText.split(/\r?\n/)) {
    let event: any;
    try {
      event = parseSSELine(line);
    } catch {
      continue;
    }
    if (!event) continue;
    state.event_count += 1;
    applySSEEvent(state, event, options, nodeMetrics);
  }

  const metrics = finalizeNodeMetrics(nodeMetrics);
  state.per_node_metrics = metrics.perNodeMetrics;
  state.retry_summary = metrics.retrySummary;
  return state;
}

/** Parse an SSE HTTP response incrementally for better long-run observability. */
async function parseSSEResponse(response: Response, options: ParsedSSEOptions = {}): Promise<ParsedSSEResult> {
  if (!response.body) {
    return parseSSEResult(await response.text(), options);
  }

  const state: ParsedSSEResult = {
    runId: "",
    status: "unknown",
    results: {},
    logs: [],
    event_count: 0,
  };
  const nodeMetrics = new Map<string, NodeMetric>();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      let event: any;
      try {
        event = parseSSELine(line);
      } catch {
        continue;
      }
      if (!event) continue;
      state.event_count += 1;
      applySSEEvent(state, event, options, nodeMetrics);
    }
  }

  if (buffer.trim().length > 0) {
    try {
      const event = parseSSELine(buffer);
      if (event) {
        state.event_count += 1;
        applySSEEvent(state, event, options, nodeMetrics);
      }
    } catch {
      // ignore trailing partial line
    }
  }

  const metrics = finalizeNodeMetrics(nodeMetrics);
  state.per_node_metrics = metrics.perNodeMetrics;
  state.retry_summary = metrics.retrySummary;
  return state;
}

function findMatchingWorkflow(workflows: WorkflowLike[], workflowId?: string, workflowName?: string): WorkflowLike | null {
  if (!workflowId && !workflowName) return null;
  const targetId = workflowId?.trim();
  const targetName = workflowName?.trim().toLowerCase();
  for (const workflow of workflows) {
    const id = getWorkflowId(workflow);
    const name = typeof workflow.name === "string" ? workflow.name.trim().toLowerCase() : "";
    if (targetId && (id === targetId || name === targetId.toLowerCase())) return workflow;
    if (targetName && name === targetName) return workflow;
  }
  return null;
}

async function fetchWorkflows(headers: Record<string, string>, search?: string, limit?: number): Promise<WorkflowLike[]> {
  const params = new URLSearchParams();
  if (search) params.append("search", search);
  if (Number.isFinite(limit) && (limit as number) > 0) params.append("limit", String(limit));
  const query = params.toString();
  const url = `${CANVAS_API_URL}/canvas/workflows${query ? `?${query}` : ""}`;
  const response = await fetchWithTimeout(url, { headers }, 30000);
  if (!response.ok) {
    throw new Error(`Failed to load workflows: ${await response.text()}`);
  }
  const data = await response.json() as any;
  const workflows: WorkflowLike[] = Array.isArray(data?.workflows)
    ? data.workflows
    : Array.isArray(data)
      ? data
      : [];
  workflows.forEach(cacheWorkflow);
  return workflows;
}

async function findWorkflow(headers: Record<string, string>, workflowId?: string, workflowName?: string): Promise<WorkflowLike | null> {
  const cached = getCachedWorkflow(workflowId, workflowName);
  if (cached) return cached;

  const searchTerm = workflowName || workflowId;
  if (searchTerm) {
    const searched = await fetchWorkflows(headers, searchTerm, WORKFLOW_LOOKUP_LIMIT).catch(() => [] as WorkflowLike[]);
    const matchFromSearch = findMatchingWorkflow(searched, workflowId, workflowName);
    if (matchFromSearch) return matchFromSearch;
  }

  const workflows = await fetchWorkflows(headers, undefined, WORKFLOW_LOOKUP_LIMIT);
  return findMatchingWorkflow(workflows, workflowId, workflowName);
}

async function findWorkflowByNameExact(headers: Record<string, string>, workflowName?: string): Promise<WorkflowLike | null> {
  if (!workflowName) return null;
  const normalized = workflowName.trim().toLowerCase();
  if (!normalized) return null;

  const cached = getCachedWorkflow(undefined, workflowName);
  if (cached && String(cached.name || "").trim().toLowerCase() === normalized) return cached;

  const searched = await fetchWorkflows(headers, workflowName, WORKFLOW_LOOKUP_LIMIT).catch(() => [] as WorkflowLike[]);
  const exactFromSearch = searched.find((workflow) => String(workflow.name || "").trim().toLowerCase() === normalized);
  if (exactFromSearch) return exactFromSearch;

  const workflows = await fetchWorkflows(headers, undefined, WORKFLOW_LOOKUP_LIMIT);
  return workflows.find((workflow) => String(workflow.name || "").trim().toLowerCase() === normalized) || null;
}

function buildWorkflowExecutionRequest(
  workflow: WorkflowLike,
  args: Record<string, any>,
  searchTerm: string,
): Record<string, any> {
  const { nodes, edges } = parseWorkflowGraph(workflow, searchTerm);
  return {
    nodes: normalizeWorkflowNodes(nodes.map((n: any) => ({ id: n.id, type: n.type, data: n.data }))),
    connections: edges.map((e: any) => ({ source: e.source, target: e.target })),
    ...(args.inputs ? { inputs: args.inputs } : {}),
    ...(args.user_prompt ? { userPrompt: String(args.user_prompt) } : {}),
    ...(args.userPrompt ? { userPrompt: String(args.userPrompt) } : {}),
  };
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
      return await parseSSEResponse(response, {
        includeEvents: Boolean(args.include_events),
        includeLiveLogs: args.include_live_logs !== false,
        liveLogLimit: Number(args.live_log_limit || 300),
        streamProgress: Boolean(args.stream_progress),
      });
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
      const result = await parseSSEResponse(response, {
        includeLiveLogs: false,
        streamProgress: false,
      });
      return {
        runId: result.runId,
        status: result.status,
        message: `Workflow started. Use canvas_get_workflow_run("${result.runId}") to check status.`,
      };
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
      const upsertByName = Boolean(saveArgs.upsert_by_name);
      let previousWorkflowId: string | undefined;

      if (upsertByName && saveArgs.name) {
        const existing = await findWorkflowByNameExact(headers, String(saveArgs.name));
        previousWorkflowId = existing ? extractCanonicalWorkflowId(existing) : undefined;
        if (existing && sameWorkflowDefinition(existing, {
          name: saveArgs.name,
          description: saveArgs.description || "",
          nodes: saveArgs.nodes || [],
          connections: saveArgs.connections || [],
        })) {
          const existingId = extractCanonicalWorkflowId(existing);
          if (existingId) {
            return {
              success: true,
              upserted: true,
              version_created: false,
              canonical_workflow_id: existingId,
              previous_workflow_id: existingId,
              workflowName: saveArgs.name,
              message: "Existing workflow matched requested definition. Reused canonical workflow ID.",
            };
          }
        }
      }

      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
        { method: "POST", headers, body: JSON.stringify(saveArgs) },
        60000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const saved = await response.json() as any;
      const workflowId = await resolveCanonicalWorkflowId(headers, saved, String(saveArgs.name || ""));
      const syntheticWorkflow: WorkflowLike = {
        entityId: workflowId,
        workflowId,
        name: saveArgs.name,
        description: saveArgs.description || "",
        nodesJson: JSON.stringify(saveArgs.nodes || []),
        edgesJson: JSON.stringify(saveArgs.connections || []),
        createdAt: new Date().toISOString(),
      };
      cacheWorkflow(syntheticWorkflow);
      return {
        ...saved,
        success: true,
        canonical_workflow_id: workflowId,
        version_created: true,
        upserted: upsertByName,
        ...(previousWorkflowId ? { previous_workflow_id: previousWorkflowId } : {}),
      };
    }

    case "canvas_get_workflows": {
      const requestedLimit = args.limit || 10;
      const workflows = await fetchWorkflows(headers, args.search, Math.max(requestedLimit * 3, 30));

      // Merge with cache to bridge eventual consistency after save/update.
      pruneWorkflowCache();
      const cachedWorkflows = Array.from(workflowCacheById.values()).map((entry) => entry.workflow);
      const byId = new Map<string, WorkflowLike>();
      for (const wf of [...cachedWorkflows, ...workflows]) {
        const id = getWorkflowId(wf);
        if (id) byId.set(id, wf);
      }
      let merged = Array.from(byId.values());
      if (args.search) {
        const q = String(args.search).toLowerCase();
        merged = merged.filter((w: any) =>
          String(w.name || "").toLowerCase().includes(q) || String(w.description || "").toLowerCase().includes(q)
        );
      }
      const totalMatches = merged.length;
      merged = merged.slice(0, requestedLimit);

      // Strip verbose fields for compact output
      const compact = merged.map((w: any) => ({
        entityId: getWorkflowId(w),
        name: w.name,
        description: w.description || "",
        createdAt: w.createdAt,
        nodeCount: (() => { try { return (typeof w.nodesJson === "string" ? JSON.parse(w.nodesJson) : w.nodes || []).length; } catch { return 0; } })(),
      }));
      return { workflows: compact, count: compact.length, total: totalMatches };
    }

    case "run_saved_canvas_workflow": {
      const searchTerm = args.workflow_id || args.workflow_name || "unknown";
      const wf = await findWorkflow(headers, args.workflow_id, args.workflow_name);
      if (!wf) throw new Error(`Workflow "${searchTerm}" not found`);

      const request = buildWorkflowExecutionRequest(wf, args, searchTerm);

      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows/execute/stream`,
        { method: "POST", headers, body: JSON.stringify(request) },
        300000
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      return await parseSSEResponse(response, {
        includeEvents: Boolean(args.include_events),
        includeLiveLogs: args.include_live_logs !== false,
        liveLogLimit: Number(args.live_log_limit || 300),
        streamProgress: Boolean(args.stream_progress),
      });
    }

    case "run_workflow_and_wait": {
      const searchTerm = args.workflow_id || args.workflow_name || "unknown";
      const wf = await findWorkflow(headers, args.workflow_id, args.workflow_name);
      if (!wf) throw new Error(`Workflow "${searchTerm}" not found`);

      const request = buildWorkflowExecutionRequest(wf, args, searchTerm);

      const start = Date.now();
      const requestedWaitSeconds = Number(args.max_wait_seconds);
      const maxWaitSeconds = Number.isFinite(requestedWaitSeconds) ? requestedWaitSeconds : 0;
      const timeoutMs = maxWaitSeconds > 0 ? maxWaitSeconds * 1000 : undefined;

      const response = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows/execute/stream`,
        { method: "POST", headers, body: JSON.stringify(request) },
        timeoutMs
      );
      if (!response.ok) throw new Error(`API returned ${response.status}: ${await response.text()}`);
      const result = await parseSSEResponse(response, {
        includeEvents: Boolean(args.include_events),
        includeLiveLogs: args.include_live_logs !== false,
        liveLogLimit: Number(args.live_log_limit || 300),
        streamProgress: Boolean(args.stream_progress),
      });
      return {
        ...result,
        elapsed_seconds: Math.round((Date.now() - start) / 1000),
        max_wait_seconds: maxWaitSeconds > 0 ? maxWaitSeconds : null,
        poll_interval_seconds: args.poll_interval_seconds ?? null,
        stale_threshold_seconds: args.stale_threshold_seconds ?? null,
        event_cursor: typeof result.event_count === "number" ? Math.max(-1, result.event_count - 1) : -1,
      };
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
        error: run.error,
        per_node_metrics: (() => {
          const tail = runTailById.get(run.runId || args.run_id);
          if (!tail) return [];
          const nodeMetricMap = new Map<string, NodeMetric>();
          for (const event of tail.events) {
            const nodeId = event.node_id;
            if (!nodeId) continue;
            const metric = ensureNodeMetric(nodeMetricMap, nodeId);
            if (event.type === "node_started" && !metric.started_at) {
              metric.started_at = event.timestamp;
              metric.status = "running";
            }
            if (event.type === "node_retry") metric.retry_count += 1;
            if (event.type === "node_completed") {
              metric.status = "completed";
              metric.ended_at = event.timestamp;
              if (metric.started_at && metric.ended_at) {
                metric.duration_ms = Math.max(0, new Date(metric.ended_at).getTime() - new Date(metric.started_at).getTime());
              }
            }
            if (event.type === "node_failed") {
              metric.status = "failed";
              metric.ended_at = event.timestamp;
            }
          }
          return finalizeNodeMetrics(nodeMetricMap).perNodeMetrics;
        })()
      };
    }

    case "canvas_tail_run": {
      pruneRunTailCache();
      const runId = String(args.run_id);
      const tail = runTailById.get(runId);
      if (!tail) {
        return {
          run_id: runId,
          status: "unknown",
          events: [],
          next_index: Number(args.after_index ?? -1) + 1,
          message: "No in-memory tail data found for this run. Ensure run was started via this MCP server.",
        };
      }
      const afterIndex = Number.isFinite(Number(args.after_index)) ? Number(args.after_index) : -1;
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 100;
      const events = tail.events.filter((event) => event.index > afterIndex).slice(0, limit);
      const lastEvent = events.length ? events[events.length - 1] : null;
      return {
        run_id: runId,
        status: tail.status,
        events,
        next_index: lastEvent ? lastEvent.index + 1 : afterIndex + 1,
        has_more: tail.events.some((event) => event.index > (lastEvent?.index ?? afterIndex)),
        last_updated_at: new Date(tail.last_updated_at).toISOString(),
      };
    }

    case "canvas_ai_assistant":
    case "canvas_ai_assistant_voice": {
      // Use agent chat endpoint with a structured prompt
      const userMessage = name === "canvas_ai_assistant_voice" ? args.transcription : args.message;
      if (!userMessage) throw new Error("Message or transcription is required");
      const preferredAgentId = String(args.agent_id || "agent-builder");
      const model = normalizeGatewayModelName(args.model || "sonnet", "sonnet");

      // Resolve a suitable agent without pulling the full catalog unless needed.
      let agent: any | null = null;
      const candidateIds = [preferredAgentId, "agent-builder", "workflow-orchestration-agent", "code-assistant"];
      for (const candidateId of candidateIds) {
        try {
          const detailResponse = await fetchWithTimeout(
            `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(candidateId)}`,
            { headers: { "Content-Type": "application/json", ...(token ? { "Authorization": `Bearer ${token}` } : {}) } },
            15000
          );
          if (!detailResponse.ok) continue;
          const detail = await detailResponse.json() as any;
          if (!detail?.requiredSecrets?.length) {
            agent = detail;
            break;
          }
        } catch {
          // fall through to the next candidate
        }
      }

      if (!agent) {
        const agentsResponse = await fetchWithTimeout(
          `${AGENT_GATEWAY_URL}/agents`,
          { headers: { "Content-Type": "application/json", ...(token ? { "Authorization": `Bearer ${token}` } : {}) } },
          15000
        );
        if (!agentsResponse.ok) throw new Error(`Failed to list agents: ${agentsResponse.status}`);
        const agentsData = await agentsResponse.json() as any;
        const agents = agentsData.agents || [];
        agent = agents.find((a: any) => a.id === preferredAgentId) || agents.find((a: any) => !a.requiredSecrets?.length) || agents[0];
      }
      if (!agent?.id) throw new Error("No agents available for AI assistant");

      // Build the prompt
      let prompt = CANVAS_AI_SYSTEM_PROMPT + "\n\n";
      if (args.canvas_state) {
        prompt += `Current canvas state:\n${JSON.stringify(args.canvas_state, null, 2)}\n\n`;
      }
      prompt += `User request: ${userMessage}`;

      // Create session and chat
      const sessionResponse = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agent.id)}/sessions`,
        { method: "POST", headers, body: JSON.stringify({ model }) },
        15000
      );
      if (!sessionResponse.ok) throw new Error(`Failed to create session: ${sessionResponse.status}`);
      const sessionData = await sessionResponse.json() as any;

      const chatResponse = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agent.id)}/sessions/${encodeURIComponent(sessionData.id)}/chat`,
        { method: "POST", headers: { ...headers, "Accept": "text/event-stream" }, body: JSON.stringify({ message: prompt, model }) },
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
      const wf = await findWorkflow(headers, args.workflow_id, args.workflow_id);
      if (!wf) {
        throw new Error(`Workflow "${args.workflow_id}" not found. If recently saved, try again in a few seconds.`);
      }

      const { nodes: existingNodes, edges: existingEdges } = parseWorkflowGraph(wf, String(args.workflow_id));

      const updatedNodes = args.nodes ? normalizeWorkflowNodes(args.nodes) : existingNodes;
      const savePayload: Record<string, any> = {
        name: args.name || wf.name,
        description: args.description !== undefined ? args.description : (wf.description || ""),
        nodes: updatedNodes,
        connections: args.connections || existingEdges.map((e: any) => ({ source: e.source, target: e.target }))
      };

      if (args.upsert_by_name && sameWorkflowDefinition(wf, savePayload)) {
        const existingId = extractCanonicalWorkflowId(wf);
        if (!existingId) throw new Error(`Workflow "${args.workflow_id}" resolved but has no canonical ID.`);
        return {
          success: true,
          upserted: true,
          version_created: false,
          canonical_workflow_id: existingId,
          previous_workflow_id: existingId,
          name: savePayload.name,
          message: "Workflow already matches requested changes. No new version created."
        };
      }

      const saveResponse = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
        { method: "POST", headers, body: JSON.stringify(savePayload) },
        60000
      );
      if (!saveResponse.ok) throw new Error(`Failed to save workflow: ${await saveResponse.text()}`);
      const saved = await saveResponse.json() as any;
      const canonicalWorkflowId = await resolveCanonicalWorkflowId(headers, saved, String(savePayload.name || ""));
      cacheWorkflow({
        entityId: canonicalWorkflowId,
        workflowId: canonicalWorkflowId,
        name: savePayload.name,
        description: savePayload.description,
        nodesJson: JSON.stringify(savePayload.nodes || []),
        edgesJson: JSON.stringify(savePayload.connections || []),
      });

      return {
        success: true,
        previous_workflow_id: args.workflow_id,
        canonical_workflow_id: canonicalWorkflowId,
        version_created: true,
        upserted: Boolean(args.upsert_by_name),
        name: savePayload.name,
        message: "Saved as new version (Geo storage is immutable). Use canonical_workflow_id for future references."
      };
    }

    case "update_workflow_node": {
      const wf = await findWorkflow(headers, args.workflow_id, args.workflow_id);
      if (!wf) {
        throw new Error(`Workflow "${args.workflow_id}" not found. If recently saved, try again in a few seconds.`);
      }

      const { nodes, edges } = parseWorkflowGraph(wf, String(args.workflow_id));

      const targetNode = nodes.find((n: any) => n.id === args.node_id);
      if (!targetNode) throw new Error(`Node "${args.node_id}" not found in workflow "${args.workflow_id}"`);

      // Apply updates
      if (args.type) targetNode.type = args.type;
      if (args.position) targetNode.position = args.position;
      if (args.data) {
        targetNode.data = { ...targetNode.data, ...args.data };
        // Normalize model name if updated
        if (targetNode.data.model) targetNode.data.model = normalizeCanvasModelName(targetNode.data.model);
      }

      const savePayload = {
        name: wf.name,
        description: wf.description || "",
        nodes,
        connections: edges.map((e: any) => ({ source: e.source, target: e.target }))
      };

      if (args.upsert_by_name && sameWorkflowDefinition(wf, savePayload)) {
        const existingId = extractCanonicalWorkflowId(wf);
        if (!existingId) throw new Error(`Workflow "${args.workflow_id}" resolved but has no canonical ID.`);
        return {
          success: true,
          upserted: true,
          version_created: false,
          canonical_workflow_id: existingId,
          previous_workflow_id: existingId,
          updated_node_id: args.node_id,
          message: "Node changes produced no effective workflow diff. Reused existing workflow ID."
        };
      }

      const saveResponse = await fetchWithTimeout(
        `${CANVAS_API_URL}/canvas/workflows`,
        { method: "POST", headers, body: JSON.stringify(savePayload) },
        60000
      );
      if (!saveResponse.ok) throw new Error(`Failed to save workflow: ${await saveResponse.text()}`);
      const saved = await saveResponse.json() as any;
      const canonicalWorkflowId = await resolveCanonicalWorkflowId(headers, saved, String(savePayload.name || ""));
      cacheWorkflow({
        entityId: canonicalWorkflowId,
        workflowId: canonicalWorkflowId,
        name: savePayload.name,
        description: savePayload.description,
        nodesJson: JSON.stringify(savePayload.nodes || []),
        edgesJson: JSON.stringify(savePayload.connections || []),
      });

      return {
        success: true,
        previous_workflow_id: args.workflow_id,
        canonical_workflow_id: canonicalWorkflowId,
        version_created: true,
        upserted: Boolean(args.upsert_by_name),
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
  const authHeaders: Record<string, string> = token
    ? { "Content-Type": "application/json", "Authorization": `Bearer ${token}` }
    : { "Content-Type": "application/json" };

  const parseAgentChatResponse = (responseText: string): { text: string; cost?: string; terminal: boolean } => {
    let accumulatedText = "";
    let cost: string | undefined;
    let terminal = false;

    const isSSE = responseText.includes("data: ") || responseText.includes("data:");
    if (isSSE) {
      for (const line of responseText.split(/\r?\n/)) {
        if (!line.startsWith("data: ") && !line.startsWith("data:")) continue;
        const dataStr = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
        if (dataStr === "[DONE]") {
          terminal = true;
          break;
        }
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
          if (event.type === "done" || event.type === "message_stop" || event.type === "completed") {
            terminal = true;
          }
          if (event.type === "error") {
            throw new Error(`Agent error: ${event.data?.message || JSON.stringify(event.data)}`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Agent error:")) throw e;
          console.error("[sse] Dropped malformed SSE line:", dataStr?.slice(0, 200));
        }
      }
    } else {
      try {
        const jsonResp = JSON.parse(responseText) as any;
        accumulatedText = jsonResp.text || jsonResp.response || jsonResp.content || responseText;
        cost = jsonResp.cost;
        terminal = true;
      } catch {
        accumulatedText = responseText;
        terminal = true;
      }
    }

    if (!accumulatedText && responseText.length > 0) {
      accumulatedText = `[No text extracted from response. Raw length: ${responseText.length}, starts with: ${responseText.slice(0, 100)}]`;
    }

    return { text: accumulatedText, cost, terminal };
  };

  const createSession = async (agentId: string, modelInput?: string): Promise<string> => {
    const model = normalizeGatewayModelName(modelInput, "haiku");
    const sessionResponse = await fetchWithTimeout(
      `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agentId)}/sessions`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model }),
      },
      15000
    );
    if (!sessionResponse.ok) {
      throw new Error(`Failed to create session: ${sessionResponse.status} ${await sessionResponse.text()}`);
    }
    const sessionData = await sessionResponse.json() as any;
    if (!sessionData?.id) throw new Error("Failed to create session: missing session id.");
    return sessionData.id;
  };

  const getSession = async (agentId: string, sessionId: string): Promise<any> => {
    const response = await fetchWithTimeout(
      `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
      { headers: authHeaders },
      15000
    );
    if (!response.ok) throw new Error(`Failed to get session: ${response.status} ${await response.text()}`);
    return await response.json();
  };

  const normalizeMessageContent = (content: any): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((item) => normalizeMessageContent(item)).filter(Boolean).join("\n");
    if (content && typeof content === "object") {
      if (typeof content.text === "string") return content.text;
      if (typeof content.content === "string") return content.content;
    }
    return "";
  };

  const extractTerminalAssistantMessage = (messages: any[], sinceMs: number): string | null => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (String(message?.role || "") !== "assistant") continue;
      if (message?.toolUse || (Array.isArray(message?.toolUses) && message.toolUses.length > 0)) continue;
      const timestampRaw = message?.timestamp;
      const timestampMs = typeof timestampRaw === "number"
        ? timestampRaw
        : (typeof timestampRaw === "string" ? Date.parse(timestampRaw) : 0);
      if (Number.isFinite(timestampMs) && timestampMs < sinceMs) continue;
      const text = normalizeMessageContent(message?.content);
      if (text) return text;
    }
    return null;
  };

  const evaluateCitationReport = async (
    text: string,
    agentId: string,
    requestArgs: Record<string, any>,
  ): Promise<{ report?: CitationReport; warnings: string[]; strictError?: string }> => {
    const policy = normalizeResearchQualityPolicy(requestArgs.research_quality_policy, agentId);
    if (policy === "none") return { warnings: [] };

    const trustedDomains = normalizeTrustedDomains(requestArgs.trusted_domains);
    const urls = extractCitationUrls(text);
    const urlsToValidate = urls.slice(0, MAX_CITATION_VALIDATIONS);
    const warnings: string[] = [];
    if (urls.length > MAX_CITATION_VALIDATIONS) {
      warnings.push(`Validated first ${MAX_CITATION_VALIDATIONS} citations out of ${urls.length} total.`);
    }

    const shouldValidate = requestArgs.validate_citations !== undefined
      ? Boolean(requestArgs.validate_citations)
      : true;

    const flags: CitationFlag[] = [];
    for (const url of urlsToValidate) {
      let domain = "unknown";
      try {
        domain = new URL(url).hostname.toLowerCase();
      } catch {
        flags.push({ url, domain, trusted: false, verified: false, reason: "invalid_url" });
        continue;
      }
      const trusted = domainMatchesTrusted(domain, trustedDomains);
      if (!shouldValidate) {
        flags.push({ url, domain, trusted, verified: true });
        continue;
      }
      const verification = await verifyCitationUrl(url);
      flags.push({
        url,
        domain,
        trusted,
        verified: verification.verified,
        ...(verification.reason ? { reason: verification.reason } : {}),
      });
    }

    const trustedCount = flags.filter((flag) => flag.trusted && flag.verified).length;
    const unverifiedCount = flags.filter((flag) => !flag.verified).length;
    const report: CitationReport = {
      policy,
      trusted_domains: trustedDomains,
      total_citations: urls.length,
      trusted_count: trustedCount,
      unverified_count: unverifiedCount,
      flags: flags.filter((flag) => !flag.trusted || !flag.verified),
    };

    if (policy === "warn") {
      if (report.flags.length > 0) {
        warnings.push(`Citation quality warnings: ${report.flags.length} citation(s) are untrusted or unverified.`);
      }
      return { report, warnings };
    }

    const minTrusted = parsePositiveNumber(requestArgs.min_trusted_citations) || 1;
    if (unverifiedCount > 0 || trustedCount < minTrusted) {
      return {
        report,
        warnings,
        strictError: `Strict citation policy failed: trusted_count=${trustedCount}, min_trusted_citations=${minTrusted}, unverified_count=${unverifiedCount}.`,
      };
    }
    return { report, warnings };
  };

  const sendChat = async (
    agentId: string,
    sessionId: string,
    message: string,
    modelInput?: string,
    requestArgs?: Record<string, any>,
    timeoutMs?: number,
  ): Promise<{ text: string; cost?: string; terminal: boolean }> => {
    const model = normalizeGatewayModelName(modelInput, "haiku");
    const costControls = resolveAgentCostControls(requestArgs || {});
    const body: Record<string, any> = { message, model };
    if (costControls.max_tokens) body.maxTokens = costControls.max_tokens;
    if (costControls.max_tool_calls) body.maxToolCalls = costControls.max_tool_calls;
    if (costControls.max_turns) body.maxTurns = costControls.max_turns;
    const chatResponse = await fetchWithTimeout(
      `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/chat`,
      {
        method: "POST",
        headers: { ...authHeaders, "Accept": "text/event-stream" },
        body: JSON.stringify(body),
      },
      timeoutMs ?? 300000
    );
    if (!chatResponse.ok) {
      throw new Error(`Chat failed: ${chatResponse.status} ${await chatResponse.text()}`);
    }
    const responseText = await chatResponse.text();
    return parseAgentChatResponse(responseText);
  };

  const finalizeAgentText = async (
    text: string,
    agentId: string,
    requestArgs: Record<string, any>,
  ): Promise<{
    text: string;
    response_style: "concise" | "detailed";
    truncated: boolean;
    citation_report?: CitationReport;
    warnings?: string[];
  }> => {
    const controls = resolveAgentCostControls(requestArgs);
    const styled = applyResponseStyle(text, controls.response_style);
    const citationEval = await evaluateCitationReport(styled.text, agentId, requestArgs);
    if (citationEval.strictError) {
      throw new Error(citationEval.strictError);
    }
    return {
      text: styled.text,
      response_style: controls.response_style || "concise",
      truncated: styled.truncated,
      ...(citationEval.report ? { citation_report: citationEval.report } : {}),
      ...(citationEval.warnings.length ? { warnings: citationEval.warnings } : {}),
    };
  };

  const pollResumeRequestUntilTerminal = async (
    request: AgentResumeStatusRequest,
    requestArgs: Record<string, any>,
    sinceMs: number,
  ): Promise<void> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < AGENT_STATUS_POLL_MAX_MS) {
      try {
        const session = await getSession(request.agent_id, request.session_id);
        const terminalText = extractTerminalAssistantMessage(Array.isArray(session?.messages) ? session.messages : [], sinceMs);
        if (terminalText) {
          const finalized = await finalizeAgentText(terminalText, request.agent_id, requestArgs);
          updateAgentResumeRequest(request.request_id, {
            status: "completed",
            final_text: finalized.text,
            partial_text: finalized.text,
            next_action: undefined,
          });
          return;
        }
      } catch (pollError) {
        updateAgentResumeRequest(request.request_id, {
          status: "failed",
          error: pollError instanceof Error ? pollError.message : String(pollError),
          next_action: undefined,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, AGENT_STATUS_POLL_INTERVAL_MS));
    }

    updateAgentResumeRequest(request.request_id, {
      status: "still_running",
      next_action: "Call agent_get_session_status with this request_id to continue polling.",
    });
  };

  const executeResume = async (
    requestArgs: Record<string, any>,
  ): Promise<{
    status: "completed" | "still_running";
    session_id: string;
    previous_session_id?: string;
    recovered?: boolean;
    text?: string;
    cost?: string;
    response_style?: "concise" | "detailed";
    truncated?: boolean;
    citation_report?: CitationReport;
    warnings?: string[];
  }> => {
    const agentId = String(requestArgs.agent_id);
    const sessionId = String(requestArgs.session_id);
    const model = normalizeGatewayModelName(requestArgs.model, "haiku");
    const qualityPolicy = normalizeResearchQualityPolicy(requestArgs.research_quality_policy, agentId);
    const trustedDomains = normalizeTrustedDomains(requestArgs.trusted_domains);
    const policyPrompt = buildResearchPolicyPrompt(qualityPolicy, trustedDomains);
    const outboundMessage = policyPrompt ? `${String(requestArgs.message)}\n${policyPrompt}` : String(requestArgs.message);
    const waitSeconds = parsePositiveNumber(requestArgs.wait_for_terminal_seconds) || AGENT_RESUME_WAIT_SECONDS;
    const timeoutMs = waitSeconds * 1000;

    try {
      const chat = await sendChat(agentId, sessionId, outboundMessage, model, requestArgs, timeoutMs);
      if (!chat.terminal) {
        return { status: "still_running", session_id: sessionId, text: chat.text, cost: chat.cost };
      }
      const finalized = await finalizeAgentText(chat.text, agentId, requestArgs);
      return {
        status: "completed",
        session_id: sessionId,
        text: finalized.text,
        cost: chat.cost,
        response_style: finalized.response_style,
        truncated: finalized.truncated,
        citation_report: finalized.citation_report,
        warnings: finalized.warnings,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { status: "still_running", session_id: sessionId };
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!isSessionMismatchError(errorMessage)) throw error;

      // Recovery path for corrupted tool-use history: start a fresh session and continue.
      const sessionDetailsResponse = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
        { headers: authHeaders },
        15000
      );
      let contextSummary = "";
      if (sessionDetailsResponse.ok) {
        const details = await sessionDetailsResponse.json() as any;
        const recentMessages: any[] = Array.isArray(details?.messages) ? details.messages.slice(-6) : [];
        const summarized = recentMessages
          .map((m: any) => `${m.role || "unknown"}: ${String(m.content || "").slice(0, 280)}`)
          .join("\n");
        if (summarized) contextSummary = summarized;
      }

      const recoveredSessionId = await createSession(agentId, model);
      const recoveryPrompt = [
        "Continue the previous session after a transport state reset.",
        contextSummary ? `Recent context:\n${contextSummary}` : "Recent context unavailable.",
        `User follow-up:\n${String(requestArgs.message)}`,
        policyPrompt ? `\n${policyPrompt}` : "",
      ].join("\n\n");

      const recoveredChat = await sendChat(agentId, recoveredSessionId, recoveryPrompt, model, requestArgs, timeoutMs);
      if (!recoveredChat.terminal) {
        return {
          status: "still_running",
          session_id: recoveredSessionId,
          previous_session_id: sessionId,
          recovered: true,
          text: recoveredChat.text,
          cost: recoveredChat.cost,
        };
      }
      const finalized = await finalizeAgentText(recoveredChat.text, agentId, requestArgs);
      return {
        status: "completed",
        session_id: recoveredSessionId,
        previous_session_id: sessionId,
        recovered: true,
        text: finalized.text,
        cost: recoveredChat.cost,
        response_style: finalized.response_style,
        truncated: finalized.truncated,
        citation_report: finalized.citation_report,
        warnings: finalized.warnings,
      };
    }
  };

  switch (name) {
    case "agent_list": {
      if (args.agent_id) {
        const response = await fetchWithTimeout(
          `${AGENT_GATEWAY_URL}/agents/${encodeURIComponent(String(args.agent_id))}`,
          { headers: authHeaders },
          15000
        );
        if (response.ok) {
          const agent = await response.json() as any;
          return {
            success: true,
            agents: [{
              id: agent.id,
              name: agent.name,
              description: (agent.description || "").slice(0, 120),
              model: agent.model,
              requiredSecrets: agent.requiredSecrets,
            }],
            count: 1,
            total: 1,
            targeted: true,
          };
        }
      }

      const response = await fetchWithTimeout(
        `${AGENT_GATEWAY_URL}/agents`,
        { headers: authHeaders },
        15000
      );
      if (!response.ok) throw new Error(`Agent Gateway returned ${response.status}: ${await response.text()}`);
      const data = await response.json() as any;
      const allAgents = data.agents || [];
      let filteredAgents = allAgents;
      if (args.search) {
        const q = String(args.search).toLowerCase();
        filteredAgents = allAgents.filter((a: any) =>
          String(a.id || "").toLowerCase().includes(q) ||
          String(a.name || "").toLowerCase().includes(q) ||
          String(a.description || "").toLowerCase().includes(q)
        );
      }
      const limit = args.limit || 10;
      const agents = filteredAgents.slice(0, limit).map((a: any) => ({
        id: a.id,
        name: a.name,
        description: (a.description || "").slice(0, 120),
        model: a.model,
        requiredSecrets: a.requiredSecrets,
      }));
      return { success: true, agents, count: agents.length, total: filteredAgents.length };
    }

    case "agent_create_session": {
      if (!token) return { success: false, error: "No auth token available." };
      const normalizedModel = normalizeGatewayModelName(args.model, "haiku");
      const sessionId = await createSession(String(args.agent_id), normalizedModel);
      return { success: true, session_id: sessionId, agent_id: args.agent_id, model: normalizedModel };
    }

    case "agent_chat": {
      if (!token) return { success: false, error: "No auth token available." };
      const { agent_id, message, session_id } = args;
      const model = normalizeGatewayModelName(args.model, "haiku");
      const qualityPolicy = normalizeResearchQualityPolicy(args.research_quality_policy, String(agent_id));
      const trustedDomains = normalizeTrustedDomains(args.trusted_domains);
      const policyPrompt = buildResearchPolicyPrompt(qualityPolicy, trustedDomains);
      const outboundMessage = policyPrompt ? `${String(message)}\n${policyPrompt}` : String(message);

      // Get or create session
      let sessionId = session_id;
      if (!sessionId) {
        sessionId = await createSession(String(agent_id), model);
      }

      const chat = await sendChat(String(agent_id), String(sessionId), outboundMessage, model, args);
      const finalized = await finalizeAgentText(chat.text, String(agent_id), args);

      return {
        success: true,
        agent_id,
        session_id: sessionId,
        text: finalized.text,
        cost: chat.cost,
        response_style: finalized.response_style,
        truncated: finalized.truncated,
        ...(finalized.citation_report ? { citation_report: finalized.citation_report } : {}),
        ...(finalized.warnings?.length ? { warnings: finalized.warnings } : {}),
        terminal: chat.terminal,
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
      const requestStartedAt = Date.now();
      const resumeResult = await executeResume(args);
      if (resumeResult.status === "completed") {
        return {
          success: true,
          status: "completed",
          agent_id: args.agent_id,
          session_id: resumeResult.session_id,
          ...(resumeResult.previous_session_id ? { previous_session_id: resumeResult.previous_session_id } : {}),
          recovered: Boolean(resumeResult.recovered),
          text: resumeResult.text,
          cost: resumeResult.cost,
          response_style: resumeResult.response_style,
          truncated: resumeResult.truncated,
          ...(resumeResult.citation_report ? { citation_report: resumeResult.citation_report } : {}),
          ...(resumeResult.warnings?.length ? { warnings: resumeResult.warnings } : {}),
          message: `Session "${resumeResult.session_id}" resumed.`,
        };
      }

      const request = createAgentResumeRequest(String(args.agent_id), String(resumeResult.session_id), String(args.message));
      updateAgentResumeRequest(request.request_id, {
        status: "still_running",
        partial_text: resumeResult.text,
        cost: resumeResult.cost,
        recovered: Boolean(resumeResult.recovered),
        previous_session_id: resumeResult.previous_session_id,
        next_action: "Call agent_get_session_status with request_id for completion.",
      });
      void pollResumeRequestUntilTerminal(request, args, requestStartedAt);

      return {
        success: true,
        status: "still_running",
        request_id: request.request_id,
        agent_id: args.agent_id,
        session_id: resumeResult.session_id,
        ...(resumeResult.previous_session_id ? { previous_session_id: resumeResult.previous_session_id } : {}),
        recovered: Boolean(resumeResult.recovered),
        partial_text: resumeResult.text,
        cost: resumeResult.cost,
        next_action: `Call agent_get_session_status with request_id="${request.request_id}" to poll.`,
      };
    }

    case "agent_resume_session_async": {
      if (!token) return { success: false, error: "No auth token available." };
      const request = createAgentResumeRequest(String(args.agent_id), String(args.session_id), String(args.message));
      updateAgentResumeRequest(request.request_id, { status: "running" });

      void (async () => {
        const startedAt = Date.now();
        try {
          const result = await executeResume(args);
          if (result.status === "completed") {
            updateAgentResumeRequest(request.request_id, {
              status: "completed",
              session_id: result.session_id,
              previous_session_id: result.previous_session_id,
              recovered: Boolean(result.recovered),
              partial_text: result.text,
              final_text: result.text,
              cost: result.cost,
              next_action: undefined,
            });
            return;
          }

          updateAgentResumeRequest(request.request_id, {
            status: "still_running",
            session_id: result.session_id,
            previous_session_id: result.previous_session_id,
            recovered: Boolean(result.recovered),
            partial_text: result.text,
            cost: result.cost,
            next_action: "Call agent_get_session_status with this request_id to continue polling.",
          });
          const refreshed = agentResumeRequestsById.get(request.request_id);
          if (refreshed) {
            await pollResumeRequestUntilTerminal(refreshed, args, startedAt);
          }
        } catch (runError) {
          updateAgentResumeRequest(request.request_id, {
            status: "failed",
            error: runError instanceof Error ? runError.message : String(runError),
            next_action: undefined,
          });
        }
      })();

      return {
        success: true,
        request_id: request.request_id,
        status: "running",
        agent_id: request.agent_id,
        session_id: request.session_id,
        message: `Async resume started. Poll with agent_get_session_status(request_id="${request.request_id}").`,
      };
    }

    case "agent_get_session_status": {
      if (!token) return { success: false, error: "No auth token available." };
      pruneAgentResumeStatusCache();
      const request = agentResumeRequestsById.get(String(args.request_id));
      if (!request) {
        return {
          success: false,
          request_id: args.request_id,
          error: "Request not found or expired.",
        };
      }
      return {
        success: true,
        request_id: request.request_id,
        status: request.status,
        agent_id: request.agent_id,
        session_id: request.session_id,
        ...(request.previous_session_id ? { previous_session_id: request.previous_session_id } : {}),
        recovered: Boolean(request.recovered),
        partial_text: request.partial_text,
        final_text: request.final_text,
        cost: request.cost,
        error: request.error,
        next_action: request.next_action,
        created_at: request.created_at,
        updated_at: request.updated_at,
      };
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
      if (card.capabilities && !Array.isArray(card.capabilities)) {
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
      const transactions = (txData.transactions || txData || []).slice(0, args.limit || 5);
      const costView = String(args.cost_view || "summary").toLowerCase();

      if (costView === "full") {
        return {
          transactions,
          count: transactions.length,
          ...(typeof txData.total === "number" ? { total: txData.total } : {}),
          ...(typeof txData.hasMore === "boolean" ? { hasMore: txData.hasMore } : {}),
        };
      }

      const byAgent: Record<string, { spend: number; tx_count: number; tool_calls: number }> = {};
      let totalSpend = 0;
      let totalToolCost = 0;
      let totalToolCalls = 0;
      for (const tx of transactions) {
        const amount = Number(tx?.amount || 0);
        const toolCost = Number(tx?.toolCost || 0);
        const toolCalls = Number(tx?.toolCallCount || 0);
        totalSpend += Number.isFinite(amount) ? amount : 0;
        totalToolCost += Number.isFinite(toolCost) ? toolCost : 0;
        totalToolCalls += Number.isFinite(toolCalls) ? toolCalls : 0;
        const agentId = String(tx?.agentId || "unknown");
        byAgent[agentId] = byAgent[agentId] || { spend: 0, tx_count: 0, tool_calls: 0 };
        byAgent[agentId].spend += Number.isFinite(amount) ? amount : 0;
        byAgent[agentId].tx_count += 1;
        byAgent[agentId].tool_calls += Number.isFinite(toolCalls) ? toolCalls : 0;
      }

      return {
        count: transactions.length,
        summary: {
          total_spend: totalSpend,
          total_tool_cost: totalToolCost,
          total_tool_calls: totalToolCalls,
          by_agent: byAgent,
        },
        ...(typeof txData.total === "number" ? { total: txData.total } : {}),
        ...(typeof txData.hasMore === "boolean" ? { hasMore: txData.hasMore } : {}),
      };
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

// OAuth 2.0 provider — bridges MCP SDK's OAuth framework to wallet tokens
const oauthProvider = new RickydataOAuthProvider();
const serverBaseUrl = new URL(SERVER_BASE_URL);
const resourceMetadataUrl = `${SERVER_BASE_URL}/.well-known/oauth-protected-resource/mcp`;

app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl: serverBaseUrl,
  baseUrl: serverBaseUrl,
  resourceServerUrl: new URL(`${SERVER_BASE_URL}/mcp`),
  resourceName: "rickydata MCP Server",
}));

// Custom OAuth endpoints for marketplace login flow
app.post("/oauth/complete", oauthCompleteHandler());
app.get("/oauth/callback", oauthCallbackHandler());

// Auth middleware — uses SDK's requireBearerAuth which returns proper WWW-Authenticate
// headers on 401 (required by Claude.ai). Validates wallet tokens via oauthProvider.verifyAccessToken.
const authMiddleware = requireBearerAuth({
  verifier: oauthProvider,
  resourceMetadataUrl,
});

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
  pruneRunTailCache(now);
  pruneAgentResumeStatusCache(now);
  pruneOAuthStores(now);
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

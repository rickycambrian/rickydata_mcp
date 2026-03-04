/**
 * Marketplace Module - MCP Gateway Integration
 *
 * Manages dynamic tool discovery and enabling/disabling of MCP servers
 * from the rickydata marketplace via the MCP Gateway.
 *
 * Gateway URL: https://mcp.rickydata.org/mcp
 * Auth: wallet token (mcpwt_ prefix) via Authorization header
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

interface GatewayToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

interface EnabledServer {
  server_id: string;
  server_name: string;
  gateway_prefix: string; // e.g. "io-github-brave-brave-search-mcp-server"
  tools: GatewayToolDefinition[];
  enabled_at: string;
}

interface RelayInfo {
  mode?: string;
  payerAddress?: string;
  requiredBaseUnits?: string;
  availableBaseUnits?: string;
  topUpUrl?: string;
}

interface ProviderHealthState {
  healthy: boolean;
  lastError?: string;
  lastFailureAt?: number;
  cooldownUntil?: number;
}

class GatewayPaymentRequiredError extends Error {
  relay?: RelayInfo;

  constructor(message: string, relay?: RelayInfo) {
    super(message);
    this.name = "GatewayPaymentRequiredError";
    this.relay = relay;
  }
}

const GATEWAY_URL = "https://mcp.rickydata.org/mcp";
const MCP_DISABLE_TIMEOUTS = process.env.MCP_DISABLE_TIMEOUTS !== "false";
const MCP_HTTP_TIMEOUT_MS = parseInt(process.env.MCP_HTTP_TIMEOUT_MS || "0", 10);
const PROVIDER_HEALTH_COOLDOWN_MS = parseInt(process.env.RESEARCH_PROVIDER_HEALTH_TTL_MS || "600000", 10);

export const MARKETPLACE_TOOLS = [
  {
    name: "marketplace_search",
    description: "Search for MCP servers available on the rickydata marketplace.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (e.g., 'weather', 'crypto', 'github')" },
        category: { type: "string", description: "Filter by category" },
        limit: { type: "number", description: "Max results (default 20)" }
      },
      required: ["query"]
    }
  },
  {
    name: "marketplace_server_info",
    description: "Get detailed information about a specific MCP server including its tools and configuration.",
    inputSchema: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "Server ID or name" }
      },
      required: ["server_id"]
    }
  },
  {
    name: "marketplace_enable_server",
    description: "Enable an MCP server from the marketplace. Adds its tools to the current session.",
    inputSchema: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "Server ID or name to enable" }
      },
      required: ["server_id"]
    }
  },
  {
    name: "marketplace_disable_server",
    description: "Disable a previously enabled MCP server. Removes its tools from the current session.",
    inputSchema: {
      type: "object",
      properties: {
        server_id: { type: "string", description: "Server ID or name to disable" }
      },
      required: ["server_id"]
    }
  },
  {
    name: "marketplace_list_enabled",
    description: "List all currently enabled MCP servers and their tools in this session.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

export class MarketplaceManager {
  private enabledServers: Map<string, EnabledServer> = new Map();
  private dynamicTools: GatewayToolDefinition[] = [];
  private server: Server | null = null;
  private currentUserToken: string = "";
  private providerHealth: Map<string, ProviderHealthState> = new Map();

  setServer(server: Server): void {
    this.server = server;
  }

  getDynamicTools(): GatewayToolDefinition[] {
    return this.dynamicTools;
  }

  setUserToken(token: string): void {
    this.currentUserToken = token;
  }

  getUserToken(): string {
    return this.currentUserToken;
  }

  private providerKeyForServer(server: EnabledServer): string {
    const composite = `${server.server_name} ${server.gateway_prefix}`.toLowerCase();
    if (composite.includes("exa")) return "exa";
    if (composite.includes("brave")) return "brave";
    return server.server_id.toLowerCase();
  }

  private getProviderHealth(providerKey: string): ProviderHealthState {
    const existing = this.providerHealth.get(providerKey);
    if (existing) {
      if (existing.cooldownUntil && Date.now() > existing.cooldownUntil) {
        const resetState: ProviderHealthState = { healthy: true };
        this.providerHealth.set(providerKey, resetState);
        return resetState;
      }
      return existing;
    }
    const created: ProviderHealthState = { healthy: true };
    this.providerHealth.set(providerKey, created);
    return created;
  }

  private markProviderSuccess(providerKey: string): void {
    this.providerHealth.set(providerKey, { healthy: true });
  }

  private markProviderFailure(providerKey: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    this.providerHealth.set(providerKey, {
      healthy: false,
      lastError: errorMessage,
      lastFailureAt: Date.now(),
      cooldownUntil: Date.now() + PROVIDER_HEALTH_COOLDOWN_MS,
    });
  }

  private findBraveFallbackServer(): EnabledServer | null {
    for (const server of this.enabledServers.values()) {
      const providerKey = this.providerKeyForServer(server);
      if (providerKey !== "brave") continue;
      const health = this.getProviderHealth(providerKey);
      if (health.healthy) return server;
    }
    return null;
  }

  private findSearchToolName(server: EnabledServer): string | null {
    const candidates = server.tools
      .map((tool) => tool.name)
      .filter((name) => /search|web_search|query/i.test(name));
    return candidates.length ? candidates[0] : null;
  }

  private baseUnitsToUsd(value?: string): string {
    if (!value || !/^\d+$/.test(value)) return "unknown";
    const n = BigInt(value);
    const intPart = n / 1_000_000n;
    const fracPart = (n % 1_000_000n).toString().padStart(6, "0");
    return `${intPart}.${fracPart}`;
  }

  private buildPaymentRequiredMessage(paymentData: Record<string, any>): string {
    const relay = (paymentData.relay && typeof paymentData.relay === "object")
      ? (paymentData.relay as RelayInfo)
      : undefined;
    if (relay?.mode === "managed") {
      const requiredUsd = this.baseUnitsToUsd(relay.requiredBaseUnits);
      const availableUsd = this.baseUnitsToUsd(relay.availableBaseUnits);
      const topUpUrl = relay.topUpUrl || "https://mcpmarketplace.rickydata.org/#/wallet";
      return [
        "Payment required: managed relay balance is insufficient.",
        `Managed payer: ${relay.payerAddress || "unknown"}`,
        `Required: $${requiredUsd} USDC, available: $${availableUsd} USDC`,
        `Top up wallet: ${topUpUrl}`,
      ].join(" ");
    }
    return "Payment required. Please fund your wallet on Base mainnet and retry.";
  }

  private async callGateway(toolName: string, args: Record<string, any>): Promise<any> {
    const token = this.currentUserToken;

    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args }
    };

    const shouldUseTimeout = !MCP_DISABLE_TIMEOUTS;
    const effectiveTimeoutMs = Number.isFinite(MCP_HTTP_TIMEOUT_MS) && MCP_HTTP_TIMEOUT_MS > 0 ? MCP_HTTP_TIMEOUT_MS : 30000;
    const controller = shouldUseTimeout ? new AbortController() : null;
    const timeout = shouldUseTimeout ? setTimeout(() => controller!.abort(), effectiveTimeoutMs) : null;

    try {
      const response = await fetch(GATEWAY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          ...(token ? { "Authorization": `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {})
      });

      if (response.status === 402) {
        const paymentData = await response.json().catch(() => ({} as Record<string, any>)) as Record<string, any>;
        const message = this.buildPaymentRequiredMessage(paymentData);
        throw new GatewayPaymentRequiredError(message, paymentData.relay as RelayInfo | undefined);
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gateway error ${response.status}: ${errorText}`);
      }

      const data = await response.json() as any;

      if (data.error) {
        throw new Error(`Gateway RPC error: ${JSON.stringify(data.error)}`);
      }

      const result = data.result;
      if (result?.content) {
        const textContent = result.content.find((c: any) => c.type === "text");
        if (textContent?.text) {
          try {
            const parsed = JSON.parse(textContent.text);
            if (parsed?.error === "PAYMENT_REQUIRED") {
              const paymentReqs = parsed?.paymentRequirements ?? {};
              const message = this.buildPaymentRequiredMessage(paymentReqs);
              throw new GatewayPaymentRequiredError(message, paymentReqs?.relay);
            }
            return parsed;
          } catch (err) {
            if (err instanceof GatewayPaymentRequiredError) {
              throw err;
            }
            return textContent.text;
          }
        }
        return result.content;
      }
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /** Fetch ALL tools from the gateway's tools/list. */
  private async fetchAllGatewayTools(): Promise<GatewayToolDefinition[]> {
    const token = this.currentUserToken;
    const body = { jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} };

    const response = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...(token ? { "Authorization": `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) return [];

    const data = await response.json() as any;
    return data.result?.tools ?? [];
  }

  /** Extract gateway prefix and stripped tools from a list of prefixed tool names. */
  private extractPrefixAndTools(tools: GatewayToolDefinition[]): { prefix: string; stripped: GatewayToolDefinition[] } {
    if (tools.length === 0) return { prefix: "", stripped: [] };

    // Derive prefix from first tool name (everything before first "__")
    const firstToolName = tools[0].name;
    const sepIndex = firstToolName.indexOf("__");
    const prefix = sepIndex > 0 ? firstToolName.substring(0, sepIndex) : "";

    const stripped = tools.map(t => {
      const si = t.name.indexOf("__");
      return {
        name: si > 0 ? t.name.substring(si + 2) : t.name,
        description: t.description,
        inputSchema: t.inputSchema
      };
    });

    return { prefix, stripped };
  }

  private async notifyToolsChanged(): Promise<void> {
    if (!this.server) return;
    try {
      await this.server.notification({ method: "notifications/tools/list_changed" });
    } catch (err) {
      console.error("[marketplace] Failed to send tools/list_changed notification:", err);
    }
  }

  private rebuildDynamicTools(): void {
    this.dynamicTools = [];
    for (const [serverId, serverInfo] of this.enabledServers) {
      for (const tool of serverInfo.tools) {
        this.dynamicTools.push({
          name: `${serverId}__${tool.name}`,
          description: `[${serverInfo.server_name}] ${tool.description || ""}`,
          inputSchema: tool.inputSchema || { type: "object", properties: {} }
        });
      }
    }
  }

  async handleSearch(args: { query: string; category?: string; limit?: number }): Promise<any> {
    return await this.callGateway("gateway__search_servers", {
      query: args.query,
      ...(args.category ? { category: args.category } : {}),
      ...(args.limit ? { limit: args.limit } : {})
    });
  }

  async handleServerInfo(args: { server_id: string }): Promise<any> {
    return await this.callGateway("gateway__server_info", { server_id: args.server_id });
  }

  async handleEnableServer(args: { server_id: string }): Promise<any> {
    const serverId = args.server_id;

    if (this.enabledServers.has(serverId)) {
      const existing = this.enabledServers.get(serverId)!;
      return {
        success: true,
        already_enabled: true,
        server_id: serverId,
        server_name: existing.server_name,
        tools_count: existing.tools.length,
        tools: existing.tools.map(t => `${serverId}__${t.name}`)
      };
    }

    // Snapshot tools BEFORE enabling to diff later
    const toolsBefore = await this.fetchAllGatewayTools();
    const beforeNames = new Set(toolsBefore.map(t => t.name));

    // Enable on the gateway
    const gatewayResult = await this.callGateway("gateway__enable_server", { server_id: serverId });
    const serverName: string = gatewayResult?.server?.name || gatewayResult?.server_name || gatewayResult?.name || serverId;

    // Discover new tools by diffing tools/list (retry up to 3 times for propagation)
    let newGatewayTools: GatewayToolDefinition[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
      const toolsAfter = await this.fetchAllGatewayTools();
      newGatewayTools = toolsAfter.filter(t => !beforeNames.has(t.name));
      if (newGatewayTools.length > 0) break;
    }

    // Extract the actual gateway prefix and strip it from tool names
    const { prefix: gatewayPrefix, stripped: tools } = this.extractPrefixAndTools(newGatewayTools);

    this.enabledServers.set(serverId, {
      server_id: serverId,
      server_name: serverName,
      gateway_prefix: gatewayPrefix,
      tools,
      enabled_at: new Date().toISOString()
    });

    this.rebuildDynamicTools();
    await this.notifyToolsChanged();

    return {
      success: true,
      server_id: serverId,
      server_name: serverName,
      gateway_prefix: gatewayPrefix,
      tools_added: tools.length,
      tools: tools.map(t => ({ name: `${serverId}__${t.name}`, description: t.description })),
      message: `Server "${serverName}" enabled. ${tools.length} tools added to session.`
    };
  }

  async handleDisableServer(args: { server_id: string }): Promise<any> {
    const serverId = args.server_id;

    if (!this.enabledServers.has(serverId)) {
      return {
        success: false,
        error: `Server "${serverId}" is not currently enabled.`,
        enabled_servers: Array.from(this.enabledServers.keys())
      };
    }

    const serverInfo = this.enabledServers.get(serverId)!;
    const removedToolCount = serverInfo.tools.length;

    try {
      await this.callGateway("gateway__disable_server", { server_id: serverId });
    } catch (err) {
      console.error(`[marketplace] Gateway disable error for ${serverId}:`, err);
    }

    this.enabledServers.delete(serverId);
    this.rebuildDynamicTools();
    await this.notifyToolsChanged();

    return {
      success: true,
      server_id: serverId,
      server_name: serverInfo.server_name,
      tools_removed: removedToolCount,
      message: `Server "${serverInfo.server_name}" disabled. ${removedToolCount} tools removed from session.`
    };
  }

  async handleListEnabled(): Promise<any> {
    const servers = Array.from(this.enabledServers.values()).map(s => ({
      server_id: s.server_id,
      server_name: s.server_name,
      enabled_at: s.enabled_at,
      tools: s.tools.map(t => ({ name: `${s.server_id}__${t.name}`, description: t.description }))
    }));

    return {
      enabled_servers: servers,
      total_servers: servers.length,
      total_dynamic_tools: this.dynamicTools.length
    };
  }

  async handleDynamicToolCall(toolName: string, args: Record<string, any>): Promise<any> {
    const separatorIndex = toolName.indexOf("__");
    if (separatorIndex === -1) {
      throw new Error(`Invalid dynamic tool name: ${toolName}`);
    }

    const serverId = toolName.substring(0, separatorIndex);
    const originalToolName = toolName.substring(separatorIndex + 2);

    if (!this.enabledServers.has(serverId)) {
      throw new Error(`Server "${serverId}" is not enabled. Enable it first with marketplace_enable_server.`);
    }

    // Use the gateway prefix (server name) instead of the UUID
    const serverInfo = this.enabledServers.get(serverId)!;
    const providerKey = this.providerKeyForServer(serverInfo);
    const health = this.getProviderHealth(providerKey);

    const callServerTool = async (server: EnabledServer, tool: string): Promise<any> => {
      const currentProviderKey = this.providerKeyForServer(server);
      try {
        const result = await this.callGateway(`${server.gateway_prefix}__${tool}`, args);
        this.markProviderSuccess(currentProviderKey);
        return result;
      } catch (error) {
        this.markProviderFailure(currentProviderKey, error);
        throw error;
      }
    };

    if (!health.healthy && providerKey === "exa") {
      const braveFallback = this.findBraveFallbackServer();
      if (braveFallback) {
        const braveTool = this.findSearchToolName(braveFallback);
        if (braveTool) {
          const fallbackResult = await callServerTool(braveFallback, braveTool);
          return {
            fallback_used: true,
            preferred_provider: "exa",
            fallback_provider: "brave",
            fallback_server_id: braveFallback.server_id,
            fallback_tool: braveTool,
            result: fallbackResult,
          };
        }
      }
      throw new Error(`Server "${serverId}" is in provider cooldown after recent failures and no Brave fallback is available.`);
    }

    try {
      return await callServerTool(serverInfo, originalToolName);
    } catch (error) {
      if (providerKey !== "exa") throw error;
      const braveFallback = this.findBraveFallbackServer();
      if (!braveFallback) throw error;
      const braveTool = this.findSearchToolName(braveFallback);
      if (!braveTool) throw error;
      const fallbackResult = await callServerTool(braveFallback, braveTool);
      return {
        fallback_used: true,
        preferred_provider: "exa",
        fallback_provider: "brave",
        fallback_server_id: braveFallback.server_id,
        fallback_tool: braveTool,
        result: fallbackResult,
      };
    }
  }

  isDynamicTool(toolName: string): boolean {
    return this.dynamicTools.some(t => t.name === toolName);
  }
}

export const marketplaceManager = new MarketplaceManager();

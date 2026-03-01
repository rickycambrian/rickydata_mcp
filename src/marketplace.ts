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
  tools: GatewayToolDefinition[];
  enabled_at: string;
}

const GATEWAY_URL = "https://mcp.rickydata.org/mcp";

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

  private async callGateway(toolName: string, args: Record<string, any>): Promise<any> {
    const token = this.currentUserToken;

    const body = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: args }
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(GATEWAY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          ...(token ? { "Authorization": `Bearer ${token}` } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

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
            return JSON.parse(textContent.text);
          } catch {
            return textContent.text;
          }
        }
        return result.content;
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
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

    const gatewayResult = await this.callGateway("gateway__enable_server", { server_id: serverId });
    const tools: GatewayToolDefinition[] = gatewayResult?.tools || [];
    const serverName: string = gatewayResult?.server_name || gatewayResult?.name || serverId;

    this.enabledServers.set(serverId, {
      server_id: serverId,
      server_name: serverName,
      tools,
      enabled_at: new Date().toISOString()
    });

    this.rebuildDynamicTools();
    await this.notifyToolsChanged();

    return {
      success: true,
      server_id: serverId,
      server_name: serverName,
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

    return await this.callGateway(`${serverId}__${originalToolName}`, args);
  }

  isDynamicTool(toolName: string): boolean {
    return this.dynamicTools.some(t => t.name === toolName);
  }
}

export const marketplaceManager = new MarketplaceManager();

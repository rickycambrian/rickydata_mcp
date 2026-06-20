import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MARKETPLACE_TOOLS, MarketplaceManager } from "./marketplace.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function gatewayResponse(result: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

function gatewayTextResult(data: unknown): Response {
  return gatewayResponse({
    content: [{ type: "text", text: JSON.stringify(data) }],
  });
}

function gatewayToolsList(tools: Array<{ name: string; description?: string; inputSchema?: any }>): Response {
  return gatewayResponse({ tools });
}

function gatewayErrorResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

function gatewayRpcError(error: { code: number; message: string }): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, error }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let manager: MarketplaceManager;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  manager = new MarketplaceManager();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── MARKETPLACE_TOOLS export ─────────────────────────────────────────────────

describe("MARKETPLACE_TOOLS", () => {
  it("exports 5 tool definitions", () => {
    expect(MARKETPLACE_TOOLS).toHaveLength(5);
  });

  it("contains expected tool names", () => {
    const names = MARKETPLACE_TOOLS.map((t) => t.name);
    expect(names).toContain("marketplace_search");
    expect(names).toContain("marketplace_server_info");
    expect(names).toContain("marketplace_enable_server");
    expect(names).toContain("marketplace_disable_server");
    expect(names).toContain("marketplace_list_enabled");
  });

  it("marketplace_search requires query", () => {
    const tool = MARKETPLACE_TOOLS.find((t) => t.name === "marketplace_search")!;
    expect(tool.inputSchema.required).toContain("query");
  });

  it("marketplace_enable_server requires server_id", () => {
    const tool = MARKETPLACE_TOOLS.find((t) => t.name === "marketplace_enable_server")!;
    expect(tool.inputSchema.required).toContain("server_id");
  });
});

// ── Basic accessors ──────────────────────────────────────────────────────────

describe("MarketplaceManager accessors", () => {
  it("getDynamicTools returns empty array initially", () => {
    expect(manager.getDynamicTools()).toEqual([]);
  });

  it("setUserToken / getUserToken round-trips", () => {
    manager.setUserToken("mcpwt_test123");
    expect(manager.getUserToken()).toBe("mcpwt_test123");
  });

  it("isDynamicTool returns false when no tools registered", () => {
    expect(manager.isDynamicTool("some__tool")).toBe(false);
  });
});

// ── handleSearch ─────────────────────────────────────────────────────────────

describe("handleSearch", () => {
  it("returns search results on success", async () => {
    const payload = { servers: [{ id: "uuid-1", name: "Weather MCP" }] };
    vi.mocked(fetch).mockResolvedValueOnce(gatewayTextResult(payload));

    const result = await manager.handleSearch({ query: "weather" });
    expect(result).toEqual(payload);

    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("gateway__search_servers");
    expect(body.params.arguments.query).toBe("weather");
  });

  it("passes optional category and limit", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayTextResult({ servers: [] }));

    await manager.handleSearch({ query: "crypto", category: "finance", limit: 5 });

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.params.arguments.category).toBe("finance");
    expect(body.params.arguments.limit).toBe(5);
  });

  it("omits category and limit when not provided", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayTextResult({ servers: [] }));

    await manager.handleSearch({ query: "test" });

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.params.arguments).toEqual({ query: "test" });
  });

  it("sends auth header when token is set", async () => {
    manager.setUserToken("mcpwt_abc");
    vi.mocked(fetch).mockResolvedValueOnce(gatewayTextResult({ servers: [] }));

    await manager.handleSearch({ query: "test" });

    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mcpwt_abc");
  });

  it("omits auth header when no token", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayTextResult({ servers: [] }));

    await manager.handleSearch({ query: "test" });

    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("throws on gateway HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayErrorResponse(500, "Internal Server Error"));

    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow("Gateway error 500");
  });

  it("throws on gateway RPC error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      gatewayRpcError({ code: -32600, message: "Invalid Request" })
    );

    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow("Gateway RPC error");
  });
});

// ── handleServerInfo ─────────────────────────────────────────────────────────

describe("handleServerInfo", () => {
  it("returns server info on success", async () => {
    const payload = { id: "uuid-1", name: "Weather MCP", tools: [] };
    vi.mocked(fetch).mockResolvedValueOnce(gatewayTextResult(payload));

    const result = await manager.handleServerInfo({ server_id: "uuid-1" });
    expect(result).toEqual(payload);

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.params.name).toBe("gateway__server_info");
    expect(body.params.arguments.server_id).toBe("uuid-1");
  });

  it("throws on HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayErrorResponse(404, "Not Found"));

    await expect(manager.handleServerInfo({ server_id: "bad-id" })).rejects.toThrow(
      "Gateway error 404"
    );
  });
});

// ── handleEnableServer ───────────────────────────────────────────────────────

describe("handleEnableServer", () => {
  it("returns already_enabled when server is already enabled", async () => {
    // First enable: resolve UUID, enable, fetch tools
    const searchResult = { servers: [{ id: "uuid-1", name: "Weather MCP" }] };
    const enableResult = { server: { name: "Weather MCP" } };
    const toolsList = [
      { name: "weather-mcp__get_forecast", description: "Get forecast" },
      { name: "weather-mcp__get_current", description: "Get current weather" },
    ];

    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult(searchResult))   // resolveServerId search
      .mockResolvedValueOnce(gatewayTextResult(enableResult))   // enable_server
      .mockResolvedValueOnce(gatewayToolsList(toolsList));      // fetchAllGatewayTools

    await manager.handleEnableServer({ server_id: "Weather MCP" });

    // Second call: should return already_enabled
    const result = await manager.handleEnableServer({ server_id: "Weather MCP" });
    expect(result.already_enabled).toBe(true);
    expect(result.success).toBe(true);
    expect(result.tools_count).toBe(2);
  });

  it("resolves UUID and enables server by name", async () => {
    const searchResult = { servers: [{ id: "uuid-1", name: "Weather MCP" }] };
    const enableResult = { server: { name: "Weather MCP" } };
    const toolsList = [
      { name: "weather-mcp__get_forecast", description: "Get forecast", inputSchema: { type: "object" } },
    ];

    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult(searchResult))
      .mockResolvedValueOnce(gatewayTextResult(enableResult))
      .mockResolvedValueOnce(gatewayToolsList(toolsList));

    const result = await manager.handleEnableServer({ server_id: "Weather MCP" });

    expect(result.success).toBe(true);
    expect(result.server_name).toBe("Weather MCP");
    expect(result.tools_added).toBe(1);
    expect(result.tools[0].name).toBe("Weather MCP__get_forecast");
  });

  it("accepts UUID directly without search", async () => {
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const enableResult = { server: { name: "Direct Server" } };
    const toolsList = [{ name: "direct-server__ping", description: "Ping" }];

    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult(enableResult))   // enable_server (no search needed)
      .mockResolvedValueOnce(gatewayToolsList(toolsList));       // fetchAllGatewayTools

    const result = await manager.handleEnableServer({ server_id: uuid });

    expect(result.success).toBe(true);
    expect(result.server_name).toBe("Direct Server");
  });

  it("returns error when server is not found", async () => {
    // All search queries return empty
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult({ servers: [] }))   // search by name
      .mockResolvedValueOnce(gatewayTextResult({ servers: [] }));   // list_enabled fallback

    const result = await manager.handleEnableServer({ server_id: "nonexistent" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("registers dynamic tools after enable", async () => {
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const enableResult = { server: { name: "Test Server" } };
    const toolsList = [
      { name: "test-server__action_a", description: "Action A" },
      { name: "test-server__action_b", description: "Action B" },
    ];

    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult(enableResult))
      .mockResolvedValueOnce(gatewayToolsList(toolsList));

    await manager.handleEnableServer({ server_id: uuid });

    const dynamicTools = manager.getDynamicTools();
    expect(dynamicTools).toHaveLength(2);
    expect(dynamicTools[0].name).toBe(`${uuid}__action_a`);
    expect(dynamicTools[1].name).toBe(`${uuid}__action_b`);
    expect(manager.isDynamicTool(`${uuid}__action_a`)).toBe(true);
  });

  it("notifies server when tools change", async () => {
    const mockNotification = vi.fn().mockResolvedValue(undefined);
    manager.setServer({ notification: mockNotification } as any);

    const uuid = "12345678-1234-1234-1234-123456789abc";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult({ server: { name: "S" } }))
      .mockResolvedValueOnce(gatewayToolsList([]))   // 1st retry
      .mockResolvedValueOnce(gatewayToolsList([]))   // 2nd retry
      .mockResolvedValueOnce(gatewayToolsList([]));  // 3rd retry

    await manager.handleEnableServer({ server_id: uuid });

    expect(mockNotification).toHaveBeenCalledWith({
      method: "notifications/tools/list_changed",
    });
  });
});

// ── handleDisableServer ──────────────────────────────────────────────────────

describe("handleDisableServer", () => {
  it("returns error when server is not enabled", async () => {
    const result = await manager.handleDisableServer({ server_id: "not-enabled" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not currently enabled/);
    expect(result.enabled_servers).toEqual([]);
  });

  it("disables a previously enabled server", async () => {
    // Enable first
    const uuid = "12345678-1234-1234-1234-123456789abc";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult({ server: { name: "My Server" } }))
      .mockResolvedValueOnce(gatewayToolsList([
        { name: "my-server__do_thing", description: "Does a thing" },
      ]));

    await manager.handleEnableServer({ server_id: uuid });
    expect(manager.getDynamicTools()).toHaveLength(1);

    // Disable
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult({ servers: [{ id: uuid, name: "My Server" }] })) // resolveServerId
      .mockResolvedValueOnce(gatewayTextResult({ success: true }));  // disable_server

    const result = await manager.handleDisableServer({ server_id: uuid });

    expect(result.success).toBe(true);
    expect(result.tools_removed).toBe(1);
    expect(result.message).toMatch(/disabled/);
    expect(manager.getDynamicTools()).toHaveLength(0);
    expect(manager.isDynamicTool(`${uuid}__do_thing`)).toBe(false);
  });

  it("succeeds even if gateway disable call fails", async () => {
    const uuid = "12345678-1234-1234-1234-123456789abc";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult({ server: { name: "S" } }))
      .mockResolvedValueOnce(gatewayToolsList([]))   // 1st retry
      .mockResolvedValueOnce(gatewayToolsList([]))   // 2nd retry
      .mockResolvedValueOnce(gatewayToolsList([]));  // 3rd retry

    await manager.handleEnableServer({ server_id: uuid });

    // Gateway disable fails but local state should still clean up
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult({ servers: [{ id: uuid, name: "S" }] })) // resolveServerId
      .mockRejectedValueOnce(new Error("Network error"));

    const result = await manager.handleDisableServer({ server_id: uuid });
    expect(result.success).toBe(true);
  });
});

// ── handleListEnabled ────────────────────────────────────────────────────────

describe("handleListEnabled", () => {
  it("returns empty list when nothing enabled", async () => {
    const result = await manager.handleListEnabled();

    expect(result.enabled_servers).toEqual([]);
    expect(result.total_servers).toBe(0);
    expect(result.total_dynamic_tools).toBe(0);
  });

  it("returns enabled servers with tools", async () => {
    const uuid = "12345678-1234-1234-1234-123456789abc";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult({ server: { name: "Test Server" } }))
      .mockResolvedValueOnce(gatewayToolsList([
        { name: "test-server__search", description: "Search" },
      ]));

    await manager.handleEnableServer({ server_id: uuid });

    const result = await manager.handleListEnabled();

    expect(result.total_servers).toBe(1);
    expect(result.total_dynamic_tools).toBe(1);
    expect(result.enabled_servers[0].server_name).toBe("Test Server");
    expect(result.enabled_servers[0].tools[0].name).toBe(`${uuid}__search`);
  });
});

// ── handleDynamicToolCall ────────────────────────────────────────────────────

describe("handleDynamicToolCall", () => {
  it("throws on invalid tool name (no separator)", async () => {
    await expect(
      manager.handleDynamicToolCall("invalidname", {})
    ).rejects.toThrow("Invalid dynamic tool name");
  });

  it("throws when server is not enabled", async () => {
    await expect(
      manager.handleDynamicToolCall("some-server__tool", {})
    ).rejects.toThrow("not enabled");
  });

  it("routes call to the correct gateway tool", async () => {
    const uuid = "12345678-1234-1234-1234-123456789abc";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult({ server: { name: "Test Server" } }))
      .mockResolvedValueOnce(gatewayToolsList([
        { name: "test-server__search", description: "Search" },
      ]));

    await manager.handleEnableServer({ server_id: uuid });

    // Call the dynamic tool
    const toolResult = { results: ["a", "b"] };
    vi.mocked(fetch).mockResolvedValueOnce(gatewayTextResult(toolResult));

    const result = await manager.handleDynamicToolCall(
      `${uuid}__search`,
      { query: "hello" }
    );

    expect(result).toEqual(toolResult);

    // Verify gateway was called with the correct prefixed tool name
    const lastCall = vi.mocked(fetch).mock.calls.at(-1)!;
    const body = JSON.parse((lastCall[1] as RequestInit).body as string);
    expect(body.params.name).toBe("test-server__search");
    expect(body.params.arguments.query).toBe("hello");
  });
});

// ── Payment required (402) ───────────────────────────────────────────────────

describe("payment required handling", () => {
  it("throws GatewayPaymentRequiredError on HTTP 402", async () => {
    const paymentBody = {
      relay: {
        mode: "managed",
        payerAddress: "0xabc",
        requiredBaseUnits: "5000000",
        availableBaseUnits: "1000000",
      },
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(paymentBody), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow(
      /Payment required/
    );
  });

  it("throws GatewayPaymentRequiredError on PAYMENT_REQUIRED in result text", async () => {
    const payload = { error: "PAYMENT_REQUIRED", paymentRequirements: {} };
    vi.mocked(fetch).mockResolvedValueOnce(gatewayTextResult(payload));

    // callGateway parses the text, sees PAYMENT_REQUIRED, and rethrows
    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow(
      /Payment required/
    );
  });

  it("includes managed relay details in error message", async () => {
    const paymentBody = {
      relay: {
        mode: "managed",
        payerAddress: "0xabc",
        requiredBaseUnits: "2000000",
        availableBaseUnits: "500000",
        topUpUrl: "https://example.com/topup",
      },
    };
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify(paymentBody), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow(
      /\$2\.000000 USDC/
    );
  });

  it("returns generic message for non-managed relay", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow(
      /fund your wallet/
    );
  });
});

// ── callGateway edge cases ───────────────────────────────────────────────────

describe("callGateway edge cases", () => {
  it("returns raw content array when no text content found", async () => {
    const content = [{ type: "image", url: "https://example.com/img.png" }];
    vi.mocked(fetch).mockResolvedValueOnce(
      gatewayResponse({ content })
    );

    const result = await manager.handleSearch({ query: "test" });
    expect(result).toEqual(content);
  });

  it("returns raw text when JSON.parse fails on text content", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      gatewayResponse({
        content: [{ type: "text", text: "not valid json" }],
      })
    );

    const result = await manager.handleSearch({ query: "test" });
    expect(result).toBe("not valid json");
  });

  it("returns result directly when no content field", async () => {
    const raw = { some: "data" };
    vi.mocked(fetch).mockResolvedValueOnce(gatewayResponse(raw));

    const result = await manager.handleSearch({ query: "test" });
    expect(result).toEqual(raw);
  });
});

// ── Provider health & fallback ───────────────────────────────────────────────

describe("provider health and Exa→Brave fallback", () => {
  async function enableServer(id: string, name: string, tools: Array<{ name: string; description: string }>) {
    const prefix = name.toLowerCase().replace(/[/._\s]+/g, "-");
    const gatewayTools = tools.map((t) => ({
      name: `${prefix}__${t.name}`,
      description: t.description,
    }));

    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayTextResult({ server: { name } }))
      .mockResolvedValueOnce(gatewayToolsList(gatewayTools));

    await manager.handleEnableServer({ server_id: id });
  }

  it("falls back to Brave when Exa tool call fails", async () => {
    const exaUuid = "11111111-1111-1111-1111-111111111111";
    const braveUuid = "22222222-2222-2222-2222-222222222222";

    await enableServer(exaUuid, "Exa Search", [
      { name: "web_search", description: "Exa web search" },
    ]);
    await enableServer(braveUuid, "Brave Search", [
      { name: "web_search", description: "Brave web search" },
    ]);

    // Exa call fails
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Exa timeout"));
    // Brave fallback succeeds
    vi.mocked(fetch).mockResolvedValueOnce(gatewayTextResult({ results: ["brave result"] }));

    const result = await manager.handleDynamicToolCall(
      `${exaUuid}__web_search`,
      { query: "test" }
    );

    expect(result.fallback_used).toBe(true);
    expect(result.preferred_provider).toBe("exa");
    expect(result.fallback_provider).toBe("brave");
  });

  it("throws when Exa fails and no Brave fallback is available", async () => {
    const exaUuid = "11111111-1111-1111-1111-111111111111";

    await enableServer(exaUuid, "Exa Search", [
      { name: "web_search", description: "Exa web search" },
    ]);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("Exa timeout"));

    await expect(
      manager.handleDynamicToolCall(`${exaUuid}__web_search`, { query: "test" })
    ).rejects.toThrow("Exa timeout");
  });

  it("throws directly for non-Exa provider failures (no fallback)", async () => {
    const uuid = "33333333-3333-3333-3333-333333333333";

    await enableServer(uuid, "Custom Provider", [
      { name: "action", description: "Do something" },
    ]);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("Provider error"));

    await expect(
      manager.handleDynamicToolCall(`${uuid}__action`, {})
    ).rejects.toThrow("Provider error");
  });
});

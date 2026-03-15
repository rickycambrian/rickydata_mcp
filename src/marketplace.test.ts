import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MarketplaceManager, MARKETPLACE_TOOLS } from "./marketplace.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

/** Build a JSON-RPC result wrapping content as the gateway returns it. */
function gatewayJsonRpcResponse(result: unknown, status = 200): Response {
  return jsonResponse({ jsonrpc: "2.0", id: 1, result }, status);
}

/** Shorthand for a gateway response with text content. */
function gatewayTextContent(text: string): Response {
  return gatewayJsonRpcResponse({
    content: [{ type: "text", text: JSON.stringify(text) }],
  });
}

function gatewayObjectContent(obj: unknown): Response {
  return gatewayJsonRpcResponse({
    content: [{ type: "text", text: JSON.stringify(obj) }],
  });
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let manager: MarketplaceManager;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("MCP_DISABLE_TIMEOUTS", "false");
  manager = new MarketplaceManager();
  manager.setUserToken("mcpwt_test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── MARKETPLACE_TOOLS definition ─────────────────────────────────────────────

describe("MARKETPLACE_TOOLS", () => {
  it("exports 5 tool definitions", () => {
    expect(MARKETPLACE_TOOLS).toHaveLength(5);
  });

  it("includes all expected tool names", () => {
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

  it("marketplace_server_info requires server_id", () => {
    const tool = MARKETPLACE_TOOLS.find((t) => t.name === "marketplace_server_info")!;
    expect(tool.inputSchema.required).toContain("server_id");
  });
});

// ── MarketplaceManager basics ────────────────────────────────────────────────

describe("MarketplaceManager – basics", () => {
  it("starts with no dynamic tools", () => {
    expect(manager.getDynamicTools()).toEqual([]);
  });

  it("stores and retrieves user token", () => {
    manager.setUserToken("mcpwt_abc");
    expect(manager.getUserToken()).toBe("mcpwt_abc");
  });

  it("isDynamicTool returns false when no tools registered", () => {
    expect(manager.isDynamicTool("some__tool")).toBe(false);
  });
});

// ── handleSearch ─────────────────────────────────────────────────────────────

describe("handleSearch", () => {
  it("calls gateway with query and returns result", async () => {
    const payload = { servers: [{ id: "s1", name: "Weather MCP" }] };
    vi.mocked(fetch).mockResolvedValueOnce(gatewayObjectContent(payload));

    const result = await manager.handleSearch({ query: "weather" });

    expect(result).toEqual(payload);

    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("gateway__search_servers");
    expect(body.params.arguments.query).toBe("weather");
  });

  it("passes optional category and limit", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayObjectContent({ servers: [] }));

    await manager.handleSearch({ query: "test", category: "data", limit: 5 });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.params.arguments.category).toBe("data");
    expect(body.params.arguments.limit).toBe(5);
  });

  it("throws on gateway HTTP error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse("Internal Server Error", 500));

    await expect(manager.handleSearch({ query: "fail" })).rejects.toThrow("Gateway error 500");
  });

  it("sends Authorization header when token is set", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(gatewayObjectContent({ servers: [] }));

    await manager.handleSearch({ query: "test" });

    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mcpwt_test-token");
  });

  it("omits Authorization header when no token", async () => {
    manager.setUserToken("");
    vi.mocked(fetch).mockResolvedValueOnce(gatewayObjectContent({ servers: [] }));

    await manager.handleSearch({ query: "test" });

    const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

// ── handleServerInfo ─────────────────────────────────────────────────────────

describe("handleServerInfo", () => {
  it("calls gateway with server_id", async () => {
    const info = { id: "s1", name: "My Server", tools: [] };
    vi.mocked(fetch).mockResolvedValueOnce(gatewayObjectContent(info));

    const result = await manager.handleServerInfo({ server_id: "s1" });

    expect(result).toEqual(info);

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.params.name).toBe("gateway__server_info");
    expect(body.params.arguments.server_id).toBe("s1");
  });

  it("throws on gateway error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse("Not Found", 404));

    await expect(manager.handleServerInfo({ server_id: "bad" })).rejects.toThrow("Gateway error 404");
  });
});

// ── handleEnableServer ───────────────────────────────────────────────────────

describe("handleEnableServer", () => {
  it("returns already_enabled for duplicate enable", async () => {
    // First enable: resolve → search + enable + fetchAllTools
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    // resolveServerId: search returns a server
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayObjectContent({ servers: [{ id: uuid, name: "My Server" }] }))
      // enable gateway call
      .mockResolvedValueOnce(gatewayObjectContent({ server: { name: "My Server" } }))
      // fetchAllGatewayTools (attempt 1)
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "my-server__search", description: "Search" },
            ],
          },
        })
      );

    await manager.handleEnableServer({ server_id: "my-server" });

    // Second call should return already_enabled without additional fetch calls
    const fetchCount = vi.mocked(fetch).mock.calls.length;
    const result = await manager.handleEnableServer({ server_id: "my-server" });

    expect(result.already_enabled).toBe(true);
    expect(result.success).toBe(true);
    // No additional fetch calls were made
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchCount);
  });

  it("returns error when server not found in marketplace", async () => {
    // resolveServerId: all searches return empty
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayObjectContent({ servers: [] }))
      // last resort: list_enabled also empty
      .mockResolvedValueOnce(gatewayObjectContent({ servers: [] }));

    const result = await manager.handleEnableServer({ server_id: "nonexistent" });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("enables a UUID server_id directly without search", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    vi.mocked(fetch)
      // enable gateway call (no search needed for UUID)
      .mockResolvedValueOnce(gatewayObjectContent({ server: { name: "UUID Server" } }))
      // fetchAllGatewayTools
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [] },
        })
      )
      // fetchAllGatewayTools attempt 2
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [] },
        })
      )
      // fetchAllGatewayTools attempt 3
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: { tools: [] },
        })
      );

    const result = await manager.handleEnableServer({ server_id: uuid });

    expect(result.success).toBe(true);
    expect(result.server_name).toBe("UUID Server");
    // First call should be enable, not search
    const firstBody = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(firstBody.params.name).toBe("gateway__enable_server");
  });

  it("notifies server of tools change", async () => {
    const notifySpy = vi.fn().mockResolvedValue(undefined);
    manager.setServer({ notification: notifySpy } as any);

    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayObjectContent({ server: { name: "Test" } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));

    await manager.handleEnableServer({ server_id: uuid });

    expect(notifySpy).toHaveBeenCalledWith({ method: "notifications/tools/list_changed" });
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
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayObjectContent({ server: { name: "ToDisable" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "todisable__tool1", description: "Tool 1" },
            ],
          },
        })
      );

    await manager.handleEnableServer({ server_id: uuid });
    expect(manager.getDynamicTools()).toHaveLength(1);

    // Now disable: resolveServerId + disable gateway call
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayObjectContent({ servers: [] }))
      .mockResolvedValueOnce(gatewayObjectContent({ servers: [] }))
      .mockResolvedValueOnce(gatewayObjectContent({ success: true }));

    const result = await manager.handleDisableServer({ server_id: uuid });

    expect(result.success).toBe(true);
    expect(result.tools_removed).toBe(1);
    expect(manager.getDynamicTools()).toHaveLength(0);
  });

  it("notifies server of tools change on disable", async () => {
    const notifySpy = vi.fn().mockResolvedValue(undefined);
    manager.setServer({ notification: notifySpy } as any);

    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayObjectContent({ server: { name: "Svc" } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    await manager.handleEnableServer({ server_id: uuid });
    notifySpy.mockClear();

    // disable
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayObjectContent({ servers: [] }))
      .mockResolvedValueOnce(gatewayObjectContent({ servers: [] }))
      .mockResolvedValueOnce(gatewayObjectContent({ success: true }));

    await manager.handleDisableServer({ server_id: uuid });
    expect(notifySpy).toHaveBeenCalledWith({ method: "notifications/tools/list_changed" });
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
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayObjectContent({ server: { name: "Listed" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "listed__do_stuff", description: "Does stuff" },
            ],
          },
        })
      );

    await manager.handleEnableServer({ server_id: uuid });

    const result = await manager.handleListEnabled();

    expect(result.total_servers).toBe(1);
    expect(result.enabled_servers[0].server_id).toBe(uuid);
    expect(result.enabled_servers[0].server_name).toBe("Listed");
  });
});

// ── handleDynamicToolCall ────────────────────────────────────────────────────

describe("handleDynamicToolCall", () => {
  it("throws for invalid tool name without separator", async () => {
    await expect(manager.handleDynamicToolCall("notool", {})).rejects.toThrow(
      "Invalid dynamic tool name"
    );
  });

  it("throws when server not enabled", async () => {
    await expect(manager.handleDynamicToolCall("server__tool", {})).rejects.toThrow(
      'Server "server" is not enabled'
    );
  });

  it("routes call through gateway with correct prefix", async () => {
    // Enable a server first
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayObjectContent({ server: { name: "Router Test" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [
              { name: "router-test__web_search", description: "Search the web" },
            ],
          },
        })
      );

    await manager.handleEnableServer({ server_id: uuid });

    // Now call dynamic tool
    const searchResult = { results: [{ url: "https://example.com" }] };
    vi.mocked(fetch).mockResolvedValueOnce(gatewayObjectContent(searchResult));

    const result = await manager.handleDynamicToolCall(
      `${uuid}__web_search`,
      { query: "test" }
    );

    expect(result).toEqual(searchResult);

    // Verify the gateway call used the gateway_prefix (not the UUID)
    const lastCall = vi.mocked(fetch).mock.calls.at(-1)!;
    const body = JSON.parse(lastCall[1]!.body as string);
    expect(body.params.name).toBe("router-test__web_search");
  });
});

// ── isDynamicTool ────────────────────────────────────────────────────────────

describe("isDynamicTool", () => {
  it("returns true for registered dynamic tool", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    vi.mocked(fetch)
      .mockResolvedValueOnce(gatewayObjectContent({ server: { name: "Check" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [{ name: "check__ping", description: "Ping" }],
          },
        })
      );

    await manager.handleEnableServer({ server_id: uuid });

    expect(manager.isDynamicTool(`${uuid}__ping`)).toBe(true);
    expect(manager.isDynamicTool(`${uuid}__unknown`)).toBe(false);
  });
});

// ── Gateway 402 Payment Required ─────────────────────────────────────────────

describe("Gateway payment required (402)", () => {
  it("throws GatewayPaymentRequiredError on HTTP 402", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          relay: {
            mode: "managed",
            payerAddress: "0xabc",
            requiredBaseUnits: "1000000",
            availableBaseUnits: "500000",
            topUpUrl: "https://mcpmarketplace.rickydata.org/#/wallet",
          },
        },
        402
      )
    );

    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow(
      /Payment required.*managed relay/
    );
  });

  it("throws generic payment message when relay is not managed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({}, 402));

    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow(
      /Payment required.*fund your wallet/
    );
  });

  it("throws on PAYMENT_REQUIRED in RPC text content", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "PAYMENT_REQUIRED",
                paymentRequirements: { relay: { mode: "direct" } },
              }),
            },
          ],
        },
      })
    );

    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow(
      /Payment required/
    );
  });
});

// ── Gateway RPC error ────────────────────────────────────────────────────────

describe("Gateway RPC error", () => {
  it("throws on JSON-RPC error field", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: "Invalid Request" },
      })
    );

    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow(
      /Gateway RPC error/
    );
  });
});

// ── Network error ────────────────────────────────────────────────────────────

describe("Network error", () => {
  it("propagates fetch exceptions", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(manager.handleSearch({ query: "test" })).rejects.toThrow("ECONNREFUSED");
  });
});

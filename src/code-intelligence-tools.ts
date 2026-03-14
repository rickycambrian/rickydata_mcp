/**
 * KFDB Code Intelligence MCP Tools
 *
 * Exposes KFDB's code intelligence endpoints as MCP tools:
 * - kfdb_code_search: Multi-stream code search with classifier-based routing
 * - kfdb_agent_context: Full context bundle with sufficiency gate and graph artifacts
 * - kfdb_test_impact: BFS-based test discovery from changed files
 *
 * Requires environment variables:
 *   KFDB_URL      -- KFDB API base URL
 *   KFDB_API_KEY  -- API key (Authorization: Bearer header)
 */

/** Tool names */
export const KFDB_CODE_SEARCH = "kfdb_code_search";
export const KFDB_AGENT_CONTEXT = "kfdb_agent_context";
export const KFDB_TEST_IMPACT = "kfdb_test_impact";

export const CODE_INTELLIGENCE_TOOL_NAMES = new Set([
  KFDB_CODE_SEARCH,
  KFDB_AGENT_CONTEXT,
  KFDB_TEST_IMPACT,
]);

interface CodeIntelligenceToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface CodeIntelligenceToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Returns the definitions of all code intelligence tools (for tools/list).
 */
export function getCodeIntelligenceToolDefinitions(): CodeIntelligenceToolDef[] {
  return [
    {
      name: KFDB_CODE_SEARCH,
      description:
        "Search code across repositories using multi-stream fusion (FTS + semantic + symbol + graph). " +
        "Auto-classifies queries into optimal retrieval modes: entity_lookup, issue_localization, " +
        "architectural_qa, cross_repo_pattern, or general.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Natural language or code query (e.g., 'RateLimiter', 'how does auth work', 'fix crash in CDC pipeline')",
          },
          limit: {
            type: "number",
            description: "Maximum results to return (default: 10, max: 100)",
          },
          retrieval_mode: {
            type: "string",
            enum: [
              "entity_lookup",
              "issue_localization",
              "architectural_qa",
              "cross_repo_pattern",
              "general",
            ],
            description: "Override auto-classification with specific retrieval mode",
          },
          include_graph: {
            type: "boolean",
            description: "Include graph neighborhood expansion (default: true)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: KFDB_AGENT_CONTEXT,
      description:
        "Build a complete evidence bundle for AI reasoning. Returns ranked code evidence, " +
        "test candidates, graph neighborhoods, and retrieval metadata with suggested KQL queries " +
        "for deeper exploration. Includes sufficiency gating to prevent over-retrieval.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language query describing what context is needed",
          },
          evidence_limit: {
            type: "number",
            description: "Maximum evidence items (default: 10, max: 50)",
          },
          token_budget: {
            type: "number",
            description: "Token budget for the entire bundle (default: 8000, max: 32000)",
          },
          include_tests: {
            type: "boolean",
            description: "Include test candidates for evidence items (default: true)",
          },
          include_graph: {
            type: "boolean",
            description: "Include ego-graph neighborhoods (default: true)",
          },
          anchors: {
            type: "array",
            description: "Anchor nodes to seed graph retrieval",
            items: {
              type: "object",
              properties: {
                file_path: { type: "string", description: "File path to anchor on" },
                symbol_name: { type: "string", description: "Symbol FQN to anchor on" },
                node_id: { type: "string", description: "Direct node UUID" },
                anchor_reason: { type: "string", description: "Why this is an anchor" },
              },
              required: ["anchor_reason"],
            },
          },
          enable_sufficiency_gate: {
            type: "boolean",
            description:
              "Enable sufficiency gating - expand search if initial results insufficient (default: true)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: KFDB_TEST_IMPACT,
      description:
        "Given changed files or function names, find affected tests via graph BFS. " +
        "Returns tests with confidence scores by hop distance (1-hop=0.9, 2-hop=0.7, 3-hop=0.5).",
      inputSchema: {
        type: "object",
        properties: {
          changed_items: {
            type: "array",
            items: { type: "string" },
            description: "List of changed file paths or fully-qualified function names",
          },
          max_hops: {
            type: "number",
            description: "Maximum BFS hops (default: 3, max: 3)",
          },
        },
        required: ["changed_items"],
      },
    },
  ];
}

/**
 * Check whether a tool name is a code intelligence tool.
 */
export function isCodeIntelligenceTool(toolName: string): boolean {
  return CODE_INTELLIGENCE_TOOL_NAMES.has(toolName);
}

/**
 * Handle a code intelligence tool call. Proxies to the KFDB REST API.
 *
 * Requires KFDB_URL and KFDB_API_KEY environment variables.
 */
export async function handleCodeIntelligenceTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<CodeIntelligenceToolResult> {
  const kfdbUrl = process.env.KFDB_URL || "http://34.60.37.158";
  const kfdbApiKey = process.env.KFDB_API_KEY;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (kfdbApiKey) {
    headers["Authorization"] = `Bearer ${kfdbApiKey}`;
  }

  try {
    switch (toolName) {
      case KFDB_CODE_SEARCH:
        return await handleCodeSearch(args, kfdbUrl, headers);
      case KFDB_AGENT_CONTEXT:
        return await handleAgentContext(args, kfdbUrl, headers);
      case KFDB_TEST_IMPACT:
        return await handleTestImpact(args, kfdbUrl, headers);
      default:
        return {
          content: [{ type: "text", text: `Unknown code intelligence tool: ${toolName}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Code intelligence tool error: ${(error as Error).message}`,
      }],
      isError: true,
    };
  }
}

// -- Handlers ----------------------------------------------------------------

async function handleCodeSearch(
  args: Record<string, unknown>,
  kfdbUrl: string,
  headers: Record<string, string>,
): Promise<CodeIntelligenceToolResult> {
  if (!args.query) {
    return {
      content: [{ type: "text", text: "Error: query is required." }],
      isError: true,
    };
  }

  const body: Record<string, unknown> = {
    query: args.query as string,
    limit: Math.min((args.limit as number) || 10, 100),
    include_graph: args.include_graph !== false,
  };
  if (args.retrieval_mode) {
    body.retrieval_mode = args.retrieval_mode;
  }

  const res = await fetch(`${kfdbUrl}/api/v1/code-search`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    return {
      content: [{ type: "text", text: `Code search failed: ${res.status} ${errorText}` }],
      isError: true,
    };
  }

  const data = (await res.json()) as Record<string, unknown>;
  const results = (data.results as Record<string, unknown>[]) || [];

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        retrieval_mode: data.retrieval_mode,
        total: data.total,
        results: results.map((r) => ({
          file_path: r.file_path,
          name: r.name,
          label: r.label,
          score: r.score,
          stream_hits: r.stream_hits,
          content: r.content ? (r.content as string).substring(0, 2000) : null,
          start_line: r.start_line,
          end_line: r.end_line,
        })),
        diagnostics: {
          streams_used: (data.diagnostics as Record<string, unknown>)?.streams_used,
          total_ms: (data.diagnostics as Record<string, unknown>)?.total_ms,
        },
      }, null, 2),
    }],
  };
}

async function handleAgentContext(
  args: Record<string, unknown>,
  kfdbUrl: string,
  headers: Record<string, string>,
): Promise<CodeIntelligenceToolResult> {
  if (!args.query) {
    return {
      content: [{ type: "text", text: "Error: query is required." }],
      isError: true,
    };
  }

  const body: Record<string, unknown> = {
    query: args.query as string,
    evidence_limit: Math.min((args.evidence_limit as number) || 10, 50),
    token_budget: Math.min((args.token_budget as number) || 8000, 32000),
    include_tests: args.include_tests !== false,
    include_graph: args.include_graph !== false,
    enable_sufficiency_gate: args.enable_sufficiency_gate !== false,
  };
  if (args.anchors) {
    body.anchors = args.anchors;
  }

  const res = await fetch(`${kfdbUrl}/api/v1/agent/context`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    return {
      content: [{ type: "text", text: `Context bundle failed: ${res.status} ${errorText}` }],
      isError: true,
    };
  }

  const data = (await res.json()) as Record<string, unknown>;
  const evidenceItems = (data.evidence_items as Record<string, unknown>[]) || [];
  const graphNeighborhood = (data.graph_neighborhood as Record<string, unknown>[]) || [];

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        evidence_count: (data.diagnostics as Record<string, unknown>)?.evidence_count,
        retrieval_metadata: data.retrieval_metadata,
        evidence_items: evidenceItems.map((e) => ({
          file_path: e.file_path,
          name: e.name,
          label: e.label,
          score: e.score,
          stream_hits: e.stream_hits,
          content: e.content ? (e.content as string).substring(0, 2000) : null,
          token_estimate: e.token_estimate,
          test_candidates: e.test_candidates,
        })),
        graph_neighborhood: graphNeighborhood.map((g) => ({
          seed_node_id: g.seed_node_id,
          node_count: (g.nodes as unknown[])?.length || 0,
          edge_count: (g.edges as unknown[])?.length || 0,
        })),
        reproducibility_hash: data.reproducibility_hash,
        diagnostics: data.diagnostics,
      }, null, 2),
    }],
  };
}

async function handleTestImpact(
  args: Record<string, unknown>,
  kfdbUrl: string,
  headers: Record<string, string>,
): Promise<CodeIntelligenceToolResult> {
  if (!args.changed_items || !Array.isArray(args.changed_items) || args.changed_items.length === 0) {
    return {
      content: [{ type: "text", text: "Error: changed_items (non-empty array) is required." }],
      isError: true,
    };
  }

  const body = {
    changed_items: args.changed_items as string[],
    max_hops: Math.min((args.max_hops as number) || 3, 3),
  };

  const res = await fetch(`${kfdbUrl}/api/v1/test-impact`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    return {
      content: [{ type: "text", text: `Test impact failed: ${res.status} ${errorText}` }],
      isError: true,
    };
  }

  const data = await res.json();
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

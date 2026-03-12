/**
 * Answer Sheet MCP Tools
 *
 * Tools for managing answer sheets -- proven solution patterns mined from
 * successful agent sessions. These tools proxy to the KFDB REST API.
 *
 * Tools:
 *   1. get_answer_sheets   -- Search answer sheets by category, language, tags
 *   2. create_answer_sheet -- Create a new answer sheet with solution steps
 *   3. match_answer_sheet  -- Find best-matching sheets for an error message
 *   4. rate_answer_sheet   -- Submit feedback to update Bayesian confidence
 *
 * Requires environment variables:
 *   KFDB_URL      -- KFDB API base URL
 *   KFDB_API_KEY  -- API key (X-KF-API-Key header)
 */

/** Tool names */
export const GET_ANSWER_SHEETS = "get_answer_sheets";
export const CREATE_ANSWER_SHEET = "create_answer_sheet";
export const MATCH_ANSWER_SHEET = "match_answer_sheet";
export const RATE_ANSWER_SHEET = "rate_answer_sheet";

export const ANSWER_SHEET_TOOL_NAMES = new Set([
  GET_ANSWER_SHEETS,
  CREATE_ANSWER_SHEET,
  MATCH_ANSWER_SHEET,
  RATE_ANSWER_SHEET,
]);

interface AnswerSheetToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface AnswerSheetToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Returns the definitions of all answer sheet tools (for tools/list).
 */
export function getAnswerSheetToolDefinitions(): AnswerSheetToolDef[] {
  return [
    {
      name: GET_ANSWER_SHEETS,
      description:
        "Search answer sheets -- proven solution patterns mined from successful agent sessions. " +
        "Filter by problem category, language, or tags. " +
        "Results are sorted by confidence (descending).",
      inputSchema: {
        type: "object",
        properties: {
          problem_category: {
            type: "string",
            description:
              "Filter by problem category. Valid values: edit_mismatch, test_failure, " +
              "import_error, type_error, build_failure, runtime_error, permission_error, " +
              "network_error, config_error, syntax_error, dependency_error, timeout",
          },
          language: {
            type: "string",
            description: 'Filter by programming language (e.g., "typescript", "python", "rust")',
          },
          tag: {
            type: "string",
            description: "Filter by tag",
          },
          min_confidence: {
            type: "number",
            description: "Minimum confidence threshold (0.0 - 1.0)",
          },
          is_public: {
            type: "boolean",
            description: "Filter by public visibility",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default: 50, max: 100)",
          },
        },
      },
    },
    {
      name: CREATE_ANSWER_SHEET,
      description:
        "Create a new answer sheet capturing a proven solution pattern. " +
        "An answer sheet records the error signature, problem category, solution summary, " +
        "and ordered solution steps (step + tool + action + rationale) so the pattern can be reused.",
      inputSchema: {
        type: "object",
        properties: {
          error_signature: {
            type: "string",
            description: "Regex or pattern that matches the error this sheet solves",
          },
          problem_category: {
            type: "string",
            description: 'Category of problem (e.g., "edit_mismatch", "test_failure")',
          },
          solution_summary: {
            type: "string",
            description: "Human-readable summary of the solution",
          },
          solution_steps: {
            type: "array",
            description: "Ordered steps to resolve the issue",
            items: {
              type: "object",
              properties: {
                step: { type: "number", description: "Step number (1-based)" },
                tool: { type: "string", description: 'MCP tool name or action type (e.g., "Edit", "Bash", "Grep")' },
                action: { type: "string", description: 'What this step does (e.g., "find_definition", "apply_fix")' },
                file_pattern: { type: "string", description: "Glob pattern for target files" },
                rationale: { type: "string", description: "Why this step is necessary" },
              },
              required: ["step", "tool", "action", "rationale"],
            },
          },
          source_session_ids: {
            type: "array",
            items: { type: "string" },
            description: "Session IDs this pattern was mined from",
          },
          source_extraction_ids: {
            type: "array",
            items: { type: "string" },
            description: "Extraction IDs this pattern was derived from",
          },
          languages: {
            type: "array",
            items: { type: "string" },
            description: "Programming languages this pattern applies to",
          },
          frameworks: {
            type: "array",
            items: { type: "string" },
            description: "Frameworks this pattern applies to",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Searchable tags",
          },
          repo_context: {
            description: "Repository or language context (JSON object)",
          },
          is_public: {
            type: "boolean",
            description: "Whether this sheet should be visible to other tenants (default: false)",
          },
        },
        required: ["error_signature", "problem_category", "solution_summary", "solution_steps"],
      },
    },
    {
      name: MATCH_ANSWER_SHEET,
      description:
        "Find answer sheets that match a given error message or context. " +
        "Returns matches ranked by a combination of match score and Bayesian confidence. " +
        "Uses error signature regex matching, category matching, and fuzzy text similarity.",
      inputSchema: {
        type: "object",
        properties: {
          error_text: {
            type: "string",
            description: "The error message or text to match against answer sheets",
          },
          context: {
            type: "object",
            description: "Additional context to improve matching accuracy",
            properties: {
              tool_name: { type: "string", description: "Tool that triggered the error" },
              file_path: { type: "string", description: "Path of the file where the error occurred" },
              language: { type: "string", description: "Programming language" },
              recent_tools: {
                type: "array",
                items: { type: "string" },
                description: "Recently used tools for context",
              },
            },
          },
          limit: {
            type: "number",
            description: "Maximum number of matches to return (default: 5)",
          },
          min_confidence: {
            type: "number",
            description: "Minimum confidence threshold for results (default: 0.2)",
          },
          include_public: {
            type: "boolean",
            description: "Include public sheets from other tenants (default: true)",
          },
        },
        required: ["error_text"],
      },
    },
    {
      name: RATE_ANSWER_SHEET,
      description:
        "Submit feedback on an answer sheet to update its Bayesian confidence score. " +
        "Set positive=true when the answer sheet solved the problem, false when it did not. " +
        "Confidence formula: success_count / (success_count + failure_count + 5).",
      inputSchema: {
        type: "object",
        properties: {
          answer_sheet_id: {
            type: "string",
            description: "The ID of the answer sheet to rate",
          },
          positive: {
            type: "boolean",
            description: "true if the answer sheet worked, false if it did not",
          },
          context: {
            type: "string",
            description: "Optional context about the feedback",
          },
          session_id: {
            type: "string",
            description: "Session ID where this sheet was applied",
          },
        },
        required: ["answer_sheet_id", "positive"],
      },
    },
  ];
}

/**
 * Check whether a tool name is an answer sheet tool.
 */
export function isAnswerSheetTool(toolName: string): boolean {
  return ANSWER_SHEET_TOOL_NAMES.has(toolName);
}

/**
 * Handle an answer sheet tool call. Proxies to the KFDB REST API.
 *
 * Requires KFDB_URL and KFDB_API_KEY environment variables.
 */
export async function handleAnswerSheetTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<AnswerSheetToolResult> {
  const kfdbUrl = process.env.KFDB_URL;
  const kfdbApiKey = process.env.KFDB_API_KEY;

  if (!kfdbUrl || !kfdbApiKey) {
    return {
      content: [{
        type: "text",
        text: "Error: KFDB_URL and KFDB_API_KEY environment variables are required for answer sheet tools.",
      }],
      isError: true,
    };
  }

  try {
    switch (toolName) {
      case GET_ANSWER_SHEETS:
        return await handleGetAnswerSheets(args, kfdbUrl, kfdbApiKey);
      case CREATE_ANSWER_SHEET:
        return await handleCreateAnswerSheet(args, kfdbUrl, kfdbApiKey);
      case MATCH_ANSWER_SHEET:
        return await handleMatchAnswerSheet(args, kfdbUrl, kfdbApiKey);
      case RATE_ANSWER_SHEET:
        return await handleRateAnswerSheet(args, kfdbUrl, kfdbApiKey);
      default:
        return {
          content: [{ type: "text", text: `Unknown answer sheet tool: ${toolName}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Answer sheet tool error: ${(error as Error).message}`,
      }],
      isError: true,
    };
  }
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleGetAnswerSheets(
  args: Record<string, unknown>,
  kfdbUrl: string,
  kfdbApiKey: string,
): Promise<AnswerSheetToolResult> {
  const params = new URLSearchParams();
  if (args.problem_category) params.set("problem_category", String(args.problem_category));
  if (args.language) params.set("language", String(args.language));
  if (args.tag) params.set("tag", String(args.tag));
  if (args.min_confidence != null) params.set("min_confidence", String(args.min_confidence));
  if (args.is_public != null) params.set("is_public", String(args.is_public));
  if (args.limit != null) params.set("limit", String(Math.min(Number(args.limit) || 50, 100)));

  const qs = params.toString();
  const res = await fetch(`${kfdbUrl}/api/v1/answer-sheets${qs ? "?" + qs : ""}`, {
    headers: { "X-KF-API-Key": kfdbApiKey },
  });

  if (!res.ok) {
    const body = await res.text();
    return {
      content: [{ type: "text", text: `Failed to search answer sheets: ${res.status} ${body}` }],
      isError: true,
    };
  }

  const data = await res.json();
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

async function handleCreateAnswerSheet(
  args: Record<string, unknown>,
  kfdbUrl: string,
  kfdbApiKey: string,
): Promise<AnswerSheetToolResult> {
  if (!args.error_signature || !args.problem_category || !args.solution_steps || !args.solution_summary) {
    return {
      content: [{
        type: "text",
        text: "Error: error_signature, problem_category, solution_summary, and solution_steps are required.",
      }],
      isError: true,
    };
  }

  const res = await fetch(`${kfdbUrl}/api/v1/answer-sheets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-KF-API-Key": kfdbApiKey,
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const body = await res.text();
    return {
      content: [{ type: "text", text: `Failed to create answer sheet: ${res.status} ${body}` }],
      isError: true,
    };
  }

  const data = await res.json() as Record<string, unknown>;
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        created: true,
        answer_sheet_id: data.answer_sheet_id,
        tenant_id: data.tenant_id,
        confidence: data.confidence,
        created_at: data.created_at,
      }, null, 2),
    }],
  };
}

async function handleMatchAnswerSheet(
  args: Record<string, unknown>,
  kfdbUrl: string,
  kfdbApiKey: string,
): Promise<AnswerSheetToolResult> {
  if (!args.error_text) {
    return {
      content: [{ type: "text", text: "Error: error_text is required." }],
      isError: true,
    };
  }

  const res = await fetch(`${kfdbUrl}/api/v1/answer-sheets/match`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-KF-API-Key": kfdbApiKey,
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const body = await res.text();
    return {
      content: [{ type: "text", text: `Failed to match answer sheets: ${res.status} ${body}` }],
      isError: true,
    };
  }

  const data = await res.json();
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

async function handleRateAnswerSheet(
  args: Record<string, unknown>,
  kfdbUrl: string,
  kfdbApiKey: string,
): Promise<AnswerSheetToolResult> {
  const id = args.answer_sheet_id as string;
  const positive = args.positive;

  if (!id || positive == null) {
    return {
      content: [{ type: "text", text: "Error: answer_sheet_id and positive are required." }],
      isError: true,
    };
  }

  if (typeof positive !== "boolean") {
    return {
      content: [{ type: "text", text: "Error: positive must be a boolean (true or false)." }],
      isError: true,
    };
  }

  const body: Record<string, unknown> = { positive };
  if (args.context) body.context = String(args.context);
  if (args.session_id) body.session_id = String(args.session_id);

  const res = await fetch(`${kfdbUrl}/api/v1/answer-sheets/${encodeURIComponent(id)}/feedback`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-KF-API-Key": kfdbApiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    return {
      content: [{ type: "text", text: `Failed to submit feedback: ${res.status} ${errorBody}` }],
      isError: true,
    };
  }

  const data = await res.json() as Record<string, unknown>;
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        feedback_submitted: true,
        feedback_id: data.feedback_id,
        answer_sheet_id: data.answer_sheet_id,
        old_confidence: data.old_confidence,
        new_confidence: data.new_confidence,
        total_success: data.total_success,
        total_failure: data.total_failure,
      }, null, 2),
    }],
  };
}

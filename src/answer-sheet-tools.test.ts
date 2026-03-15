import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleAnswerSheetTool,
  isAnswerSheetTool,
  getAnswerSheetToolDefinitions,
  GET_ANSWER_SHEETS,
  CREATE_ANSWER_SHEET,
  MATCH_ANSWER_SHEET,
  RATE_ANSWER_SHEET,
} from "./answer-sheet-tools.js";

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

// ── Setup / Teardown ─────────────────────────────────────────────────────────

const KFDB_URL = "https://kfdb.test";
const KFDB_API_KEY = "test-api-key";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("KFDB_URL", KFDB_URL);
  vi.stubEnv("KFDB_API_KEY", KFDB_API_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── Utility exports ──────────────────────────────────────────────────────────

describe("isAnswerSheetTool", () => {
  it("returns true for known tool names", () => {
    expect(isAnswerSheetTool(GET_ANSWER_SHEETS)).toBe(true);
    expect(isAnswerSheetTool(CREATE_ANSWER_SHEET)).toBe(true);
    expect(isAnswerSheetTool(MATCH_ANSWER_SHEET)).toBe(true);
    expect(isAnswerSheetTool(RATE_ANSWER_SHEET)).toBe(true);
  });

  it("returns false for unknown names", () => {
    expect(isAnswerSheetTool("unknown_tool")).toBe(false);
  });
});

describe("getAnswerSheetToolDefinitions", () => {
  it("returns 4 tool definitions", () => {
    const defs = getAnswerSheetToolDefinitions();
    expect(defs).toHaveLength(4);
    const names = defs.map((d) => d.name);
    expect(names).toContain(GET_ANSWER_SHEETS);
    expect(names).toContain(CREATE_ANSWER_SHEET);
    expect(names).toContain(MATCH_ANSWER_SHEET);
    expect(names).toContain(RATE_ANSWER_SHEET);
  });
});

// ── Missing env vars ─────────────────────────────────────────────────────────

describe("handleAnswerSheetTool – missing env", () => {
  it("returns error when KFDB_URL is missing", async () => {
    vi.stubEnv("KFDB_URL", "");
    const result = await handleAnswerSheetTool(GET_ANSWER_SHEETS, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/KFDB_URL/);
  });

  it("returns error when KFDB_API_KEY is missing", async () => {
    vi.stubEnv("KFDB_API_KEY", "");
    const result = await handleAnswerSheetTool(GET_ANSWER_SHEETS, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/KFDB_API_KEY/);
  });
});

// ── Unknown tool ─────────────────────────────────────────────────────────────

describe("handleAnswerSheetTool – unknown tool", () => {
  it("returns error for unrecognized tool name", async () => {
    const result = await handleAnswerSheetTool("no_such_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Unknown answer sheet tool/);
  });
});

// ── get_answer_sheets ────────────────────────────────────────────────────────

describe("get_answer_sheets", () => {
  it("returns results on success", async () => {
    const payload = { sheets: [{ id: "1", confidence: 0.8 }] };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(payload));

    const result = await handleAnswerSheetTool(GET_ANSWER_SHEETS, {});

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(payload);

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(`${KFDB_URL}/api/v1/answer-sheets`);
    expect((call[1] as RequestInit).headers).toEqual({ "X-KF-API-Key": KFDB_API_KEY });
  });

  it("passes query params", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([]));

    await handleAnswerSheetTool(GET_ANSWER_SHEETS, {
      problem_category: "test_failure",
      language: "typescript",
      tag: "vitest",
      min_confidence: 0.5,
      is_public: true,
      limit: 10,
    });

    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("problem_category=test_failure");
    expect(url).toContain("language=typescript");
    expect(url).toContain("tag=vitest");
    expect(url).toContain("min_confidence=0.5");
    expect(url).toContain("is_public=true");
    expect(url).toContain("limit=10");
  });

  it("clamps limit to 100", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([]));

    await handleAnswerSheetTool(GET_ANSWER_SHEETS, { limit: 999 });

    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("limit=100");
  });

  it("returns error on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse("Not Found", 404));

    const result = await handleAnswerSheetTool(GET_ANSWER_SHEETS, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/404/);
  });
});

// ── create_answer_sheet ──────────────────────────────────────────────────────

describe("create_answer_sheet", () => {
  const validArgs = {
    error_signature: "TypeError: .*is not a function",
    problem_category: "type_error",
    solution_summary: "Check import names",
    solution_steps: [{ step: 1, tool: "Grep", action: "find_import", rationale: "locate bad import" }],
  };

  it("creates sheet on success", async () => {
    const responseData = {
      answer_sheet_id: "as-123",
      tenant_id: "t-1",
      confidence: 0,
      created_at: "2026-01-01",
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(responseData));

    const result = await handleAnswerSheetTool(CREATE_ANSWER_SHEET, validArgs);

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.created).toBe(true);
    expect(parsed.answer_sheet_id).toBe("as-123");

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(`${KFDB_URL}/api/v1/answer-sheets`);
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual(validArgs);
  });

  it("validates required fields", async () => {
    const result = await handleAnswerSheetTool(CREATE_ANSWER_SHEET, {
      error_signature: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/required/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns error on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse("Bad Request", 400));

    const result = await handleAnswerSheetTool(CREATE_ANSWER_SHEET, validArgs);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/400/);
  });
});

// ── match_answer_sheet ───────────────────────────────────────────────────────

describe("match_answer_sheet", () => {
  it("returns matches on success", async () => {
    const payload = { matches: [{ id: "as-1", score: 0.95 }] };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(payload));

    const result = await handleAnswerSheetTool(MATCH_ANSWER_SHEET, {
      error_text: "Cannot find module 'foo'",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(payload);

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(`${KFDB_URL}/api/v1/answer-sheets/match`);
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).error_text).toBe("Cannot find module 'foo'");
  });

  it("validates error_text is required", async () => {
    const result = await handleAnswerSheetTool(MATCH_ANSWER_SHEET, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/error_text.*required/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns error on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse("Server Error", 500));

    const result = await handleAnswerSheetTool(MATCH_ANSWER_SHEET, {
      error_text: "some error",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/500/);
  });
});

// ── rate_answer_sheet ────────────────────────────────────────────────────────

describe("rate_answer_sheet", () => {
  it("submits positive feedback", async () => {
    const responseData = {
      feedback_id: "fb-1",
      answer_sheet_id: "as-1",
      old_confidence: 0.3,
      new_confidence: 0.4,
      total_success: 5,
      total_failure: 2,
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(responseData));

    const result = await handleAnswerSheetTool(RATE_ANSWER_SHEET, {
      answer_sheet_id: "as-1",
      positive: true,
      context: "worked perfectly",
      session_id: "sess-1",
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.feedback_submitted).toBe(true);
    expect(parsed.new_confidence).toBe(0.4);

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe(`${KFDB_URL}/api/v1/answer-sheets/as-1/feedback`);
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.positive).toBe(true);
    expect(body.context).toBe("worked perfectly");
    expect(body.session_id).toBe("sess-1");
  });

  it("validates answer_sheet_id is required", async () => {
    const result = await handleAnswerSheetTool(RATE_ANSWER_SHEET, {
      positive: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/answer_sheet_id.*required/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates positive is required", async () => {
    const result = await handleAnswerSheetTool(RATE_ANSWER_SHEET, {
      answer_sheet_id: "as-1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/required/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates positive must be boolean", async () => {
    const result = await handleAnswerSheetTool(RATE_ANSWER_SHEET, {
      answer_sheet_id: "as-1",
      positive: "yes",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/boolean/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("encodes special characters in answer_sheet_id", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ feedback_id: "fb-2" }));

    await handleAnswerSheetTool(RATE_ANSWER_SHEET, {
      answer_sheet_id: "id/with spaces",
      positive: false,
    });

    const url = vi.mocked(fetch).mock.calls[0][0] as string;
    expect(url).toContain("id%2Fwith%20spaces");
  });

  it("returns error on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(textResponse("Conflict", 409));

    const result = await handleAnswerSheetTool(RATE_ANSWER_SHEET, {
      answer_sheet_id: "as-1",
      positive: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/409/);
  });
});

// ── fetch throwing ───────────────────────────────────────────────────────────

describe("handleAnswerSheetTool – network error", () => {
  it("catches fetch exceptions and returns isError", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network failure"));

    const result = await handleAnswerSheetTool(GET_ANSWER_SHEETS, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Network failure/);
  });
});

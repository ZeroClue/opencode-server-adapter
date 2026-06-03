import { describe, expect, it, vi, beforeEach } from "vitest";
import { execute } from "../execute.js";

vi.mock("../lifecycle.js", () => ({
  ensureOpenCodeServerRunning: vi.fn().mockResolvedValue(true),
}));

describe("execute", () => {
  const baseCtx: any = {
    runId: "run-123",
    agent: { id: "agent-1", companyId: "co-1" },
    runtime: { sessionId: "", sessionParams: {} },
    config: {
      model: "opencode-go/deepseek-v4-flash",
      hostname: "127.0.0.1",
      port: 4096,
      command: "opencode",
      timeoutSec: 30,
    },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a session and returns execution result on success", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      callCount++;
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ id: "ses_live_123" }) } as Response;
      }
      if (url.includes("/message")) {
        return {
          ok: true,
          json: async () => ({
            cost: 0,
            tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            parts: [
              { type: "text", text: "Task completed." },
              { type: "step-finish", tokens: { input: 150, output: 40, cache: { read: 20, write: 0 } }, cost: 0.002 },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const result = await execute(baseCtx);

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("ses_live_123");
    expect(result.summary).toBe("Task completed.");
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 40, cachedInputTokens: 20 });
    expect(result.costUsd).toBe(0.002);
  });

  it("resumes an existing session when sessionId is provided", async () => {
    const resumeCtx = {
      ...baseCtx,
      runtime: { sessionId: "ses_prev_456", sessionParams: { sessionId: "ses_prev_456" } },
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/message")) {
        return {
          ok: true,
          json: async () => ({
            cost: 0.0005,
            tokens: { input: 50, output: 10, cache: { read: 40, write: 0 } },
            parts: [{ type: "text", text: "Resumed and completed." }],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const result = await execute(resumeCtx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("ses_prev_456");
  });

  it("returns error result on server failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"));

    const result = await execute(baseCtx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Connection refused");
  });

  it("handles non-ok session creation response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500, text: async () => "Server error" } as Response);

    const result = await execute(baseCtx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("500");
  });
});
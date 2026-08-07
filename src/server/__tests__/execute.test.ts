import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execute } from "../execute.js";

vi.mock("../lifecycle.js", () => ({
  ensureOpenCodeServerRunning: vi.fn().mockResolvedValue(true),
}));

vi.mock("../skills.js", () => ({
  pushSkillsToRemote: vi.fn(async () => {}),
}));

vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>();
  return {
    ...actual,
    runSshCommand: vi.fn(async () => ({ stdout: "/home/opencode\n", stderr: "" })),
    syncDirectoryToSsh: vi.fn(async () => {}),
    prepareWorkspaceForSshExecution: vi.fn(async () => {}),
    restoreWorkspaceFromSshExecution: vi.fn(async () => {}),
  };
});

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

  const messageMock = () =>
    ({
      ok: true,
      json: async () => ({
        cost: 0,
        tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        parts: [{ type: "text", text: "Task completed." }],
      }),
    }) as Response;

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
            cost: 0.002,
            tokens: { input: 150, output: 40, cache: { read: 20, write: 0 } },
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

  it("injects instructions into the prompt on a fresh session", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-instr-"));
    const filePath = path.join(tmp, "AGENTS.md");
    fs.writeFileSync(filePath, "You are a build agent.\n");

    const ctx = {
      ...baseCtx,
      config: { ...baseCtx.config, instructionsFilePath: filePath },
    };

    let sentBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ id: "ses_new" }) } as Response;
      }
      if (url.includes("/message")) {
        sentBody = String(init?.body);
        return messageMock();
      }
      return { ok: false, status: 404 } as Response;
    });

    await execute(ctx);
    expect(sentBody).toContain("You are a build agent.");
    expect(sentBody).toContain(filePath);
  });

  it("rewrites host workspace paths in instructions to the remote cwd", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-instr-"));
    const filePath = path.join(tmp, "AGENTS.md");
    fs.writeFileSync(
      filePath,
      "Navigate to `cd ~/.paperclip/instances/default/projects/abc/123/MFTxyz/` before working.\n",
    );

    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        instructionsFilePath: filePath,
        sshHost: "100.122.131.96",
        sshPort: 2222,
        sshUsername: "opc",
        sshPrivateKey: "key",
        remoteServerCwd: "/work",
      },
    };

    let sentBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ id: "ses_new" }) } as Response;
      }
      if (url.includes("/message")) {
        sentBody = String(init?.body);
        return messageMock();
      }
      return { ok: false, status: 404 } as Response;
    });

    await execute(ctx);
    expect(sentBody).not.toContain("/home/arminm");
    expect(sentBody).not.toContain(".paperclip/instances");
    expect(sentBody).toContain("/work");
  });

  it("forwards GH_TOKEN from agent config env into the remote env file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-gh-"));
    const filePath = path.join(tmp, "AGENTS.md");
    fs.writeFileSync(filePath, "You are a build agent.\n");

    const ctx = {
      ...baseCtx,
      config: {
        ...baseCtx.config,
        instructionsFilePath: filePath,
        agentHomeDir: tmp,
        agentHomeRemoteDir: "/home/opc/agent-home",
        sshHost: "100.122.131.96",
        sshPort: 2222,
        sshUsername: "opc",
        sshPrivateKey: "key",
        remoteServerCwd: "/work",
        env: {
          GH_TOKEN: "gho_super-secret-token",
          API_TIMEOUT_MS: "3000000",
        },
      },
    };

    let envScript = "";
    const runSsh = await import("@paperclipai/adapter-utils/ssh");
    (runSsh.runSshCommand as any).mockImplementation(async (spec: unknown, script: string) => {
      if (script.includes(".paperclip-env.json")) envScript = script;
      return { stdout: "/home/opc\n", stderr: "", exitCode: 0 };
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ id: "ses_env" }) } as Response;
      }
      if (url.includes("/message")) {
        return messageMock();
      }
      return { ok: false, status: 404 } as Response;
    });

    await execute(ctx);
    expect(envScript).toContain("GH_TOKEN");
    expect(envScript).toContain("gho_super-secret-token");
    expect(envScript).toContain("3000000");
  });

  it("does not re-inject instructions on a resumed session", async () => {    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-instr-"));
    const filePath = path.join(tmp, "AGENTS.md");
    fs.writeFileSync(filePath, "You are a build agent.\n");

    const ctx = {
      ...baseCtx,
      runtime: { sessionId: "ses_prev", sessionParams: { sessionId: "ses_prev" } },
      config: { ...baseCtx.config, instructionsFilePath: filePath },
    };

    let sentBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/message")) {
        sentBody = String(init?.body);
        return messageMock();
      }
      return { ok: false, status: 404 } as Response;
    });

    await execute(ctx);
    expect(sentBody).not.toContain("You are a build agent.");
  });

  it("does not resume a session whose cwd differs from the execution cwd", async () => {
    const ctx = {
      ...baseCtx,
      config: { ...baseCtx.config, cwd: "/repo/a" },
      runtime: { sessionId: "ses_other", sessionParams: { sessionId: "ses_other", cwd: "/repo/b" } },
    };

    const createdSessionIds: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        createdSessionIds.push("ses_fresh");
        return { ok: true, json: async () => ({ id: "ses_fresh" }) } as Response;
      }
      if (url.includes("/message")) {
        return messageMock();
      }
      return { ok: false, status: 404 } as Response;
    });

    await execute(ctx);
    expect(createdSessionIds).toEqual(["ses_fresh"]);
    expect(ctx.runtime.sessionParams.sessionId).toBe("ses_other");
  });

  it("resumes a session whose cwd matches the execution cwd", async () => {
    const ctx = {
      ...baseCtx,
      config: { ...baseCtx.config, cwd: "/repo/a" },
      runtime: { sessionId: "ses_same", sessionParams: { sessionId: "ses_same", cwd: "/repo/a" } },
    };

    const createdSessionIds: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        createdSessionIds.push("ses_fresh");
        return { ok: true, json: async () => ({ id: "ses_fresh" }) } as Response;
      }
      if (url.includes("/message")) {
        return messageMock();
      }
      return { ok: false, status: 404 } as Response;
    });

    const result = await execute(ctx);
    expect(createdSessionIds).toEqual([]);
    expect(result.sessionId).toBe("ses_same");
  });

  it("recovers from a dropped message POST using the SSE completion state", async () => {
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"message.part.updated","properties":{"part":{"id":"p1","type":"text","text":"Done via SSE"}}}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"message.updated","properties":{"info":{"role":"assistant","finish":"stop","tokens":{"input":90,"output":30,"reasoning":5,"cache":{"read":10,"write":0}},"cost":0.123}}}\n\n',
          ),
        );
        controller.enqueue(encoder.encode('data: {"type":"session.idle","properties":{}}\n\n'));
        controller.close();
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/event")) {
        return { ok: true, body: sseBody } as unknown as Response;
      }
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ id: "ses_drop" }) } as Response;
      }
      if (url.includes("/message")) {
        throw new Error("fetch failed");
      }
      return { ok: false, status: 404 } as Response;
    });

    const logs: string[] = [];
    const ctx = {
      ...baseCtx,
      onLog: async (_stream: string, chunk: string) => {
        logs.push(chunk);
      },
    };

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("ses_drop");
    expect(result.summary).toBe("Done via SSE");
    expect(result.costUsd).toBe(0.123);
    expect(result.usage).toEqual({ inputTokens: 90, outputTokens: 35, cachedInputTokens: 10 });
    expect(logs.some((l) => l.includes("Done via SSE"))).toBe(true);
  });

  it("fails when the message POST drops and SSE reports no completion", async () => {
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message.part.updated","properties":{"part":{"id":"p1","type":"text","text":"partial"}}}\n\n'));
        controller.close();
      },
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/event")) {
        return { ok: true, body: sseBody } as unknown as Response;
      }
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ id: "ses_partial" }) } as Response;
      }
      if (url.includes("/message")) {
        throw new Error("fetch failed");
      }
      return { ok: false, status: 404 } as Response;
    });

    const result = await execute(baseCtx);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("fetch failed");
  });

  it("forwards the resolved agent env into onMeta invocation metadata", async () => {
    const ctx = {
      ...baseCtx,
      config: { ...baseCtx.config, env: { GH_TOKEN: "gho_meta-token", API_TIMEOUT_MS: "900000" } },
    };

    let receivedMeta: Record<string, unknown> | null = null;
    const executeWithMeta = { ...ctx, onMeta: async (meta: unknown) => { receivedMeta = meta as Record<string, unknown>; } };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ id: "ses_meta" }) } as Response;
      }
      if (url.includes("/message")) {
        return messageMock();
      }
      return { ok: false, status: 404 } as Response;
    });

    await execute(executeWithMeta);
    expect(receivedMeta).not.toBeNull();
    const meta = receivedMeta as unknown as { env?: Record<string, string>; adapterType?: string };
    expect(meta.env).toBeDefined();
    expect(meta.env).not.toEqual({});
    expect(meta.env?.GH_TOKEN).toBe("gho_meta-token");
    expect(meta.env?.API_TIMEOUT_MS).toBe("900000");
    expect(meta.adapterType).toBe("opencode_server");
  });

  it("reports timedOut when the message POST is aborted by AbortSignal.timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ id: "ses_to" }) } as Response;
      }
      if (url.includes("/message")) {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return { ok: false, status: 404 } as Response;
    });

    const result = await execute(baseCtx);
    expect(result.exitCode).toBe(-1);
    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("Timed out");
  });

  it("aggregates usage from step-finish parts only when message-level tokens are zero", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (init?.method === "POST" && url.includes("/session") && !url.includes("/message")) {
        return { ok: true, json: async () => ({ id: "ses_agg" }) } as Response;
      }
      if (url.includes("/message")) {
        return {
          ok: true,
          json: async () => ({
            cost: 0,
            tokens: undefined,
            parts: [
              { type: "text", text: "Done." },
              { type: "step-finish", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 0 } }, cost: 0.001 },
              { type: "step-finish", tokens: { input: 200, output: 10, reasoning: 0, cache: { read: 40, write: 0 } }, cost: 0.005 },
            ],
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    });

    const result = await execute(baseCtx);
    expect(result.costUsd).toBe(0.006);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 35, cachedInputTokens: 70 });
  });
});
import { describe, expect, it } from "vitest";
import { parseStdoutLine } from "../../ui-parser.js";

describe("ui-parser", () => {
  it("parses assistant text events", () => {
    const ts = "2026-06-03T00:00:00.000Z";
    const result = parseStdoutLine(
      JSON.stringify({ type: "text", part: { text: "Hello from the agent" } }),
      ts,
    );
    expect(result).toEqual([{ kind: "assistant", ts, text: "Hello from the agent" }]);
  });

  it("parses reasoning/thinking blocks", () => {
    const ts = "2026-06-03T00:00:00.000Z";
    const result = parseStdoutLine(
      JSON.stringify({ type: "reasoning", part: { text: "thinking step by step" } }),
      ts,
    );
    expect(result).toEqual([{ kind: "thinking", ts, text: "thinking step by step" }]);
  });

  it("parses tool_use events into call + result entries", () => {
    const ts = "2026-06-03T00:00:00.000Z";
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        callID: "call_1",
        tool: "write",
        state: {
          status: "completed",
          input: { filePath: "/tmp/test.txt" },
          output: "File written successfully",
          metadata: { exit: 0 },
        },
      },
    });
    const result = parseStdoutLine(line, ts);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ kind: "tool_call", name: "write", toolUseId: "call_1" });
    expect(result[1]).toMatchObject({ kind: "tool_result", isError: false });
  });

  it("parses tool_use errors correctly", () => {
    const ts = "2026-06-03T00:00:00.000Z";
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        callID: "call_2",
        tool: "bash",
        state: { status: "error", error: "Command failed", input: { command: "rm -rf /" } },
      },
    });
    const result = parseStdoutLine(line, ts);
    expect(result[1]).toMatchObject({ kind: "tool_result", isError: true });
  });

  it("parses step_finish into result with token counts", () => {
    const ts = "2026-06-03T00:00:00.000Z";
    const line = JSON.stringify({
      type: "step_finish",
      part: { reason: "tool-calls", cost: 0.001, tokens: { input: 100, output: 30, reasoning: 10, cache: { read: 20 } } },
    });
    const result = parseStdoutLine(line, ts);
    expect(result[0]).toMatchObject({
      kind: "result",
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 20,
      costUsd: 0.001,
    });
  });

  it("prepends a status: and metadata header to tool results (exit-code parity)", () => {
    const ts = "2026-06-03T00:00:00.000Z";
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        callID: "call_exit",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "git fetch" },
          output: "Done",
          metadata: { exit: 0, exit_code: 0 },
        },
      },
    });
    const result = parseStdoutLine(line, ts);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ kind: "tool_result" });
    const content = (result[1] as { content?: string }).content ?? "";
    expect(content).toContain("status: completed");
    expect(content).toContain("exit: 0");
    expect(content).toContain("exit_code: 0");
    expect(content).toContain("Done");
  });

  it("falls back to part.id for the tool use id", () => {
    const ts = "2026-06-03T00:00:00.000Z";
    const line = JSON.stringify({
      type: "tool_use",
      part: { id: "call_id_alt", tool: "read", state: { status: "completed", output: "ok" } },
    });
    const result = parseStdoutLine(line, ts);
    expect(result[0]).toMatchObject({ kind: "tool_call", toolUseId: "call_id_alt" });
  });

  it("does not emit a tool_result for in-progress tools", () => {
    const ts = "2026-06-03T00:00:00.000Z";
    const line = JSON.stringify({
      type: "tool_use",
      part: { callID: "call_run", tool: "bash", state: { status: "running" } },
    });
    const result = parseStdoutLine(line, ts);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("tool_call");
  });

  it("handles raw stdout lines that aren't JSON", () => {
    const ts = "2026-06-03T00:00:00.000Z";
    const result = parseStdoutLine("plain text line", ts);
    expect(result).toEqual([{ kind: "stdout", ts, text: "plain text line" }]);
  });
});
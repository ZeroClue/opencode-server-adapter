import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  try {
    const parsed = JSON.parse(line);
    const type = parsed.type;

    if (type === "text") {
      const text = parsed.part?.text || parsed.text || "";
      if (!text.trim()) return [];
      return [{ kind: "assistant", ts, text }];
    }

    if (type === "reasoning") {
      const text = parsed.part?.text || "";
      if (!text.trim()) return [];
      return [{ kind: "thinking", ts, text }];
    }

    if (type === "tool_use") {
      const tool = parsed.part?.tool || "tool";
      const callID = parsed.part?.callID || parsed.part?.id || "";
      const state = parsed.part?.state || {};
      const input = state.input || {};
      const callEntry: TranscriptEntry = {
        kind: "tool_call", ts, name: tool,
        toolUseId: callID || undefined, input,
      };
      if (state.status !== "completed" && state.status !== "error") return [callEntry];
      const rawOutput = state.output || state.error || `${tool} ${state.status}`;
      // The board renders tool results by searching these header lines for
      // status / exit_code / error tokens. The built-in `opencode_local`
      // parser prepends every metadata field as a key: value line; match it
      // so exit codes and other run feedback are surfaced, not dropped.
      const header: string[] = [`status: ${state.status}`];
      if (state.metadata && typeof state.metadata === "object") {
        for (const [key, value] of Object.entries(state.metadata)) {
          if (value !== undefined && value !== null) header.push(`${key}: ${value}`);
        }
      }
      const content = `${header.join("\n")}\n\n${rawOutput}`.trim();
      return [
        callEntry,
        { kind: "tool_result", ts, toolUseId: callID || tool, content, isError: state.status === "error" },
      ];
    }

    if (type === "step_start") {
      return [{ kind: "system", ts, text: `step started${parsed.sessionID ? ` (${parsed.sessionID})` : ""}` }];
    }

    if (type === "step_finish" || type === "step-finish") {
      const tokens = parsed.part?.tokens || {};
      return [{
        kind: "result", ts, text: parsed.part?.reason || "step",
        inputTokens: tokens.input || 0,
        outputTokens: (tokens.output || 0) + (tokens.reasoning || 0),
        cachedTokens: tokens.cache?.read || 0,
        costUsd: parsed.part?.cost || 0,
        subtype: parsed.part?.reason || "step", isError: false, errors: [],
      }];
    }

    if (type === "error") {
      const message = parsed.error?.message || parsed.message || "";
      return [{ kind: "stderr", ts, text: message || line }];
    }

    return [{ kind: "stdout", ts, text: line }];
  } catch {
    return [{ kind: "stdout", ts, text: line }];
  }
}
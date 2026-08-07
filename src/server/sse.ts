import type { ServerConnection } from "./conn.js";
import { basicAuthHeaders, serverUrl } from "./conn.js";

export interface SseEvent {
  id?: string;
  type: string;
  properties?: Record<string, unknown>;
}

export interface SseRunState {
  completed: boolean;
  summary: string;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number } | null;
  costUsd: number;
}

/**
 * Open a streaming connection to `opencode serve`'s `/event` endpoint and
 * yield each parsed SSE event as it arrives. Returns null when the endpoint
 * is unavailable (non-ok, missing body, or fetch error) so callers can fall
 * back to the buffered message response without failing.
 */
export async function openSseEventStream(
  conn: ServerConnection,
  signal: AbortSignal,
): Promise<AsyncGenerator<SseEvent> | null> {
  const url = `${serverUrl(conn)}/event`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "text/event-stream", ...basicAuthHeaders(conn) },
      signal,
    });
  } catch {
    return null;
  }
  if (!res.ok || !res.body) return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function* generate(): AsyncGenerator<SseEvent> {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const event = JSON.parse(payload) as SseEvent;
            yield event;
          } catch {
            // Malformed SSE line; skip it.
          }
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  return generate();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emitTranscriptLine(onLog: AdapterOnLog, obj: Record<string, unknown>): void {
  void onLog?.(`stdout`, `${JSON.stringify(obj)}\n`);
}

type AdapterOnLog = ((stream: "stdout" | "stderr", chunk: string) => Promise<void> | void) | undefined;

/**
 * Consume an SSE event stream, emitting ui-parser-compatible NDJSON lines to
 * `onLog` (so the run transcript shows the model's thinking, messages, and
 * tool calls live) and accumulating completion state for the run result.
 * Resolves when the stream ends (naturally, on abort, or on `session.idle`).
 */
export async function consumeSseEvents(
  stream: AsyncGenerator<SseEvent>,
  onLog: AdapterOnLog,
  state: SseRunState,
): Promise<void> {
  const partTypes = new Map<string, string>();
  const partText = new Map<string, string>();
  const emittedParts = new Set<string>();
  let assistantTokenInfo: { input: number; output: number; reasoning: number; cacheRead: number } | null = null;
  let assistantCost = 0;

  for await (const event of stream) {
    const props = asRecord(event.properties);
    const type = event.type;

    if (type === "message.part.updated") {
      const part = asRecord(props.part);
      const partType = asString(part.type);
      const partID = asString(part.id);
      if (partID) partTypes.set(partID, partType);

      if (partType === "text" || partType === "reasoning") {
        const text = asString(part.text);
        if (partID) partText.set(partID, text);
        if (partID && text.trim() && !emittedParts.has(partID)) {
          emittedParts.add(partID);
          emitTranscriptLine(onLog, { type: partType, part: { text } });
          if (partType === "text") {
            const summary = state.summary ? `${state.summary}\n\n${text}` : text;
            state.summary = summary;
          }
        }
      } else if (partType === "tool") {
        const tool = asString(part.tool);
        const callID = asString(part.callID);
        const toolState = asRecord(part.state);
        emitTranscriptLine(onLog, { type: "tool_use", part: { tool, callID, state: toolState } });
      } else if (partType === "step-start") {
        emitTranscriptLine(onLog, { type: "step_start", sessionID: props.sessionID });
      } else if (partType === "step-finish") {
        const tokens = asRecord(part.tokens);
        const cache = asRecord(tokens.cache);
        emitTranscriptLine(onLog, {
          type: "step_finish",
          part: {
            tokens: {
              input: asNumber(tokens.input),
              output: asNumber(tokens.output),
              reasoning: asNumber(tokens.reasoning),
              cache: { read: asNumber(cache.read), write: asNumber(cache.write) },
            },
            cost: asNumber(part.cost),
          },
        });
      }
      continue;
    }

    if (type === "message.part.delta") {
      const partID = asString(props.partID);
      const partType = partTypes.get(partID) ?? "text";
      if (partType !== "text" && partType !== "reasoning") continue;
      const field = asString(props.field);
      const delta = asString(props.delta);
      if (field !== "text" || !delta) continue;
      const current = partText.get(partID) ?? "";
      partText.set(partID, current + delta);
      continue;
    }

    if (type === "message.updated") {
      const info = asRecord(props.info);
      const role = asString(info.role);
      const finish = asString(info.finish);
      if (role !== "assistant") continue;
      const tokens = asRecord(info.tokens);
      const cache = asRecord(tokens.cache);
      assistantTokenInfo = {
        input: asNumber(tokens.input),
        output: asNumber(tokens.output),
        reasoning: asNumber(tokens.reasoning),
        cacheRead: asNumber(cache.read),
      };
      assistantCost = asNumber(info.cost);
      if (finish === "stop" || finish === "error") {
        // The assistant message completed; flush remaining text parts.
        for (const [partID, text] of partText) {
          if (!emittedParts.has(partID)) {
            const partType = partTypes.get(partID) ?? "text";
            if (partType === "text" && text.trim()) {
              emittedParts.add(partID);
              emitTranscriptLine(onLog, { type: "text", part: { text } });
              state.summary = state.summary ? `${state.summary}\n\n${text}` : text;
            } else if (partType === "reasoning" && text.trim()) {
              emittedParts.add(partID);
              emitTranscriptLine(onLog, { type: "reasoning", part: { text } });
            }
          }
        }
        state.tokens = assistantTokenInfo;
        state.costUsd = assistantCost;
        state.completed = true;
      }
      continue;
    }

    if (type === "session.idle") {
      for (const [partID, text] of partText) {
        if (!emittedParts.has(partID)) {
          const partType = partTypes.get(partID) ?? "text";
          if (partType === "text" && text.trim()) {
            emittedParts.add(partID);
            emitTranscriptLine(onLog, { type: "text", part: { text } });
            state.summary = state.summary ? `${state.summary}\n\n${text}` : text;
          } else if (partType === "reasoning" && text.trim()) {
            emittedParts.add(partID);
            emitTranscriptLine(onLog, { type: "reasoning", part: { text } });
          }
        }
      }
      if (assistantTokenInfo) state.tokens = assistantTokenInfo;
      state.costUsd = assistantCost;
      state.completed = true;
      break;
    }
  }

  // Stream ended without an explicit completion marker (e.g. abort).
  if (assistantTokenInfo) state.tokens = assistantTokenInfo;
  if (assistantCost) state.costUsd = assistantCost;
}

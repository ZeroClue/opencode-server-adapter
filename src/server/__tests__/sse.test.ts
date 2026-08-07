import { describe, expect, it, vi, beforeEach } from "vitest";
import { consumeSseEvents, openSseEventStream, type SseEvent } from "../sse.js";

describe("consumeSseEvents", () => {
  const makeStream = (events: SseEvent[]): AsyncGenerator<SseEvent> =>
    (async function* () {
      for (const event of events) yield event;
    })();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("emits text parts as ui-parser NDJSON lines", async () => {
    const logs: Array<[string, string]> = [];
    const state = { completed: false, summary: "", tokens: null, costUsd: 0 };
    await consumeSseEvents(
      makeStream([
        { type: "message.part.updated", properties: { part: { id: "p1", type: "text", text: "Hello" } } },
      ]),
      (stream, chunk) => {
        logs.push([stream, chunk]);
        return Promise.resolve();
      },
      state,
    );
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toBe("stdout");
    expect(JSON.parse(logs[0][1])).toEqual({ type: "text", part: { text: "Hello" } });
    expect(state.summary).toBe("Hello");
  });

  it("marks completed with tokens and cost from final assistant message", async () => {
    const logs: Array<[string, string]> = [];
    const state = { completed: false, summary: "", tokens: null, costUsd: 0 };
    await consumeSseEvents(
      makeStream([
        {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              finish: "stop",
              tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 30, write: 0 } },
              cost: 0.42,
            },
          },
        },
        { type: "session.idle", properties: {} },
      ]),
      (stream, chunk) => {
        logs.push([stream, chunk]);
        return Promise.resolve();
      },
      state,
    );
    expect(state.completed).toBe(true);
    expect(state.tokens).toEqual({ input: 100, output: 50, reasoning: 10, cacheRead: 30 });
    expect(state.costUsd).toBe(0.42);
  });

  it("accumulates text deltas into a part and flushes on completion", async () => {
    const logs: Array<[string, string]> = [];
    const state = { completed: false, summary: "", tokens: null, costUsd: 0 };
    await consumeSseEvents(
      makeStream([
        { type: "message.part.delta", properties: { partID: "p9", field: "text", delta: "Hi" } },
        { type: "message.part.delta", properties: { partID: "p9", field: "text", delta: " there" } },
        {
          type: "message.updated",
          properties: { info: { role: "assistant", finish: "stop", tokens: {}, cost: 0 } },
        },
      ]),
      (stream, chunk) => {
        logs.push([stream, chunk]);
        return Promise.resolve();
      },
      state,
    );
    const emitted = logs.map(([, c]) => JSON.parse(c));
    const textLines = emitted.filter((e) => e.type === "text");
    expect(textLines.map((e) => e.part.text)).toContain("Hi there");
  });

  it("emits tool_use and step_start lines", async () => {
    const logs: Array<[string, string]> = [];
    const state = { completed: false, summary: "", tokens: null, costUsd: 0 };
    await consumeSseEvents(
      makeStream([
        {
          type: "message.part.updated",
          properties: { part: { id: "p2", type: "step-start" } },
        },
        {
          type: "message.part.updated",
          properties: {
            part: { id: "p3", type: "tool", tool: "bash", callID: "call_1", state: { status: "completed", output: "ok" } },
          },
        },
      ]),
      (stream, chunk) => {
        logs.push([stream, chunk]);
        return Promise.resolve();
      },
      state,
    );
    const emitted = logs.map(([, c]) => JSON.parse(c));
    expect(emitted.some((e) => e.type === "step_start")).toBe(true);
    expect(emitted.some((e) => e.type === "tool_use" && e.part.tool === "bash")).toBe(true);
  });
});

describe("openSseEventStream", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when the endpoint is not ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 404 } as Response);
    const result = await openSseEventStream({ hostname: "127.0.0.1", port: 4096 }, new AbortController().signal);
    expect(result).toBeNull();
  });

  it("returns null when fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"));
    const result = await openSseEventStream({ hostname: "127.0.0.1", port: 4096 }, new AbortController().signal);
    expect(result).toBeNull();
  });

  it("yields parsed SSE data events", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"message.part.updated","properties":{"part":{"type":"text","text":"hi"}}}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"session.idle","properties":{}}\n\n'));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, body } as unknown as Response);

    const stream = await openSseEventStream({ hostname: "127.0.0.1", port: 4096 }, new AbortController().signal);
    expect(stream).not.toBeNull();
    const events: SseEvent[] = [];
    for await (const event of stream!) events.push(event);
    expect(events.map((e) => e.type)).toEqual(["message.part.updated", "session.idle"]);
  });
});

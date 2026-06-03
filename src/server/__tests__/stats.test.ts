import { describe, expect, it, vi, beforeEach } from "vitest";
import { getOpenCodeServerQuota } from "../stats.js";

describe("getOpenCodeServerQuota", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("aggregates cost and tokens from session history", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "s1", cost: 0.01, tokens_input: 1000, tokens_output: 100, tokens_cache_read: 500 },
        { id: "s2", cost: 0.02, tokens_input: 2000, tokens_output: 200, tokens_cache_read: 1000 },
      ],
    } as Response);

    const result = await getOpenCodeServerQuota({ hostname: "127.0.0.1", port: 4096 });
    expect(result.ok).toBe(true);
    expect(result.provider).toBe("opencode-server");
    expect(result.source).toBe("session-history");
    expect(result.windows.length).toBeGreaterThan(0);

    const costWindow = result.windows.find((w) => w.label === "Total cost");
    expect(costWindow?.valueLabel).toContain("0.0300");
  });

  it("returns not ok on empty session list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const result = await getOpenCodeServerQuota({ hostname: "127.0.0.1", port: 4096 });
    expect(result.ok).toBe(false);
    expect(result.windows).toEqual([]);
  });

  it("returns not ok on server error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, status: 500 } as Response);
    const result = await getOpenCodeServerQuota({ hostname: "127.0.0.1", port: 4096 });
    expect(result.ok).toBe(false);
  });

  it("returns not ok on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"));
    const result = await getOpenCodeServerQuota({ hostname: "127.0.0.1", port: 4096 });
    expect(result.ok).toBe(false);
  });
});
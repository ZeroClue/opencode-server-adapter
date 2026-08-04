import { describe, expect, it, vi, beforeEach } from "vitest";
import { listOpenCodeServerModels } from "../models.js";

describe("listOpenCodeServerModels", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns models from connected providers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        connected: ["opencode-go", "zai-coding-plan"],
        default: { "opencode-go": "deepseek-v4-flash", "zai-coding-plan": "glm-5-turbo" },
      }),
    } as Response);

    const models = await listOpenCodeServerModels({ hostname: "127.0.0.1", port: 4096 });
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ id: "opencode-go/deepseek-v4-flash", label: "opencode-go/deepseek-v4-flash" });
    expect(models[1]).toEqual({ id: "zai-coding-plan/glm-5-turbo", label: "zai-coding-plan/glm-5-turbo" });
  });

  it("returns empty array on server failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"));
    const models = await listOpenCodeServerModels({ hostname: "127.0.0.1", port: 4096 });
    expect(models).toEqual([]);
  });

  it("returns empty array when no providers are connected", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ connected: [], default: {} }),
    } as Response);
    const models = await listOpenCodeServerModels({ hostname: "127.0.0.1", port: 4096 });
    expect(models).toEqual([]);
  });

  it("reaches the configured non-localhost hostname and port", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ connected: [], default: {} }),
    } as Response);

    await listOpenCodeServerModels({ hostname: "10.20.30.40", port: 5050 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://10.20.30.40:5050/provider");
  });

  it("sends HTTP Basic Authorization header when password is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ connected: [], default: {} }),
    } as Response);

    await listOpenCodeServerModels({ hostname: "10.20.30.40", port: 5050, password: "s3cret" });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
  });

  it("does not set Authorization when no password is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ connected: [], default: {} }),
    } as Response);

    await listOpenCodeServerModels({ hostname: "10.20.30.40", port: 5050 });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });
});
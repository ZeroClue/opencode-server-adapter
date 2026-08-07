import { describe, expect, it, vi, beforeEach } from "vitest";
import { createServerAdapter } from "../index.js";

describe("createServerAdapter discovery hooks", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("listModels uses the per-agent discovery ctx config over the default connection", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ connected: [], default: {} }),
    } as Response);

    const adapter = createServerAdapter();
    await adapter.listModels?.({
      agentId: "agent_1",
      companyId: "company_1",
      adapterType: "opencode_server",
      config: { hostname: "10.20.30.40", port: 5050, password: "s3cret" },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://10.20.30.40:5050/provider");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
  });

  it("listModels falls back to the default connection when no ctx is supplied", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ connected: [], default: {} }),
    } as Response);

    const adapter = createServerAdapter();
    await adapter.listModels?.();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4096/provider");
  });

  it("getQuotaWindows uses the per-agent discovery ctx config over the default connection", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const adapter = createServerAdapter();
    await adapter.getQuotaWindows?.({
      agentId: "agent_1",
      companyId: "company_1",
      adapterType: "opencode_server",
      config: { hostname: "10.20.30.40", port: 5050 },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://10.20.30.40:5050/session?limit=100");
  });

  it("getQuotaWindows falls back to the default connection when no ctx is supplied", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [],
    } as Response);

    const adapter = createServerAdapter();
    await adapter.getQuotaWindows?.();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4096/session?limit=100");
  });
});

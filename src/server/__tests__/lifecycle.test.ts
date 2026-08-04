import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ChildProcess } from "node:child_process";

type ExitHandler = (code: number | null, signal: string | null) => void;

interface FakeChild {
  pid: number;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  emitExit: () => void;
}

let spawned: FakeChild[] = [];

function createFakeChild(pid: number): FakeChild {
  const handlers: Record<string, ExitHandler[]> = {};
  return {
    pid,
    killed: false,
    kill: vi.fn(() => {
      (fake as unknown as FakeChild).killed = true;
    }),
    on: vi.fn((event: string, handler: ExitHandler) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    emitExit() {
      for (const h of handlers.exit ?? []) h(0, null);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function fake() {}
}

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const fake = createFakeChild(10000 + spawned.length);
    spawned.push(fake);
    return fake as unknown as ChildProcess;
  }),
}));

// Re-import after mock is set up. Lifecycle.ts imports spawn via node:child_process;
// our vi.mock intercepts that specifier.
const { ensureOpenCodeServerRunning, getChildPid, stopOpenCodeServer, REMOTE_UNREACHABLE_ERROR } =
  await import("../lifecycle.js");
const child_process = await import("node:child_process");

function setSpawnSpy(impl: () => ChildProcess) {
  vi.mocked(child_process.spawn).mockImplementation(impl);
}

function defaultSpawn(): ChildProcess {
  const fake = createFakeChild(10000 + spawned.length);
  spawned.push(fake);
  return fake as unknown as ChildProcess;
}

describe("ensureOpenCodeServerRunning — per-config child state (M2a)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    spawned = [];
    // reset module-level spawn registry by re-pointing the mock to default impl
    setSpawnSpy(defaultSpawn);
    // reset module state by re-importing is not possible; we rely on stopOpenCodeServer()
    // being called in tests to clear state. Pre-empt full teardown before each test.
    stopOpenCodeServer();
  });

  it("keeps two different configs as two different children", async () => {
    let a = 0, b = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":4096")) { a++; return { ok: a > 1 } as Response; }
      if (url.includes(":4097")) { b++; return { ok: b > 1 } as Response; }
      return { ok: false } as Response;
    });
    const configA = { hostname: "127.0.0.1", port: 4096, command: "opencode" };
    const configB = { hostname: "127.0.0.1", port: 4097, command: "opencode" };

    await ensureOpenCodeServerRunning(configA);
    await ensureOpenCodeServerRunning(configB);

    expect(spawned).toHaveLength(2);
    expect(getChildPid(configA)).toBe(10000);
    expect(getChildPid(configB)).toBe(10001);
    expect(getChildPid(configA)).not.toBe(getChildPid(configB));
  });

  it("reuses the same child for the same config across calls", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":4096")) { n++; return { ok: n > 1 } as Response; }
      return { ok: false } as Response;
    });
    const config = { hostname: "127.0.0.1", port: 4096, command: "opencode" };

    await ensureOpenCodeServerRunning(config);
    await ensureOpenCodeServerRunning(config);

    expect(spawned).toHaveLength(1);
  });

  it("stopOpenCodeServer(config) only kills the matching child", async () => {
    let a = 0, b = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":4096")) { a++; return { ok: a > 1 } as Response; }
      if (url.includes(":4097")) { b++; return { ok: b > 1 } as Response; }
      return { ok: false } as Response;
    });
    const configA = { hostname: "127.0.0.1", port: 4096, command: "opencode" };
    const configB = { hostname: "127.0.0.1", port: 4097, command: "opencode" };
    await ensureOpenCodeServerRunning(configA);
    await ensureOpenCodeServerRunning(configB);

    stopOpenCodeServer(configA);

    expect(getChildPid(configA)).toBeNull();
    expect(getChildPid(configB)).not.toBeNull();
  });
});

describe("ensureOpenCodeServerRunning — spawn vs connect mode (M2b)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    spawned = [];
    setSpawnSpy(defaultSpawn);
    stopOpenCodeServer();
  });

  it("connect-mode never calls spawn when healthy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true } as Response);
    const config = { hostname: "10.0.0.5", port: 4096, command: "opencode", mode: "connect" as const };

    const result = await ensureOpenCodeServerRunning(config);

    expect(result).toBe(true);
    expect(child_process.spawn).not.toHaveBeenCalled();
  });

  it("connect-mode never calls spawn when unhealthy — throws and message interpolates URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false } as Response);
    const config = { hostname: "10.0.0.5", port: 4096, command: "opencode", mode: "connect" as const };

    let threw: Error | null = null;
    try { await ensureOpenCodeServerRunning(config); } catch (e) { threw = e as Error; }
    expect(threw).not.toBeNull();
    expect(child_process.spawn).not.toHaveBeenCalled();
    expect(threw?.message).toContain("http://10.0.0.5:4096");
    expect(threw?.message).toMatch(/cannot restart remotely/i);
    expect(typeof REMOTE_UNREACHABLE_ERROR).toBe("function");
  }, 2000);

  it("auto-promotes to connect mode when hostname is non-loopback and mode unset", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false } as Response);
    const config = { hostname: "10.0.0.5", port: 4096, command: "opencode" };

    let threw = false;
    try { await ensureOpenCodeServerRunning(config); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(child_process.spawn).not.toHaveBeenCalled();
  }, 2000);

  it("explicit 'spawn' overrides non-loopback hostname", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":4096")) { n++; return { ok: n > 1 } as Response; }
      return { ok: false } as Response;
    });
    const config = { hostname: "10.0.0.5", port: 4096, command: "opencode", mode: "spawn" as const };

    await ensureOpenCodeServerRunning(config);

    expect(child_process.spawn).toHaveBeenCalledTimes(1);
  });

  it("localhost hostname with mode unset stays in spawn mode", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":4096")) { n++; return { ok: n > 1 } as Response; }
      return { ok: false } as Response;
    });
    const config = { hostname: "127.0.0.1", port: 4096, command: "opencode" };

    await ensureOpenCodeServerRunning(config);

    expect(child_process.spawn).toHaveBeenCalledTimes(1);
  });
});

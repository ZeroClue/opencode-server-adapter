import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/ssh", () => ({
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: true })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => {}),
  runSshCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  shellQuote: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
}));

// `readSanitizedOriginUrl` promisifies `execFile` from node:child_process at
// module load, so mocking the module means spyOn won't intercept the
// promisified wrapper. Grab the mocked raw fn and stub its resolved value via
// the wrapper is impractical; instead the tests drive the mocked execFile
// with an async callback that returns what promisify would surface.
const childProcess = await import("node:child_process");
const ssh = await import("@paperclipai/adapter-utils/ssh");
const {
  readRemoteSyncConfig,
  sshEnabled,
  buildSshSpec,
  buildRemoteSync,
  readSanitizedOriginUrl,
} = await import("../remote-sync.js");

beforeEach(() => {
  vi.clearAllMocks();
  // Default: promisified execFile resolves with an empty origin (no error).
  mockExecFileResolve("");
});

/** Make the promisified execFile resolve/call as expected by remote-sync.ts. */
function mockExecFileResolve(value: string) {
  (childProcess.execFile as any).mockImplementation(function (this: unknown, ...args: unknown[]) {
    const cb = args[args.length - 1] as (err: Error | null, res?: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: value, stderr: "" });
  });
}
function mockExecFileReject(err: Error) {
  (childProcess.execFile as any).mockImplementation(function (this: unknown, ...args: unknown[]) {
    const cb = args[args.length - 1] as (err: Error | null, res?: { stdout: string; stderr: string }) => void;
    cb(err, { stdout: "", stderr: "" });
  });
}

describe("readRemoteSyncConfig", () => {
  it("defaults all fields when absent", () => {
    const cfg = readRemoteSyncConfig({});
    expect(cfg.sshHost).toBe("");
    expect(cfg.sshPort).toBe(2222);
    expect(cfg.sshUsername).toBe("");
    expect(cfg.sshPrivateKey).toBe("");
    expect(cfg.sshKnownHosts).toBe("");
    expect(cfg.strictHostKeyChecking).toBe(true);
    expect(cfg.remoteServerCwd).toBe("");
  });

  it("reads configured values", () => {
    const cfg = readRemoteSyncConfig({
      sshHost: "agent-a.tailnet",
      sshPort: 2223,
      sshUsername: "opencode",
      sshPrivateKey: "abc",
      sshKnownHosts: "host key",
      strictHostKeyChecking: false,
      remoteServerCwd: "/work",
    });
    expect(cfg.sshHost).toBe("agent-a.tailnet");
    expect(cfg.sshPort).toBe(2223);
    expect(cfg.sshUsername).toBe("opencode");
    expect(cfg.sshPrivateKey).toBe("abc");
    expect(cfg.strictHostKeyChecking).toBe(false);
    expect(cfg.remoteServerCwd).toBe("/work");
  });
});

describe("sshEnabled", () => {
  it("returns false when any required field is missing", () => {
    expect(sshEnabled(readRemoteSyncConfig({}))).toBe(false);
    expect(sshEnabled(readRemoteSyncConfig({ sshHost: "h", sshUsername: "u", remoteServerCwd: "/work" }))).toBe(false);
  });

  it("returns true when all required fields are present", () => {
    const cfg = readRemoteSyncConfig({
      sshHost: "h", sshUsername: "u", sshPrivateKey: "k", remoteServerCwd: "/work",
    });
    expect(sshEnabled(cfg)).toBe(true);
  });
});

describe("buildSshSpec", () => {
  it("maps config onto the SshRemoteExecutionSpec", () => {
    const cfg = readRemoteSyncConfig({
      sshHost: "agent-a.tailnet", sshPort: 2222, sshUsername: "opencode",
      sshPrivateKey: "key", sshKnownHosts: "kh", remoteServerCwd: "/work",
    });
    const spec = buildSshSpec(cfg);
    expect(spec.host).toBe("agent-a.tailnet");
    expect(spec.port).toBe(2222);
    expect(spec.username).toBe("opencode");
    expect(spec.privateKey).toBe("key");
    expect(spec.knownHosts).toBe("kh");
    expect(spec.remoteWorkspacePath).toBe("/work");
    expect(spec.remoteCwd).toBe("/work");
  });
});

describe("buildRemoteSync", () => {
  it("returns a no-op handle when ssh is disabled", async () => {
    const sync = await buildRemoteSync(readRemoteSyncConfig({}), "/local");
    expect(sync.enabled).toBe(false);
    expect(sync.prepare).toBeDefined();
    await sync.prepare();
    await sync.restore();
    expect(ssh.prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(ssh.restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
  });

  it("prepares and restores into the stable remote cwd", async () => {
    const cfg = readRemoteSyncConfig({
      sshHost: "agent-a.tailnet", sshUsername: "opencode", sshPrivateKey: "key", remoteServerCwd: "/work",
    });
    const sync = await buildRemoteSync(cfg, "/local/repo");
    expect(sync.enabled).toBe(true);
    expect(sync.remoteDir).toBe("/work");

    await sync.prepare();
    expect(ssh.prepareWorkspaceForSshExecution).toHaveBeenCalledWith({
      spec: expect.objectContaining({ host: "agent-a.tailnet", remoteCwd: "/work", remoteWorkspacePath: "/work" }),
      localDir: "/local/repo",
      remoteDir: "/work",
    });

    await sync.restore();
    expect(ssh.restoreWorkspaceFromSshExecution).toHaveBeenCalledWith({
      spec: expect.objectContaining({ remoteCwd: "/work" }),
      localDir: "/local/repo",
      remoteDir: "/work",
    });
  });

  it("mirrors the origin remote and gitignores .paperclip-runtime after prepare", async () => {
    const cfg = readRemoteSyncConfig({
      sshHost: "agent-a.tailnet", sshUsername: "opencode", sshPrivateKey: "key", remoteServerCwd: "/work",
    });
    const sync = await buildRemoteSync(cfg, "/local/repo");

    mockExecFileResolve("https://ZeroClue:gho_super-secret-token@github.com/ZeroClue/MFTxyz.git\n");

    await sync.prepare();

    expect(childProcess.execFile).toHaveBeenCalledWith(
      "git",
      ["-C", "/local/repo", "config", "--get", "remote.origin.url"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(ssh.runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("remote add origin"),
      expect.anything(),
    );
    expect(ssh.runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("https://github.com/ZeroClue/MFTxyz.git"),
      expect.anything(),
    );
    expect(ssh.runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("grep -qxF '.paperclip-runtime/'"),
      expect.anything(),
    );
  });

  it("installs a GIT_ASKPASS helper reading $GH_TOKEN after prepare", async () => {
    const cfg = readRemoteSyncConfig({
      sshHost: "agent-a.tailnet", sshUsername: "opencode", sshPrivateKey: "key", remoteServerCwd: "/work",
    });
    const sync = await buildRemoteSync(cfg, "/local/repo");

    mockExecFileResolve("https://github.com/ZeroClue/MFTxyz.git\n");

    await sync.prepare();

    expect(ssh.runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("~/.git-askpass"),
      expect.anything(),
    );
    expect(ssh.runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("$GH_TOKEN"),
      expect.anything(),
    );
    expect(ssh.runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("core.askPass ~/.git-askpass"),
      expect.anything(),
    );
    expect(ssh.runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("https://github.com.username x-access-token"),
      expect.anything(),
    );
  });

  it("does not call runSshCommand when prepareWorkspaceForSshExecution fails", async () => {
    (ssh.prepareWorkspaceForSshExecution as any).mockRejectedValueOnce(new Error("ssh down"));
    const cfg = readRemoteSyncConfig({
      sshHost: "agent-a.tailnet", sshUsername: "opencode", sshPrivateKey: "key", remoteServerCwd: "/work",
    });
    const sync = await buildRemoteSync(cfg, "/local/repo");
    await expect(sync.prepare()).rejects.toThrow("ssh down");
    expect(ssh.runSshCommand).not.toHaveBeenCalled();
  });
});

describe("readSanitizedOriginUrl", () => {
  it("strips embedded credentials from the origin URL", async () => {
    mockExecFileResolve("https://ZeroClue:gho_super-secret-token@github.com/ZeroClue/MFTxyz.git\n");
    const url = await readSanitizedOriginUrl("/local/repo");
    expect(url).toBe("https://github.com/ZeroClue/MFTxyz.git");
    expect(url).not.toContain("gho_super-secret-token");
    expect(childProcess.execFile).toHaveBeenCalledWith(
      "git",
      ["-C", "/local/repo", "config", "--get", "remote.origin.url"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("returns an empty string when no origin exists", async () => {
    mockExecFileReject(new Error("no origin"));
    const url = await readSanitizedOriginUrl("/local/repo");
    expect(url).toBe("");
  });
});
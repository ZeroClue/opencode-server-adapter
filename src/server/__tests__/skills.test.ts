import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";
import type { SshRemoteExecutionSpec } from "@paperclipai/adapter-utils/ssh";

const skillEntry = {
  key: "test-skill",
  runtimeName: "test-skill",
  source: "/skills/test-skill",
  sourceStatus: "ok" as const,
  required: true,
};

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries: vi.fn(async () => [skillEntry]),
    resolvePaperclipDesiredSkillNames: vi.fn(() => ["test-skill"]),
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", () => ({
  runSshCommand: vi.fn(async () => ({ stdout: "/home/opencode\n", stderr: "" })),
  syncDirectoryToSsh: vi.fn(async () => {}),
}));

const serverUtils = await import("@paperclipai/adapter-utils/server-utils");
const ssh = await import("@paperclipai/adapter-utils/ssh");
const {
  REMOTE_SKILLS_RELATIVE_PATHS,
  pushSkillsToRemote,
  listOpenCodeServerSkills,
  syncOpenCodeServerSkills,
} = await import("../skills.js");

const SPEC: SshRemoteExecutionSpec = {
  host: "agent-a.tailnet",
  port: 2222,
  username: "opencode",
  privateKey: "key",
  knownHosts: "",
  strictHostKeyChecking: true,
  remoteWorkspacePath: "/work",
  remoteCwd: "/work",
};

const CTX: AdapterSkillContext = {
  agentId: "agent-1",
  companyId: "co-1",
  adapterType: "opencode_server",
  config: {},
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("REMOTE_SKILLS_RELATIVE_PATHS", () => {
  it("covers the opencode discovery paths", () => {
    expect(REMOTE_SKILLS_RELATIVE_PATHS).toEqual([
      ".claude/skills",
      ".config/opencode/skills",
    ]);
  });
});

describe("pushSkillsToRemote", () => {
  it("syncs a desired skill to every relative discovery path", async () => {
    const logs: string[] = [];
    await pushSkillsToRemote({}, SPEC, async (stream, chunk) => { logs.push(`${stream}:${chunk}`); });

    expect(ssh.runSshCommand).toHaveBeenCalled();
    expect(ssh.syncDirectoryToSsh).toHaveBeenCalledTimes(2);
    expect(ssh.syncDirectoryToSsh).toHaveBeenCalledWith(
      expect.objectContaining({ localDir: "/skills/test-skill", remoteDir: "/home/opencode/.claude/skills/test-skill" }),
    );
    expect(ssh.syncDirectoryToSsh).toHaveBeenCalledWith(
      expect.objectContaining({ remoteDir: "/home/opencode/.config/opencode/skills/test-skill" }),
    );
    expect(logs.some((l) => l.includes("test-skill"))).toBe(true);
  });

  it("uses $HOME when available", async () => {
    vi.mocked(ssh.runSshCommand).mockResolvedValueOnce({ stdout: "/home/usr\n", stderr: "" });
    await pushSkillsToRemote({}, SPEC);
    expect(ssh.syncDirectoryToSsh).toHaveBeenCalledWith(
      expect.objectContaining({ remoteDir: "/home/usr/.claude/skills/test-skill" }),
    );
  });

  it("skips skills not in the desired set", async () => {
    vi.mocked(serverUtils.resolvePaperclipDesiredSkillNames).mockReturnValueOnce([]);
    await pushSkillsToRemote({}, SPEC);
    expect(ssh.syncDirectoryToSsh).not.toHaveBeenCalled();
  });
});

describe("listOpenCodeServerSkills", () => {
  it("builds a persistent snapshot with remote location when ssh is disabled", async () => {
    const snapshot = await listOpenCodeServerSkills(CTX);
    expect(snapshot.adapterType).toBe("opencode_server");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.desiredSkills).toEqual(["test-skill"]);
    expect(snapshot.mode).toBe("persistent");
  });
});

describe("syncOpenCodeServerSkills", () => {
  it("persists the preference and does not push when ssh is disabled", async () => {
    const snapshot = await syncOpenCodeServerSkills(CTX, ["production-deploy"]);
    expect(serverUtils.writePaperclipSkillSyncPreference).toBeDefined();
    expect(snapshot.desiredSkills).toBeDefined();
    expect(ssh.syncDirectoryToSsh).not.toHaveBeenCalled();
  });
});
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  buildPersistentSkillSnapshot,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import type { SshRemoteExecutionSpec } from "@paperclipai/adapter-utils/ssh";
import { runSshCommand, syncDirectoryToSsh } from "@paperclipai/adapter-utils/ssh";
import { readRemoteSyncConfig, sshEnabled, buildSshSpec } from "./remote-sync.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * OpenCode discovers skills from these paths on the remote host (see
 * https://opencode.ai/docs/skills). We push the Claude-compatible path (also
 * used by the opencode-local adapter) so a warm server picks the skill up
 * on-demand from disk.
 */
export const REMOTE_SKILLS_RELATIVE_PATHS = [
  ".claude/skills",
  ".config/opencode/skills",
] as const;

function remoteSyncSpecIfEnabled(config: Record<string, unknown>): SshRemoteExecutionSpec | null {
  const rc = readRemoteSyncConfig(config);
  return sshEnabled(rc) ? buildSshSpec(rc) : null;
}

async function resolveRemoteHome(spec: SshRemoteExecutionSpec): Promise<string> {
  try {
    const res = await runSshCommand(spec, "printf %s \"$HOME\"", { timeoutMs: 5000 });
    const home = (res.stdout || "").trim();
    return home || "/root";
  } catch {
    return "/root";
  }
}

async function buildSnapshotForConfig(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const remoteEnabled = sshEnabled(readRemoteSyncConfig(config));
  return buildPersistentSkillSnapshot({
    adapterType: "opencode_server",
    availableEntries,
    desiredSkills,
    installed: new Map(),
    skillsHome: remoteEnabled ? "remote:~/.claude/skills" : "n/a",
    locationLabel: remoteEnabled ? "remote ~/.claude/skills on each serve VPS" : "n/a",
    missingDetail: "Configured but not currently synced to the remote serve host.",
    externalConflictDetail: "Remote skills are managed through sync.",
    externalDetail: "Remote skills are managed through sync.",
    warnings: [
      remoteEnabled
        ? "OpenCode skills are synced on-demand to each serve VPS during prepare."
        : "Workspace sync is disabled; skills are not pushed to a remote host.",
    ],
  });
}

/**
 * Push the desired skills onto the remote host's discovery paths so a warm
 * `opencode serve` picks them up. Each paperclip skill's `source` is a
 * directory on the Paperclip host.
 */
export async function pushSkillsToRemote(
  config: Record<string, unknown>,
  spec: SshRemoteExecutionSpec,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = new Set(resolvePaperclipDesiredSkillNames(config, availableEntries));
  const home = await resolveRemoteHome(spec);

  for (const entry of availableEntries) {
    if (!desiredSkills.has(entry.key)) continue;
    if (entry.sourceStatus === "missing") continue;
    for (const rel of REMOTE_SKILLS_RELATIVE_PATHS) {
      const remoteDir = `${home}/${rel}/${entry.runtimeName}`;
      await onLog?.("stdout", `[paperclip] Syncing skill "${entry.runtimeName}" to remote ${remoteDir}.\n`);
      try {
        await syncDirectoryToSsh({ spec, localDir: entry.source, remoteDir, exclude: [".git"] });
      } catch (err) {
        await onLog?.("stderr", `[paperclip] Skill sync failed for "${entry.runtimeName}": ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
}

/** listSkills entrypoint — snapshot of desired/available skills. */
export function listOpenCodeServerSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildSnapshotForConfig(ctx.config);
}

/** syncSkills entrypoint — persist preference and push to remote when enabled. */
export async function syncOpenCodeServerSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const config = writePaperclipSkillSyncPreference(ctx.config, desiredSkills);
  const spec = remoteSyncSpecIfEnabled(config);
  if (spec) await pushSkillsToRemote(config, spec);
  return buildSnapshotForConfig(config);
}
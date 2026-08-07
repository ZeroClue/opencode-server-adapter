import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SshRemoteExecutionSpec } from "@paperclipai/adapter-utils/ssh";
import {
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  shellQuote,
} from "@paperclipai/adapter-utils/ssh";
import { asString, asNumber, asBoolean } from "@paperclipai/adapter-utils/server-utils";

const execFileAsync = promisify(execFile);

/**
 * SSH + workspace-sync configuration for a warm remote `opencode serve`.
 *
 * All fields are optional at the config-schema level so a pure "connect"
 * mode (local dev, or a server whose workspace is self-managed on the VPS)
 * works without any SSH setup. When `sshEnabled` returns false, the adapter
 * performs no workspace sync and only talks REST, exactly like the original
 * connector.
 */
export interface RemoteSyncConfig {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPrivateKey: string | null;
  sshKnownHosts: string | null;
  strictHostKeyChecking: boolean;
  /**
   * Stable remote working directory the `opencode serve` process works in
   * on the VPS. Reused across heartbeats so the session identity stays
   * stable and opencode can resume the session (avoiding a cold re-read).
   */
  remoteServerCwd: string;
}

export function readRemoteSyncConfig(config: Record<string, unknown>): RemoteSyncConfig {
  return {
    sshHost: asString(config.sshHost, ""),
    sshPort: asNumber(config.sshPort, 2222),
    sshUsername: asString(config.sshUsername, ""),
    sshPrivateKey: asString(config.sshPrivateKey, ""),
    sshKnownHosts: asString(config.sshKnownHosts, ""),
    strictHostKeyChecking: asBoolean(config.strictHostKeyChecking, true),
    remoteServerCwd: asString(config.remoteServerCwd, ""),
  };
}

export function sshEnabled(config: RemoteSyncConfig): boolean {
  return (
    config.sshHost.trim().length > 0 &&
    config.sshUsername.trim().length > 0 &&
    config.remoteServerCwd.trim().length > 0 &&
    config.sshPrivateKey != null &&
    config.sshPrivateKey.length > 0
  );
}

/**
 * Build the `SshRemoteExecutionSpec` used by the adapter-utils sync
 * primitives. The stable remote cwd is used both as the sync target and as
 * the session identity anchor.
 */
export function buildSshSpec(config: RemoteSyncConfig): SshRemoteExecutionSpec {
  return {
    host: config.sshHost,
    port: config.sshPort,
    username: config.sshUsername,
    remoteWorkspacePath: config.remoteServerCwd,
    privateKey: config.sshPrivateKey,
    knownHosts: config.sshKnownHosts,
    strictHostKeyChecking: config.strictHostKeyChecking,
    remoteCwd: config.remoteServerCwd,
  };
}

/**
 * Read the local workspace repo's `origin` remote URL, stripping any embedded
 * credentials. The synced remote copy is a git-bundle import with no remotes
 * configured, so the agent's "git fetch origin && git rebase origin/main"
 * instructions fail on a repo that has no `origin`. Mirroring the origin URL
 * (without shipping the host's token into the container) lets those
 * instructions succeed.
 */
export async function readSanitizedOriginUrl(localDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", localDir, "config", "--get", "remote.origin.url"], {
      timeout: 10_000,
      maxBuffer: 16 * 1024,
    });
    const raw = (stdout || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      // Not an http(s) URL (e.g. git@host:path). Leave as-is.
      return raw;
    }
  } catch {
    return "";
  }
}

export interface RemoteSync {
  enabled: boolean;
  spec: SshRemoteExecutionSpec | null;
  remoteDir: string;
  /** Push the local workspace up to the stable remote cwd (git-bundle sync). */
  prepare(): Promise<void>;
  /** Pull remote changes back into the local workspace. */
  restore(): Promise<void>;
}

/**
 * Build the workspace-sync handle for a persistent remote server.
 *
 * IMPORTANT: unlike `prepareRemoteManagedRuntime` / `prepareAdapterExecutionTargetRuntime`
 * (which stage into a throwaway `.paperclip-runtime/runs/<runId>` per run),
 * this syncs into a STABLE remote dir that the `opencode serve` process keeps
 * as its cwd. That stable identity is what lets opencode resume the session
 * across heartbeats instead of re-reading the whole repo every run.
 */
export async function buildRemoteSync(
  config: RemoteSyncConfig,
  localDir: string,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<RemoteSync> {
  const enabled = sshEnabled(config);
  if (!enabled) {
    return {
      enabled,
      spec: null,
      remoteDir: "",
      prepare: async () => {},
      restore: async () => {},
    };
  }
  const spec = buildSshSpec(config);
  const prepare = async () => {
    await onLog?.("stdout", `[paperclip] Syncing workspace to ${spec.host}:${spec.port} at ${spec.remoteCwd}.\n`);
    await prepareWorkspaceForSshExecution({ spec, localDir, remoteDir: spec.remoteCwd });
    await configureRemoteGit(spec, localDir, spec.remoteCwd, onLog);
  };
  const restore = async () => {
    await onLog?.("stdout", `[paperclip] Restoring workspace changes from ${spec.host}:${spec.port}.\n`);
    await restoreWorkspaceFromSshExecution({ spec, localDir, remoteDir: spec.remoteCwd });
  };
  return { enabled, spec, remoteDir: spec.remoteCwd, prepare, restore };
}

/**
 * Post-import git housekeeping on the synced workspace:
 *
 * 1. Mirror the local repo's `origin` remote (credential-stripped) so the
 *    agent's "git fetch origin && git rebase origin/main" instructions work.
 * 2. Add `.paperclip-runtime/` to `.git/info/exclude` so the sync staging
 *    dir stops showing up as untracked in every `git status` the agent runs.
 *
 * Failures here are non-fatal: the workspace sync already succeeded, and
 * missing git provenance is a token-burn annoyance, not a hard blocker.
 */
async function configureRemoteGit(
  spec: SshRemoteExecutionSpec,
  localDir: string,
  remoteDir: string,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  try {
    const originUrl = await readSanitizedOriginUrl(localDir);
    const gitDir = `${remoteDir}/.git`;
    const excludePath = `${gitDir}/info/exclude`;
const script = [
    originUrl
      ? `if [ -d ${shellQuote(gitDir)} ]; then git -C ${shellQuote(remoteDir)} remote remove origin >/dev/null 2>&1 || true; git -C ${shellQuote(remoteDir)} remote add origin ${shellQuote(originUrl)}; fi`
      : "true",
    `if [ -d ${shellQuote(gitDir)} ]; then mkdir -p ${shellQuote(`${gitDir}/info`)}; grep -qxF '.paperclip-runtime/' ${shellQuote(excludePath)} 2>/dev/null || printf '%s\n' '.paperclip-runtime/' >> ${shellQuote(excludePath)}; fi`,
    installGitAskpass(),
  ].join(" && ");
  await runSshCommand(spec, script, { timeoutMs: 15000 });
    await onLog?.(
      "stdout",
      originUrl
        ? `[paperclip] Configured origin remote + .paperclip-runtime gitignore at ${remoteDir}.\n`
        : `[paperclip] Configured .paperclip-runtime gitignore at ${remoteDir} (no origin to mirror).\n`,
    );
  } catch (err) {
    await onLog?.(
      "stderr",
      `[paperclip] Remote git configuration skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/**
 * Install a GIT_ASKPASS helper on the remote that answers git credential
 * prompts by emitting the injected `GH_TOKEN` env var. Together with the
 * GH_TOKEN forwarded via the shell.env plugin, this lets the agent's
 * "git fetch origin && git rebase origin/main" instructions authenticate
 * against github.com over HTTPS without manual token entry or a `gh` CLI
 * (which is not installed in the container).
 *
 * The askpass script is installed idempotently; re-running just overwrites
 * it and re-sets git config. Failures here are non-fatal (the enclosing
 * caller already treats the whole step as best-effort).
 */
function installGitAskpass(): string {
  // Write an askpass helper that answers git's password prompt with the
  // injected GH_TOKEN, and set the github.com username so git only prompts
  // for the password (answered automatically). `x-access-token` is the
  // conventional username GitHub App installation tokens / fine-grained PATs
  // accept alongside the token as the password.
  return [
    `printf '%s\\n' '#!/bin/sh' 'printf %s "$GH_TOKEN"' > ~/.git-askpass`,
    `chmod +x ~/.git-askpass`,
    `git config --global core.askPass ~/.git-askpass`,
    `git config --global credential.https://github.com.username x-access-token`,
    `git config --global credential.https://www.github.com.username x-access-token`,
    `git config --global credential.helper ''`,
  ].join(" && ");
}
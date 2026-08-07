import path from "node:path";
import fs from "node:fs";
import type { SshRemoteExecutionSpec } from "@paperclipai/adapter-utils/ssh";
import { runSshCommand, syncDirectoryToSsh } from "@paperclipai/adapter-utils/ssh";
import { asString, asBoolean } from "@paperclipai/adapter-utils/server-utils";
import { readRemoteSyncConfig } from "./remote-sync.js";

/**
 * Remote agent-home mirror.
 *
 * The opencode-local adapter gives its agent a real home directory
 * (AGENT_HOME) populated with instructions (AGENTS.md, TOOLS.md) and rule
 * bundles (rules/*.md). The opencode_server adapter runs inside a bare
 * container whose serve process has no such home, so anything the agent is
 * told to read from `$AGENT_HOME/rules/...` resolves to nothing and the
 * agent burns tokens hunting for files it can never find.
 *
 * This module mirrors the Paperclip-side agent home into the container
 * (default `/home/opc/agent-home`) and installs a `shell.env` plugin so the
 * serve process injects AGENT_HOME plus run-scoped PAPERCLIP_* env vars into
 * every bash tool execution.
 */

/** Remote path the instructions bundle is mirrored into. */
export const DEFAULT_REMOTE_AGENT_HOME = "/home/opc/agent-home";

/** Relative filename of the shell.env plugin installed on the remote. */
export const REMOTE_PLUGIN_FILENAME = "paperclip-env.js";

/** Filename of the per-run env values file read by the plugin. */
export const REMOTE_ENV_FILENAME = ".paperclip-env.json";

export interface AgentHomeConfig {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPrivateKey: string | null;
  sshKnownHosts: string | null;
  strictHostKeyChecking: boolean;
  /** Local agent-home directory (AGENTS.md, TOOLS.md, rules/...) to mirror. */
  localAgentHomeDir: string;
  /** Remote directory AGENT_HOME points at inside the container. */
  remoteAgentHomeDir: string;
  /** Deploy/refresh the shell.env plugin on every run. */
  deployPlugin: boolean;
  /** Board API URL injected as PAPERCLIP_API_URL. */
  paperclipApiUrl: string;
}

export function readAgentHomeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): AgentHomeConfig {
  const rc = readRemoteSyncConfig(config);
  const localAgentHomeDir = asString(config.agentHomeDir, "").trim();
  const remoteAgentHomeDir = asString(config.agentHomeRemoteDir, "").trim() || DEFAULT_REMOTE_AGENT_HOME;
  const deployPlugin = asBoolean(config.deployAgentHomePlugin, true);
  const paperclipApiUrl =
    asString(config.paperclipApiUrl, "").trim() ||
    env.PAPERCLIP_RUNTIME_API_URL ||
    env.PAPERCLIP_API_URL ||
    `http://${resolveHostForUrl(env.PAPERCLIP_LISTEN_HOST ?? env.HOST ?? "localhost")}:${env.PAPERCLIP_LISTEN_PORT ?? env.PORT ?? "3100"}`;
  return {
    sshHost: rc.sshHost,
    sshPort: rc.sshPort,
    sshUsername: rc.sshUsername,
    sshPrivateKey: rc.sshPrivateKey,
    sshKnownHosts: rc.sshKnownHosts,
    strictHostKeyChecking: rc.strictHostKeyChecking,
    localAgentHomeDir,
    remoteAgentHomeDir,
    deployPlugin,
    paperclipApiUrl,
  };
}

function resolveHostForUrl(rawHost: string): string {
  const host = rawHost.trim();
  if (!host || host === "0.0.0.0" || host === "::") return "localhost";
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
  return host;
}

export function agentHomeEnabled(config: AgentHomeConfig): boolean {
  return (
    config.sshHost.trim().length > 0 &&
    config.sshUsername.trim().length > 0 &&
    config.localAgentHomeDir.length > 0 &&
    config.sshPrivateKey != null &&
    config.sshPrivateKey.length > 0
  );
}

function buildSpec(config: AgentHomeConfig): SshRemoteExecutionSpec {
  return {
    host: config.sshHost,
    port: config.sshPort,
    username: config.sshUsername,
    remoteWorkspacePath: config.remoteAgentHomeDir,
    privateKey: config.sshPrivateKey,
    knownHosts: config.sshKnownHosts,
    strictHostKeyChecking: config.strictHostKeyChecking,
    remoteCwd: config.remoteAgentHomeDir,
  };
}

/**
 * Mirror the local agent home (AGENTS.md, TOOLS.md, rules/, ...) into the
 * container so `$AGENT_HOME/rules/...` resolves. Syncs the directory as a
 * tree so additions/removals stay in sync across runs.
 */
export async function syncAgentHomeToRemote(
  config: AgentHomeConfig,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  await onLog?.("stdout", `[paperclip] Syncing agent home to ${config.sshHost}:${config.sshPort} at ${config.remoteAgentHomeDir}.\n`);
  try {
    await syncDirectoryToSsh({
      spec: buildSpec(config),
      localDir: config.localAgentHomeDir,
      remoteDir: config.remoteAgentHomeDir,
      exclude: [".git"],
    });
  } catch (err) {
    await onLog?.(
      "stderr",
      `[paperclip] Agent home sync failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    throw err;
  }
}

/**
 * Install (or refresh) the `shell.env` plugin on the remote host. OpenCode
 * auto-discovers plugins from `~/.config/opencode/plugins/` (see the docs'
 * load-order), so writing the file there is enough — no opencode.json edit
 * is required. The plugin reads the per-run env values from the agent-home
 * env file on every bash tool execution.
 */
export async function deployAgentHomePlugin(
  config: AgentHomeConfig,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  const spec = buildSpec(config);
  const home = await remoteHomeDir(spec, onLog);
  const pluginDir = `${home}/.config/opencode/plugins`;
  const pluginPath = `${pluginDir}/${REMOTE_PLUGIN_FILENAME}`;
  const pluginSource = buildPluginSource(config.remoteAgentHomeDir);
  await onLog?.("stdout", `[paperclip] Deploying shell.env plugin to ${pluginPath}.\n`);
  const mkdir = `mkdir -p ${quote(pluginDir)}`;
  const write = `cat > ${quote(pluginPath)} <<'PAPERCLIP_PLUGIN_EOF'\n${pluginSource}\nPAPERCLIP_PLUGIN_EOF`;
  const script = `${mkdir} && ${write}`;
  try {
    await runSshCommand(spec, script, { timeoutMs: 15000 });
  } catch (err) {
    await onLog?.(
      "stderr",
      `[paperclip] Plugin deployment failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    throw err;
  }
}

async function remoteHomeDir(
  spec: SshRemoteExecutionSpec,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<string> {
  try {
    const res = await runSshCommand(spec, "printf %s \"$HOME\"", { timeoutMs: 5000 });
    return (res.stdout || "").trim() || "/root";
  } catch {
    return "/root";
  }
}

function buildPluginSource(remoteAgentHomeDir: string): string {
  return [
    `// paperclip-env.js — inject AGENT_HOME + run-scoped PAPERCLIP_* env into`,
    `// every bash tool execution. Values are read fresh from`,
    `// ${remoteAgentHomeDir}/${REMOTE_ENV_FILENAME} on each call so per-run`,
    `// credentials (PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID) are always current.`,
    `import fs from "node:fs";`,
    `const ENV_FILE = ${JSON.stringify(`${remoteAgentHomeDir}/${REMOTE_ENV_FILENAME}`)};`,
    `export const InjectEnvPlugin = async () => {`,
    `  return {`,
    `    "shell.env": async (input, output) => {`,
    `      try {`,
    `        const raw = fs.readFileSync(ENV_FILE, "utf8");`,
    `        const values = JSON.parse(raw);`,
    `        for (const [key, value] of Object.entries(values)) {`,
    `          if (typeof value === "string") output.env[key] = value;`,
    `        }`,
    `      } catch {`,
    `        // no env file yet — run without injected Paperclip env`,
    `      }`,
    `    },`,
    `  };`,
    `};`,
    `export default InjectEnvPlugin;`,
  ].join("\n");
}

/**
 * Write the per-run env values file the plugin reads. Contains run-scoped
 * credentials, so it is written just before the message is sent.
 */
export async function writeRemoteEnvFile(
  config: AgentHomeConfig,
  env: Record<string, string>,
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  const envPath = `${config.remoteAgentHomeDir}/${REMOTE_ENV_FILENAME}`;
  const payload = JSON.stringify(env, null, 2);
  const spec = buildSpec(config);
  const mkdir = `mkdir -p ${quote(config.remoteAgentHomeDir)}`;
  const writeBase64 = `cat > ${quote(envPath)} <<'PAPERCLIP_ENV_EOF'\n${payload}\nPAPERCLIP_ENV_EOF`;
  try {
    await runSshCommand(spec, `${mkdir} && ${writeBase64}`, { timeoutMs: 10000 });
  } catch (err) {
    await onLog?.(
      "stderr",
      `[paperclip] Env file write failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    throw err;
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}


export function readLocalAgentHomeFromInstructions(
  config: Record<string, unknown>,
  instructionsFilePath: string,
): string {
  const configured = asString(config.agentHomeDir, "").trim();
  if (configured) return configured;
  if (instructionsFilePath) {
    // The instructions bundle lives in a dir containing AGENTS.md + rules/.
    // AGENTS.md references $AGENT_HOME/rules/..., so the agent home is the
    // instructions dir itself.
    const candidate = path.dirname(path.resolve(instructionsFilePath));
    if (fs.existsSync(path.join(candidate, "rules"))) return candidate;
  }
  return "";
}

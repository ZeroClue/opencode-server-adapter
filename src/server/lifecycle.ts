import { spawn, type ChildProcess } from "node:child_process";
import { basicAuthHeaders, serverUrl, type ServerConnection } from "./conn.js";

export interface ServerConfig extends ServerConnection {
  command: string;
  mode?: "spawn" | "connect";
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function resolveMode(config: ServerConfig): "spawn" | "connect" {
  if (config.mode === "connect" || config.mode === "spawn") return config.mode;
  return LOOPBACK_HOSTS.has(config.hostname.toLowerCase()) ? "spawn" : "connect";
}

export const REMOTE_UNREACHABLE_ERROR = (key: string): string =>
  `Remote opencode server unreachable at ${key} — cannot restart remotely; restart your container host or tailnet VM.`;

const children = new Map<string, ChildProcess>();
const pids = new Map<string, number>();

async function healthcheck(config: ServerConfig): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl(config)}/global/health`, {
      headers: basicAuthHeaders(config),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function getChildPid(config?: ServerConfig): number | null {
  if (config) return pids.get(serverUrl(config)) ?? null;
  // Backwards-compatible fallback: any tracked pid.
  const first = pids.values().next();
  return first.done ? null : first.value;
}

export async function ensureOpenCodeServerRunning(
  config: ServerConfig,
): Promise<boolean> {
  const key = serverUrl(config);
  if (await healthcheck(config)) {
    return true;
  }

  const existing = children.get(key);
  if (existing && !existing.killed) {
    existing.kill();
  }
  children.delete(key);
  pids.delete(key);

  if (resolveMode(config) === "connect") {
    throw new Error(REMOTE_UNREACHABLE_ERROR(key));
  }

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (config.password) {
    env.OPENCODE_SERVER_PASSWORD = config.password;
  }

  return new Promise((resolve, reject) => {
    try {
      const proc = spawn(config.command, [
        "serve", "--port", String(config.port),
        "--hostname", config.hostname,
      ], { env, stdio: "ignore", detached: false });

      children.set(key, proc);
      pids.set(key, proc.pid ?? -1);

      proc.on("exit", () => {
        if (pids.get(key) === proc.pid) {
          children.delete(key);
          pids.delete(key);
        }
      });

      const start = Date.now();
      const poll = async () => {
        if (await healthcheck(config)) {
          resolve(true);
          return;
        }
        if (Date.now() - start > 10_000) {
          reject(new Error(
            `Failed to start opencode serve on ${config.hostname}:${config.port}. ` +
            `Verify opencode is installed and provider auth is configured (opencode auth login).`,
          ));
          return;
        }
        setTimeout(poll, 1000);
      };
      poll();
    } catch (err) {
      reject(new Error(
        `Failed to spawn opencode serve: ${err instanceof Error ? err.message : String(err)}. ` +
        `Ensure opencode CLI is installed (curl -fsSL https://opencode.ai/install | bash).`,
      ));
    }
  });
}

export function stopOpenCodeServer(config?: ServerConfig): void {
  const killOne = (key: string) => {
    const proc = children.get(key);
    if (!proc || proc.killed) {
      children.delete(key);
      pids.delete(key);
      return;
    }
    proc.kill("SIGTERM");
    children.delete(key);
    pids.delete(key);
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  };

  if (config) {
    killOne(serverUrl(config));
  } else {
    for (const key of Array.from(children.keys())) killOne(key);
  }
}

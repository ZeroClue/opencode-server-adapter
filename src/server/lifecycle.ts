import { spawn, type ChildProcess } from "node:child_process";

interface ServerConfig {
  hostname: string;
  port: number;
  command: string;
  password?: string;
}

let childProcess: ChildProcess | null = null;
let currentPid: number | null = null;

function serverUrl(config: ServerConfig): string {
  return `http://${config.hostname}:${config.port}`;
}

async function healthcheck(config: ServerConfig): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl(config)}/global/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function getChildPid(): number | null {
  return currentPid;
}

export async function ensureOpenCodeServerRunning(
  config: ServerConfig,
): Promise<boolean> {
  if (await healthcheck(config)) {
    return true;
  }

  if (childProcess && !childProcess.killed) {
    childProcess.kill();
  }
  childProcess = null;
  currentPid = null;

  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (config.password) {
    env.OPENCODE_SERVER_PASSWORD = config.password;
  }

  return new Promise((resolve, reject) => {
    try {
      const proc = spawn(config.command, [
        "serve", "--port", String(config.port),
        "--hostname", config.hostname
      ], { env, stdio: "ignore", detached: false });

      childProcess = proc;
      currentPid = proc.pid ?? null;

      proc.on("exit", () => {
        if (currentPid === proc.pid) {
          childProcess = null;
          currentPid = null;
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
            `Verify opencode is installed and provider auth is configured (opencode auth login).`
          ));
          return;
        }
        setTimeout(poll, 1000);
      };
      poll();
    } catch (err) {
      reject(new Error(
        `Failed to spawn opencode serve: ${err instanceof Error ? err.message : String(err)}. ` +
        `Ensure opencode CLI is installed (curl -fsSL https://opencode.ai/install | bash).`
      ));
    }
  });
}

export function stopOpenCodeServer(): void {
  if (childProcess && !childProcess.killed) {
    childProcess.kill("SIGTERM");
    setTimeout(() => {
      if (childProcess && !childProcess.killed) {
        childProcess.kill("SIGKILL");
      }
    }, 5000);
  }
  childProcess = null;
  currentPid = null;
}
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, asNumber } from "@paperclipai/adapter-utils/server-utils";
import { ensureOpenCodeServerRunning } from "./lifecycle.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const hostname = asString(ctx.config.hostname, "127.0.0.1");
  const port = asNumber(ctx.config.port, 4096);
  const baseUrl = `http://${hostname}:${port}`;
  const model = asString(ctx.config.model, "");

  // 1. Server healthcheck
  try {
    await ensureOpenCodeServerRunning({ hostname, port, command: asString(ctx.config.command, "opencode") });
    const healthRes = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(3000) });
    if (healthRes.ok) {
      const healthData = await healthRes.json() as any;
      checks.push({
        code: "opencode_server_healthy",
        level: "info",
        message: `opencode serve is running (v${healthData.version || "unknown"})`,
      });
    } else {
      checks.push({
        code: "opencode_server_unhealthy",
        level: "error",
        message: `Server returned status ${healthRes.status}`,
      });
    }
  } catch (err) {
    checks.push({
      code: "opencode_server_unreachable",
      level: "error",
      message: `Cannot reach opencode serve at ${baseUrl}`,
      hint: "Ensure opencode CLI is installed and Paperclip can start it as a child process.",
    });
  }

  const serverOk = !checks.some((c) => c.code === "opencode_server_unreachable" || c.code === "opencode_server_unhealthy");
  if (serverOk) {
    try {
      const providerRes = await fetch(`${baseUrl}/provider`, { signal: AbortSignal.timeout(3000) });
      if (providerRes.ok) {
        const providerData = await providerRes.json() as any;
        const connected = Array.isArray(providerData.connected) ? providerData.connected.length : 0;
        if (connected > 0) {
          checks.push({
            code: "opencode_server_providers_connected",
            level: "info",
            message: `${connected} provider(s) connected`,
          });
        } else {
          checks.push({
            code: "opencode_server_no_providers",
            level: "warn",
            message: "Server is running but no providers are connected",
            hint: "Run 'opencode auth login' on the server machine to configure provider credentials.",
          });
        }
      }
    } catch {
      checks.push({
        code: "opencode_server_providers_unreachable",
        level: "warn",
        message: "Could not query provider list",
      });
    }
  }

  if (serverOk) {
    try {
      const sessionRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      });
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json() as any;
        const sessionId = sessionData.id;
        const messagePayload: Record<string, unknown> = {
          parts: [{ type: "text", text: "Respond with hello." }],
          agent: "build",
        };
        if (model && model.includes("/")) {
          const parts = model.split("/");
          messagePayload.model = { providerID: parts[0], modelID: parts.slice(1).join("/") };
        }
        const probeRes = await fetch(`${baseUrl}/session/${sessionId}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(messagePayload),
          signal: AbortSignal.timeout(60000),
        });
        if (probeRes.ok) {
          const probeData = await probeRes.json() as any;
          const hasHello = JSON.stringify(probeData).toLowerCase().includes("hello");
          checks.push({
            code: hasHello ? "opencode_server_probe_passed" : "opencode_server_probe_unexpected",
            level: hasHello ? "info" : "warn",
            message: hasHello ? "Hello probe succeeded." : "Probe returned unexpected output.",
          });
        } else {
          checks.push({
            code: "opencode_server_probe_failed",
            level: "error",
            message: `Probe returned status ${probeRes.status}`,
          });
        }
        fetch(`${baseUrl}/session/${sessionId}`, { method: "DELETE" }).catch(() => {});
      }
    } catch (err) {
      checks.push({
        code: "opencode_server_probe_error",
        level: "error",
        message: err instanceof Error ? err.message : "Hello probe failed",
      });
    }
  }

  return {
    adapterType: "opencode_server",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import fs from "node:fs";
import path from "node:path";
import { basicAuthHeaders } from "./conn.js";
import { ensureOpenCodeServerRunning } from "./lifecycle.js";
import { buildRemoteSync, readRemoteSyncConfig, type RemoteSync } from "./remote-sync.js";
import { pushSkillsToRemote } from "./skills.js";
import { openSseEventStream, consumeSseEvents, type SseRunState } from "./sse.js";
import {
  readAgentHomeConfig,
  agentHomeEnabled,
  syncAgentHomeToRemote,
  deployAgentHomePlugin,
  writeRemoteEnvFile,
  readLocalAgentHomeFromInstructions,
} from "./agent-home.js";

function buildServerConfig(ctx: AdapterExecutionContext): { hostname: string; port: number; command: string; password?: string; mode?: "spawn" | "connect" } {
  const modeRaw = asString(ctx.config.mode, "");
  const mode: "spawn" | "connect" | undefined = modeRaw === "connect" || modeRaw === "spawn" ? modeRaw : undefined;
  return {
    hostname: asString(ctx.config.hostname, "127.0.0.1"),
    port: asNumber(ctx.config.port, 4096),
    command: asString(ctx.config.command, "opencode"),
    password: asString(ctx.config.password, ""),
    ...(mode ? { mode } : {}),
  };
}

function resolveLocalWorkspaceDir(ctx: AdapterExecutionContext): string {
  const workspace = parseObject(ctx.context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "");
  const configuredCwd = asString(ctx.config.cwd, "");
  return workspaceCwd || configuredCwd || process.cwd();
}

function resolveInstructionsFile(ctx: AdapterExecutionContext, cwd: string): string {
  const configured = asString(ctx.config.instructionsFilePath, "").trim();
  if (!configured) return "";
  return path.isAbsolute(configured) ? configured : path.resolve(cwd, configured);
}

/**
 * Rewrite literal host-side workspace paths baked into AGENTS.md so they
 * point at the remote cwd the serve process actually works in. On a remote
 * container the agent's checkout lives at the configured remoteServerCwd
 * (e.g. /work), not at the Paperclip host's ~/.paperclip/instances/... path.
 * Leaving the host path in place burns tokens as the model tries to cd into
 * a directory that does not exist.
 */
function rewriteWorkspacePaths(text: string, remoteCwd: string): string {
  if (!remoteCwd || remoteCwd.length === 0) return text;
  // Common host-layout patterns that never exist inside the container.
  const patterns: Array<[RegExp, string]> = [
    [/~\/\.paperclip\/instances\/default\/projects\/[^\s`"'\\\\]+/g, remoteCwd],
    [/\/home\/[^/]+\/\.paperclip\/instances\/default\/projects\/[^\s`"'\\\\]+/g, remoteCwd],
  ];
  let out = text;
  for (const [re, replacement] of patterns) out = out.replace(re, replacement);
  return out;
}

function readInstructionsPrefix(filePath: string, remoteCwd: string): string {
  const instructionsDir = `${path.dirname(filePath)}/`;
  const contents = rewriteWorkspacePaths(fs.readFileSync(filePath, "utf8"), remoteCwd);
  const remoteNote =
    remoteCwd && remoteCwd.length > 0
      ? `\nYou are running on a remote server. Your checked-out repository lives at ${remoteCwd}. ` +
        `Treat ${remoteCwd} as the repo root; ignore any host-machine absolute paths.\n`
      : "";
  return (
    `${contents}\n\n` +
    `${remoteNote}` +
    `The above agent instructions were loaded from ${filePath}. ` +
    `Resolve any relative file references from ${instructionsDir}.\n\n`
  );
}

function buildPrompt(ctx: AdapterExecutionContext, instructionsPrefix: string): string {
  const promptTemplate = asString(ctx.config.promptTemplate, "");
  const taskContext = asString(ctx.context.paperclipTaskMarkdown, "");
  const sections: string[] = [];
  if (instructionsPrefix) sections.push(instructionsPrefix);
  if (taskContext) sections.push(taskContext);
  if (promptTemplate) sections.push(promptTemplate);
  return sections.join("\n\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when a fetch rejection came from an abort signal. `AbortSignal.timeout`
 * rejects with a DOMException named `TimeoutError` (code 23), while a manual
 * `AbortController.abort()` rejects with `AbortError`. Checking only
 * `name === "AbortError"` silently misses real timeouts and misreports them as
 * generic failures.
 */
function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * Aggregate token usage for a run. opencode's message-level `tokens` is already
 * the sum across every part (including each `step-finish`), so adding
 * `step-finish.tokens` on top double-counts. Use the message-level aggregate as
 * authoritative and only fall back to summing `step-finish` parts when the
 * message-level usage is entirely absent or zero.
 */
function aggregateUsage(
  tokens: Record<string, unknown> | undefined,
  parts: Array<Record<string, any>> | undefined,
): { input: number; output: number; cached: number } {
  const input = typeof tokens?.input === "number" ? tokens.input : 0;
  const output = typeof tokens?.output === "number" ? tokens.output : 0;
  const cache = tokens?.cache as Record<string, unknown> | undefined;
  const cached = typeof cache?.read === "number" ? cache.read : 0;
  if (input > 0 || output > 0 || cached > 0) return { input, output, cached };

  let sumInput = 0, sumOutput = 0, sumCached = 0;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part?.type !== "step-finish") continue;
      const partTokens = part.tokens as Record<string, any> | undefined;
      sumInput += typeof partTokens?.input === "number" ? partTokens.input : 0;
      sumOutput += (typeof partTokens?.output === "number" ? partTokens.output : 0) + (typeof partTokens?.reasoning === "number" ? partTokens.reasoning : 0);
      sumCached += typeof partTokens?.cache?.read === "number" ? partTokens.cache.read : 0;
    }
  }
  return { input: sumInput, output: sumOutput, cached: sumCached };
}

function aggregateCost(cost: number, parts: Array<Record<string, any>> | undefined): number {
  if (cost > 0) return cost;
  if (Array.isArray(parts)) {
    let sum = 0;
    for (const part of parts) {
      if (part?.type === "step-finish" && typeof part.cost === "number") sum += part.cost;
    }
    return sum;
  }
  return 0;
}

/**
 * Read the agent's resolved `env` block from the adapter config. Paperclip's
 * core `resolveAdapterConfigForRuntime` expands `secret_ref` bindings into
 * plaintext values before calling `execute`, so `ctx.config.env` here holds
 * real values (GH_TOKEN from the bound github-app-token secret, etc.). These
 * are forwarded into the shell.env plugin so the warm-server agent can use
 * them in bash tools (git fetch/push against github.com).
 *
 * Handles both unwrapped string values and the `{ type, value }` binding
 * shape defensively, in case an older core passes bindings through.
 */
function readResolvedAgentEnv(env: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (env && typeof env === "object" && !Array.isArray(env)) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        out[key] = value;
      } else if (value && typeof value === "object") {
        const raw = value as Record<string, unknown>;
        if (typeof raw.value === "string") out[key] = raw.value;
      }
    }
  }
  return out;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, runtime, config, context, onLog, onMeta } = ctx;
  const serverConfig = buildServerConfig(ctx);
  const baseUrl = `http://${serverConfig.hostname}:${serverConfig.port}`;
  const model = asString(config.model, "");
  const agentName = asString(config.agent, "build");
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const startTime = Date.now();

  const remoteSyncConfig = readRemoteSyncConfig(config);
  const localWorkspaceDir = resolveLocalWorkspaceDir(ctx);
  const remoteSync = await buildRemoteSync(remoteSyncConfig, localWorkspaceDir, onLog);
  const activeCwd = remoteSync.enabled ? remoteSync.remoteDir : localWorkspaceDir;

  const agentHomeConfig = readAgentHomeConfig(config);
  const instructionsFilePath = resolveInstructionsFile(ctx, localWorkspaceDir);
  const localAgentHomeDir = readLocalAgentHomeFromInstructions(config, instructionsFilePath);
  if (localAgentHomeDir) agentHomeConfig.localAgentHomeDir = localAgentHomeDir;
  const remoteAgentHomeEnabled = agentHomeEnabled(agentHomeConfig);

  try {
    await ensureOpenCodeServerRunning(serverConfig);

    // For remote (warm server) runs, sync the local workspace up to the
    // stable remote cwd BEFORE sending the message. The server may have
    // resumed state from prior heartbeats, so this is incremental (git
    // bundle) rather than a full copy.
    if (remoteSync.enabled) {
      await remoteSync.prepare();
      await pushSkillsToRemote(config, remoteSync.spec!, onLog);
    }

    // Mirror the agent's instructions bundle (AGENTS.md, TOOLS.md, rules/)
    // into the container so $AGENT_HOME/rules/... resolves, install the
    // shell.env plugin that injects AGENT_HOME + PAPERCLIP_* into every bash
    // tool, and write the per-run env values (run-scoped API key) so the
    // agent can post completion comments to the Paperclip board.
    if (remoteAgentHomeEnabled) {
      await syncAgentHomeToRemote(agentHomeConfig, onLog);
      await deployAgentHomePlugin(agentHomeConfig, onLog);
      const envValues: Record<string, string> = {
        AGENT_HOME: agentHomeConfig.remoteAgentHomeDir,
        PAPERCLIP_API_URL: agentHomeConfig.paperclipApiUrl,
        PAPERCLIP_RUN_ID: runId,
        PAPERCLIP_AGENT_ID: ctx.agent?.id ?? "",
        PAPERCLIP_COMPANY_ID: ctx.agent?.companyId ?? "",
        ...readResolvedAgentEnv(ctx.config.env),
      };
      if (ctx.authToken) envValues.PAPERCLIP_API_KEY = ctx.authToken;
      await writeRemoteEnvFile(agentHomeConfig, envValues, onLog);
    }

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const runtimeSessionId = asString(runtimeSessionParams.sessionId, "");
    const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
    // Only resume when the saved session's cwd matches the execution cwd. A
    // session saved for a different workspace would continue the wrong repo
    // context on a warm server, so it must start fresh instead.
    const canResumeSession =
      runtimeSessionId.length > 0 &&
      (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(activeCwd));
    if (runtimeSessionId && !canResumeSession) {
      await onLog?.(
        "stdout",
        `[paperclip] OpenCode session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${activeCwd}". Starting a fresh session.\n`,
      );
    }

    let sessionId: string;
    if (canResumeSession) {
      sessionId = runtimeSessionId;
    } else {
      const sessionRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...basicAuthHeaders(serverConfig) },
        body: JSON.stringify({ title: `Paperclip run ${runId}` }),
        signal: AbortSignal.timeout(5000),
      });
      if (!sessionRes.ok) {
        throw new Error(`Failed to create session: ${sessionRes.status}`);
      }
      const sessionData = await sessionRes.json() as any;
      sessionId = sessionData.id;
    }

    if (onMeta) {
      await onMeta({
        adapterType: "opencode_server",
        command: serverConfig.command,
        cwd: activeCwd,
        commandArgs: [`session=${sessionId}`, `model=${model}`, ...(remoteSync.enabled ? ["ssh=on"] : [])],
        // Forward the resolved agent env so the board's adapter.invoke event
        // shows which env vars reached the warm server (GH_TOKEN, API keys,
        // etc.). The server redacts every secret_ref-derived key before
        // persisting the event, so this is diagnostic-safe. An empty object
        // here previously hid all env context from run events.
        env: readResolvedAgentEnv(ctx.config.env),
        context,
      });
    }

    // Agent instructions are only injected on a FRESH session. On a resumed
    // session they are already in the model's KV context; re-injecting would
    // burn tokens on every heartbeat for no benefit.
    let instructionsPrefix = "";
    if (instructionsFilePath && !canResumeSession) {
      try {
        instructionsPrefix = readInstructionsPrefix(instructionsFilePath, activeCwd);
        await onLog?.("stdout", `[paperclip] Loaded agent instructions from ${instructionsFilePath}.\n`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await onLog?.(
          "stderr",
          `[paperclip] Could not read agent instructions file "${instructionsFilePath}": ${reason}; continuing without them.\n`,
        );
      }
    } else if (instructionsFilePath && canResumeSession) {
      await onLog?.(
        "stdout",
        `[paperclip] Resumed session; instructions from ${instructionsFilePath} not re-injected to avoid wasting tokens.\n`,
      );
    }

    const prompt = buildPrompt(ctx, instructionsPrefix);
    const remainingMs = timeoutSec * 1000 - (Date.now() - startTime);
    const messagePayload: Record<string, unknown> = {
      parts: [{ type: "text", text: prompt || "Continue working on the assigned issue." }],
      agent: agentName,
    };
    if (model && model.includes("/")) {
      const slashIndex = model.indexOf("/");
      messagePayload.model = {
        providerID: model.slice(0, slashIndex),
        modelID: model.slice(slashIndex + 1),
      };
    }

    // Open a live SSE stream to /event BEFORE sending the message. It streams
    // every model event (thinking, messages, tool calls) as they happen and
    // carries the completion signal (session.idle / final message.updated).
    // The message POST below returns one buffered JSON only when the model is
    // done, so its socket idles for the whole generation and can be dropped by
    // NAT/tailnet. When that happens we do NOT fail the run — we keep consuming
    // SSE (heartbeats keep it alive) until the model finishes.
    const sseAbort = new AbortController();
    const sseState: SseRunState = { completed: false, summary: "", tokens: null, costUsd: 0 };
    let sseConsumer: Promise<void> | null = null;
    try {
      const sseStream = await openSseEventStream(serverConfig, sseAbort.signal);
      if (sseStream) {
        sseConsumer = consumeSseEvents(sseStream, onLog, sseState).catch(async (sseErr) => {
          const sseReason = sseErr instanceof Error ? sseErr.message : String(sseErr);
          await onLog?.("stderr", `[paperclip] SSE event stream ended with an error: ${sseReason}\n`);
        });
      }
    } catch (sseErr) {
      const sseReason = sseErr instanceof Error ? sseErr.message : String(sseErr);
      await onLog?.("stderr", `[paperclip] Could not open SSE event stream; continuing without live transcript: ${sseReason}\n`);
    }

    let messageRes: Response;
    try {
      messageRes = await fetch(`${baseUrl}/session/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...basicAuthHeaders(serverConfig) },
        body: JSON.stringify(messagePayload),
        signal: AbortSignal.timeout(Math.max(remainingMs, 10000)),
      });
    } catch (postErr) {
      const isTimeout = isTimeoutError(postErr);
      if (isTimeout) {
        sseAbort.abort();
        return {
          exitCode: -1,
          signal: null,
          timedOut: true,
          errorMessage: `Timed out after ${timeoutSec}s`,
          sessionId,
          sessionParams: { sessionId, cwd: activeCwd },
        };
      }
      // The POST socket dropped (NAT/tailnet idle kill) but the model keeps
      // working server-side. Do NOT abort the SSE stream — keep consuming it
      // until the model finishes (session.idle / final message.updated).
      if (sseConsumer) {
        const waitMs = Math.max(remainingMs - (Date.now() - startTime), 5000);
        await Promise.race([sseConsumer, sleep(waitMs)]);
      }
      sseAbort.abort();
      if (sseState.completed) {
        const sseUsage = sseState.tokens
          ? {
              inputTokens: sseState.tokens.input,
              outputTokens: sseState.tokens.output + sseState.tokens.reasoning,
              cachedInputTokens: sseState.tokens.cacheRead,
            }
          : undefined;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId,
          sessionParams: { sessionId, cwd: activeCwd },
          sessionDisplayId: sessionId,
          provider: model ? model.split("/")[0] || "opencode" : "opencode",
          biller: "opencode",
          model: model || null,
          billingType: "unknown",
          costUsd: sseState.costUsd,
          ...(sseUsage ? { usage: sseUsage } : {}),
          summary: sseState.summary,
          resultJson: { stdout: sseState.summary, stderr: "" },
        };
      }
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `OpenCode server request failed: ${postErr instanceof Error ? postErr.message : String(postErr)}`,
      };
    }
    sseAbort.abort();

    if (!messageRes.ok) {
      const errorBody = await messageRes.text().catch(() => "");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `OpenCode server returned ${messageRes.status}: ${errorBody.slice(0, 200)}`,
        sessionId,
        sessionParams: { sessionId, cwd: activeCwd },
      };
    }

    const response = await messageRes.json() as any;
    const cost = typeof response.cost === "number" ? response.cost : 0;
    const tokens = response.tokens as Record<string, unknown> | undefined;
    const parts = Array.isArray(response.parts) ? (response.parts as Array<Record<string, any>>) : undefined;
    const usage = aggregateUsage(tokens, parts);
    const aggregatedCost = aggregateCost(cost, parts);

    let summary = "";
    if (Array.isArray(response.parts)) {
      for (const part of response.parts) {
        if (part.type === "text" && part.text) {
          summary = part.text;
          break;
        }
      }
    }

    const result: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId,
      sessionParams: { sessionId, cwd: activeCwd },
      sessionDisplayId: sessionId,
      provider: model ? model.split("/")[0] || "opencode" : "opencode",
      biller: "opencode",
      model: model || null,
      billingType: "unknown",
      costUsd: aggregatedCost,
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedInputTokens: usage.cached,
      },
      summary,
      resultJson: { stdout: summary, stderr: "" },
    };
    return result;
  } catch (err) {
    const isTimeout = isTimeoutError(err);
    return {
      exitCode: isTimeout ? -1 : 1,
      signal: null,
      timedOut: isTimeout,
      errorMessage: isTimeout
        ? `Timed out after ${timeoutSec}s`
        : `OpenCode server request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // Always pull remote changes back, even on error, so Paperclip's local
    // workspace never goes stale.
    if (remoteSync.enabled) {
      try {
        await remoteSync.restore();
      } catch (restoreErr) {
        await onLog?.(
          "stderr",
          `[paperclip] Failed to restore workspace from remote: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}\n`,
        );
      }
    }
  }
}
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { asString, asNumber, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { ensureOpenCodeServerRunning } from "./lifecycle.js";

function buildServerConfig(ctx: AdapterExecutionContext): { hostname: string; port: number; command: string; password?: string } {
  return {
    hostname: asString(ctx.config.hostname, "127.0.0.1"),
    port: asNumber(ctx.config.port, 4096),
    command: asString(ctx.config.command, "opencode"),
    password: asString(ctx.config.password, ""),
  };
}

function buildPrompt(ctx: AdapterExecutionContext): string {
  const promptTemplate = asString(ctx.config.promptTemplate, "");
  const taskContext = asString(ctx.context.paperclipTaskMarkdown, "");
  const sections: string[] = [];
  if (taskContext) sections.push(taskContext);
  if (promptTemplate) sections.push(promptTemplate);
  return sections.join("\n\n");
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, runtime, config, context, onMeta } = ctx;
  const serverConfig = buildServerConfig(ctx);
  const baseUrl = `http://${serverConfig.hostname}:${serverConfig.port}`;
  const model = asString(config.model, "");
  const agentName = asString(config.agent, "build");
  const timeoutSec = asNumber(config.timeoutSec, 300);
  const startTime = Date.now();

  try {
    await ensureOpenCodeServerRunning(serverConfig);

    const runtimeSessionParams = parseObject(runtime.sessionParams);
    const existingSessionId = asString(runtimeSessionParams.sessionId, "");

    let sessionId: string;
    if (existingSessionId) {
      sessionId = existingSessionId;
    } else {
      const sessionRes = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        cwd: process.cwd(),
        commandArgs: [`session=${sessionId}`, `model=${model}`],
        env: {},
        context,
      });
    }

    const prompt = buildPrompt(ctx);
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

    const messageRes = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(messagePayload),
      signal: AbortSignal.timeout(Math.max(remainingMs, 10000)),
    });

    if (!messageRes.ok) {
      const errorBody = await messageRes.text().catch(() => "");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `OpenCode server returned ${messageRes.status}: ${errorBody.slice(0, 200)}`,
        sessionId,
        sessionParams: { sessionId, cwd: process.cwd() },
      };
    }

    const response = await messageRes.json() as any;
    const cost = typeof response.cost === "number" ? response.cost : 0;
    const tokens = response.tokens || {};
    const inputTokens = typeof tokens.input === "number" ? tokens.input : 0;
    const outputTokens = typeof tokens.output === "number" ? tokens.output : 0;
    const cachedTokens = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0;

    let summary = "";
    if (Array.isArray(response.parts)) {
      for (const part of response.parts) {
        if (part.type === "text" && part.text) {
          summary = part.text;
          break;
        }
      }
    }

    let aggregatedCost = cost;
    let aggregatedInput = inputTokens;
    let aggregatedOutput = outputTokens;
    let aggregatedCache = cachedTokens;
    if (Array.isArray(response.parts)) {
      for (const part of response.parts) {
        if (part.type === "step-finish") {
          aggregatedCost += typeof part.cost === "number" ? part.cost : 0;
          aggregatedInput += part.tokens?.input || 0;
          aggregatedOutput += (part.tokens?.output || 0) + (part.tokens?.reasoning || 0);
          aggregatedCache += part.tokens?.cache?.read || 0;
        }
      }
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId,
      sessionParams: { sessionId, cwd: process.cwd() },
      sessionDisplayId: sessionId,
      provider: model ? model.split("/")[0] || "opencode" : "opencode",
      biller: "opencode",
      model: model || null,
      billingType: "unknown",
      costUsd: aggregatedCost,
      usage: {
        inputTokens: aggregatedInput,
        outputTokens: aggregatedOutput,
        cachedInputTokens: aggregatedCache,
      },
      summary,
      resultJson: { stdout: summary, stderr: "" },
    };
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    return {
      exitCode: isTimeout ? -1 : 1,
      signal: null,
      timedOut: isTimeout,
      errorMessage: isTimeout
        ? `Timed out after ${timeoutSec}s`
        : `OpenCode server request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/adapter-utils";
import { basicAuthHeaders, serverUrl, type ServerConnection } from "./conn.js";

export async function getOpenCodeServerQuota(conn: ServerConnection): Promise<ProviderQuotaResult> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...basicAuthHeaders(conn) };
    const res = await fetch(`${serverUrl(conn)}/session?limit=100`, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return { provider: "opencode-server", ok: false, error: `Server returned ${res.status}`, windows: [] };
    }
    const sessions = await res.json() as any[];
    const windows: QuotaWindow[] = [];
    let totalCost = 0, totalInput = 0, totalOutput = 0, totalCache = 0;
    if (Array.isArray(sessions)) {
      for (const s of sessions) {
        totalCost += typeof s.cost === "number" ? s.cost : 0;
        totalInput += typeof s.tokens_input === "number" ? s.tokens_input : 0;
        totalOutput += typeof s.tokens_output === "number" ? s.tokens_output : 0;
        totalCache += typeof s.tokens_cache_read === "number" ? s.tokens_cache_read : 0;
      }
      if (sessions.length > 0) {
        windows.push(
          { label: "Recent sessions", usedPercent: null, resetsAt: null, valueLabel: `${sessions.length} sessions` },
          { label: "Total cost", usedPercent: null, resetsAt: null, valueLabel: `$${totalCost.toFixed(4)}` },
          { label: "Tokens", usedPercent: null, resetsAt: null, valueLabel: `${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out` },
          { label: "Cache reads", usedPercent: null, resetsAt: null, valueLabel: `${totalCache.toLocaleString()}` },
        );
      }
    }
    return { provider: "opencode-server", source: "session-history", ok: windows.length > 0, windows };
  } catch (err) {
    return {
      provider: "opencode-server",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      windows: [],
    };
  }
}

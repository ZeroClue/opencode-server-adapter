import type { AdapterModel } from "@paperclipai/adapter-utils";
import { basicAuthHeaders, serverUrl, type ServerConnection } from "./conn.js";

export async function listOpenCodeServerModels(conn: ServerConnection): Promise<AdapterModel[]> {
  try {
    const res = await fetch(`${serverUrl(conn)}/provider`, {
      headers: { ...basicAuthHeaders(conn) },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    const connected: string[] = Array.isArray(data.connected) ? data.connected : [];
    const defaults: Record<string, string> = data.default || {};
    const models: AdapterModel[] = [];
    for (const provider of connected) {
      const defaultModel = defaults[provider];
      if (defaultModel) {
        models.push({ id: `${provider}/${defaultModel}`, label: `${provider}/${defaultModel}` });
      }
    }
    return models;
  } catch {
    return [];
  }
}

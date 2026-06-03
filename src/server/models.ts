import type { AdapterModel } from "@paperclipai/adapter-utils";

interface ServerConnection {
  hostname: string;
  port: number;
}

export async function listOpenCodeServerModels(conn: ServerConnection): Promise<AdapterModel[]> {
  try {
    const res = await fetch(`http://${conn.hostname}:${conn.port}/provider`, {
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
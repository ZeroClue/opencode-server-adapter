/**
 * Connection config shared by discovery helpers (listModels, getQuotaWindows)
 * and the execute/test lifecycle. `command` belongs on the spawn-side
 * ServerConfig in lifecycle.ts, not here — discovery only needs the network
 * endpoint and optional HTTP Basic password.
 */
export interface ServerConnection {
  hostname: string;
  port: number;
  password?: string;
}

export const DEFAULT_CONN: ServerConnection = { hostname: "127.0.0.1", port: 4096 };

export function serverUrl(conn: ServerConnection): string {
  return `http://${conn.hostname}:${conn.port}`;
}

/**
 * HTTP Basic auth headers for `opencode serve`. The server expects the
 * username `opencode` paired with the `OPENCODE_SERVER_PASSWORD`. Returns
 * an empty record when no password is configured so the caller can spread
 * it unconditionally.
 */
export function basicAuthHeaders(conn: ServerConnection): Record<string, string> {
  if (!conn.password) return {};
  return { Authorization: `Basic ${Buffer.from(`opencode:${conn.password}`).toString("base64")}` };
}

/**
 * Coerce a raw discovery config (e.g. one passed to `createServerAdapter`)
 * into a ServerConnection using the adapter-utils coercion helpers, falling
 * back to the per-process default when values are missing.
 */
export function coerceConn(input: unknown, fallback: ServerConnection = DEFAULT_CONN): ServerConnection {
  const record = coerceConnRecord(input);
  return connFromRecord(record, fallback);
}

/**
 * Build a ServerConnection for a discovery hook from an optional
 * `AdapterDiscoveryContext` (per-agent resolved config), coercing the raw
 * input through the same path so values override the fallback. When no ctx
 * (or no recognizable config) is present, the per-agent config is skipped
 * and the fallback (factory discovery config or the process default) wins —
 * matching the adapter-utils contract that discovery hooks must degrade to
 * the default connection when invoked without an agent context.
 */
export function discoveryConnFromRecord(config: unknown, fallback: ServerConnection = DEFAULT_CONN): ServerConnection {
  return connFromRecord(coerceConnRecord(config), fallback);
}

function coerceConnRecord(input: unknown): Record<string, unknown> {
  return (input && typeof input === "object" && !Array.isArray(input)) ? input as Record<string, unknown> : {};
}

function connFromRecord(record: Record<string, unknown>, fallback: ServerConnection): ServerConnection {
  const hostname = typeof record.hostname === "string" && record.hostname.trim() ? record.hostname.trim() : fallback.hostname;
  const portNum = typeof record.port === "number" && Number.isFinite(record.port) && record.port > 0 ? record.port : fallback.port;
  const password = typeof record.password === "string" && record.password ? record.password : undefined;
  return password ? { hostname, port: portNum, password } : { hostname, port: portNum };
}

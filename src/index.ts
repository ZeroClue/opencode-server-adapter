import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "opencode_server";
export const label = "OpenCode (server)";
export const models: Array<{ id: string; label: string }> = [];
export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use the configured cheap model for cost-sensitive work.",
    adapterConfig: { variant: "low" },
    source: "adapter_default",
  },
];
export const agentConfigurationDoc = `# opencode_server agent configuration

Adapter: opencode_server

Connects to a persistent opencode serve instance via its REST API.
Paperclip manages the server lifecycle as a child process.

Use when:
- You want warm-server performance (no cold start per heartbeat)
- You want true concurrent agent sessions
- You want MCP servers to stay connected across heartbeats
- You need remote agent execution via hostname config

Don't use when:
- opencode CLI is not installed
- You need a simple subprocess-based integration (use opencode_local)

Core fields:
- hostname (string, default: "127.0.0.1"): server bind address
- port (number, default: 4096): server listen port
- password (secret): OPENCODE_SERVER_PASSWORD for HTTP basic auth
- command (string, default: "opencode"): path to opencode binary
- model (string, required): model ID in provider/model format
- cheapModel (string, optional): cheaper model for non-critical work
- agent (string, default: "build"): OpenCode agent to route to
- steps (number, default: 300): max agentic steps per run

Notes:
- Server is auto-started as a child process of Paperclip
- Provider credentials come from "opencode auth login" on the server machine
- Session KV cache persists across heartbeats via session resume
- Remote server: set hostname to the remote IP and add password
`;
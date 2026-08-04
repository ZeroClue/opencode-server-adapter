import type {
  AdapterModel,
  AdapterModelProfileDefinition,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";

import { execute } from "./server/execute.js";
import { testEnvironment } from "./server/test.js";
import { sessionCodec } from "./server/codec.js";
import { listOpenCodeServerModels } from "./server/models.js";
import { getOpenCodeServerQuota } from "./server/stats.js";
import { getOpenCodeServerConfigSchema } from "./ui/config-schema.js";
import { DEFAULT_CONN, coerceConn, type ServerConnection } from "./server/conn.js";

const DEFAULT_MODELS: AdapterModel[] = [];

const MODEL_PROFILES: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use opencode-go/deepseek-v4-flash as a cheaper model for cost-sensitive work.",
    adapterConfig: { model: "opencode-go/deepseek-v4-flash" },
    source: "adapter_default",
  },
];

const AGENT_CONFIGURATION_DOC = `# opencode_server agent configuration

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
- mode (string, default: "spawn"): "spawn" to let Paperclip start opencode serve; "connect" to poll an existing endpoint (use for remote/Docker; auto-promotes to "connect" when hostname is non-loopback)
- model (string, required): model ID in provider/model format
- cheapModel (string, optional): cheaper model for non-critical work (defaults to opencode-go/deepseek-v4-flash)
- agent (string, default: "build"): OpenCode agent to route to
- steps (number, default: 300): max agentic steps per run

Notes:
- Server is auto-started as a child process of Paperclip in spawn mode (default);
  in connect mode Paperclip never spawns — the remote host (Docker host, systemd,
  etc.) owns restart semantics
- Provider credentials come from "opencode auth login" on the server machine
- Session KV cache persists across heartbeats via session resume
- Remote server: set hostname to the remote IP/tailnet name, set mode to "connect"
  (or leave mode unset to auto-promote), and add password
`;

export function createServerAdapter(discoveryConfig?: unknown): ServerAdapterModule {
  const discoveryConn: ServerConnection = coerceConn(discoveryConfig, DEFAULT_CONN);
  return {
    type: "opencode_server",
    execute,
    testEnvironment,
    sessionCodec,
    models: DEFAULT_MODELS,
    modelProfiles: MODEL_PROFILES,
    listModels: () => listOpenCodeServerModels(discoveryConn),
    getQuotaWindows: () => getOpenCodeServerQuota(discoveryConn),
    getConfigSchema: () => Promise.resolve(getOpenCodeServerConfigSchema()),
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
    requiresMaterializedRuntimeSkills: false,
    agentConfigurationDoc: AGENT_CONFIGURATION_DOC,
  };
}
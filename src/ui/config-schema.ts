import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getOpenCodeServerConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "hostname",
        label: "Server hostname",
        type: "string",
        default: "127.0.0.1",
        hint: "Hostname for the opencode serve instance. Use 127.0.0.1 for local, or an IP/hostname for remote.",
      },
      {
        key: "port",
        label: "Server port",
        type: "number",
        default: 4096,
        hint: "Port for the opencode serve instance.",
      },
      {
        key: "password",
        label: "Server password",
        type: "secret",
        default: "",
        hint: "OPENCODE_SERVER_PASSWORD for HTTP basic auth.",
      },
      {
        key: "command",
        label: "OpenCode binary path",
        type: "string",
        default: "opencode",
        hint: "Path to the opencode binary. Defaults to resolving from PATH.",
      },
      {
        key: "model",
        label: "Default model",
        type: "model",
        default: "opencode-go/deepseek-v4-flash",
        hint: "Default model for agent runs. Can be overridden per-run.",
      },
      {
        key: "cheapModel",
        label: "Cheap model",
        type: "model",
        default: "",
        hint: "Optional cheaper model for non-critical work.",
      },
      {
        key: "agent",
        label: "OpenCode agent",
        type: "string",
        default: "build",
        hint: "OpenCode agent to use (e.g. build, plan, or custom agent).",
      },
      {
        key: "steps",
        label: "Max steps",
        type: "number",
        default: 300,
        hint: "Maximum agentic steps per run. 0 = unlimited (native doom_loop guard applies).",
      },
    ],
  };
}
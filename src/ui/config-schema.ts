import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getOpenCodeServerConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "hostname",
        label: "Server hostname",
        type: "text",
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
        type: "text",
        default: "",
        hint: "OPENCODE_SERVER_PASSWORD for HTTP basic auth.",
        meta: { secret: true },
      },
      {
        key: "command",
        label: "OpenCode binary path",
        type: "text",
        default: "opencode",
        hint: "Path to the opencode binary. Defaults to resolving from PATH.",
      },
      {
        key: "mode",
        label: "Server connection mode",
        type: "combobox",
        default: "spawn",
        options: [
          { value: "spawn", label: "spawn — Paperclip starts and owns opencode serve as a child process" },
          { value: "connect", label: "connect — Paperclip polls an existing opencode serve; never spawns" },
        ],
        hint: "Default 'spawn' for local dev. Use 'connect' for remote/Docker servers; auto-promotes to 'connect' when hostname is non-loopback.",
      },
      {
        key: "model",
        label: "Default model",
        type: "combobox",
        default: "opencode-go/deepseek-v4-flash",
        hint: "Default model for agent runs. Can be overridden per-run.",
      },
      {
        key: "cheapModel",
        label: "Cheap model",
        type: "combobox",
        default: "opencode-go/deepseek-v4-flash",
        hint: "Cheaper model for cost-sensitive work. Defaults to opencode-go/deepseek-v4-flash.",
      },
      {
        key: "agent",
        label: "OpenCode agent",
        type: "text",
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
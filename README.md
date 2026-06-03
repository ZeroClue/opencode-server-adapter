# OpenCode Server Adapter

A Paperclip adapter plugin that connects to a persistent [opencode serve](https://opencode.ai/docs/server/) instance via its REST API, replacing the subprocess-based `opencode_local` model with a warm-server architecture.

## Features

- **Warm-server performance** — no cold start per heartbeat, `opencode serve` stays running
- **True concurrent sessions** — multiple agents share one server via independent sessions
- **Persistent MCP servers** — MCP connections stay alive across heartbeats
- **Structured cost data** — cost and token data from JSON API, not terminal parsing
- **Session KV cache** — provider-level caching persists across heartbeats via session resume
- **Remote capable** — change the hostname config for remote execution
- **No tmux dependency** — Paperclip manages the server as a child process

## Installation

```bash
# Install the plugin
paperclipai plugin install @zeroclue/opencode-server-adapter
```

## Quick Start

1. Ensure opencode CLI is installed and authenticated ([get OpenCode Go](https://opencode.ai/go?ref=JAFCG08A7T)):
```bash
opencode auth list
```

2. Create an agent with adapter type `opencode_server`:
```bash
paperclipai agent create --company-id <coId> --name "my-agent" \
  --adapter opencode_server \
  --adapter-config '{
    "model": "opencode-go/deepseek-v4-flash",
    "hostname": "127.0.0.1",
    "port": 4096,
    "steps": 300
  }'
```

3. Assign an issue — Paperclip starts `opencode serve` automatically on first heartbeat.

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `hostname` | `127.0.0.1` | Server bind address |
| `port` | `4096` | Server listen port |
| `password` | (empty) | `OPENCODE_SERVER_PASSWORD` for HTTP basic auth |
| `command` | `opencode` | Path to opencode binary |
| `model` | (required) | Model ID in provider/model format |
| `cheapModel` | (optional) | Cheaper model for non-critical work |
| `agent` | `build` | OpenCode agent to route to |
| `steps` | `300` | Max agentic steps per run |

## How It Works

```
Paperclip Server
    │
    ├─ spawns opencode serve as child process
    │
    ├─ adapter.execute(ctx)
    │   ├─ ensureRunning() → healthcheck / spawn
    │   ├─ POST /session          → create session
    │   ├─ POST /session/:id/message → send prompt
    │   ├─ parse structured JSON response
    │   └─ return AdapterExecutionResult
    │
    └─ on shutdown → SIGTERM child process
```

## Development

```bash
git clone https://github.com/ZeroClue/opencode-server-adapter
cd opencode-server-adapter
pnpm install
pnpm typecheck
pnpm test
```

## License

MIT

---

**OpenCode Go?** [Get started with OpenCode](https://opencode.ai/go?ref=JAFCG08A7T) — multi-provider AI coding agent for the terminal.

**Support the project:** If this plugin saves you time and you're feeling generous, [buy me a coffee](https://www.buymeacoffee.com/thezeroclue) ☕
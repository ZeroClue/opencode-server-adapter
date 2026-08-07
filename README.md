# OpenCode Server Adapter

A Paperclip adapter plugin that connects to a persistent [opencode serve](https://opencode.ai/docs/server/) instance via its REST API, replacing the subprocess-based `opencode_local` model with a warm-server architecture.

An `@zeroclue` first-party adapter for the Paperclip instance. Each Paperclip agent wires to exactly one `opencode serve` endpoint — URL + HTTP Basic auth + model ID. Whether that endpoint is a local child process, a remote VM, or a container on a tailnet host is invisible to the agent.

## Features

- **Warm-server performance** — no cold start per heartbeat, `opencode serve` stays running
- **True concurrent sessions** — multiple agents share one server via independent sessions
- **Persistent MCP servers** — MCP connections stay alive across heartbeats
- **Structured cost data** — cost and token data from the JSON API, not terminal parsing
- **Session KV cache** — provider-level caching persists across heartbeats via session resume
- **Remote capable** — `mode: connect` targets any reachable endpoint (VM, Docker container, tailnet host)
- **SSH workspace sync** — syncs the local workspace into a stable remote cwd per run and pulls changes back
- **Skills materialization** — desired Paperclip skills are pushed to the remote host's discovery paths during prepare
- **Instructions bundle** — injected on fresh sessions only (never re-burned on resumed ones)
- **No tmux dependency** — Paperclip manages a local server as a child process; remote keepers own their own restart semantics

## Installation

Install as a Paperclip adapter plugin (or install directly from a local checkout with a `file:` entry):

```bash
paperclipai plugin install @zeroclue/opencode-server-adapter
```

## Quick Start

1. Ensure opencode CLI is installed and authenticated:

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

3. Assign an issue — Paperclip starts `opencode serve` automatically on the first heartbeat (`mode: spawn`, the default).

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `hostname` | `127.0.0.1` | Server bind address / remote endpoint host |
| `port` | `4096` | Server listen port |
| `password` | (empty) | `OPENCODE_SERVER_PASSWORD` for HTTP Basic auth (use a Paperclip secret reference) |
| `mode` | `spawn` | `spawn` to let Paperclip start the server; `connect` to poll an existing endpoint (auto-promotes to `connect` for non-loopback hostnames) |
| `command` | `opencode` | Path to the opencode binary (spawn mode only) |
| `model` | (required) | Model ID in `provider/model` format |
| `agent` | `build` | OpenCode agent to route to (e.g. `build`, `plan`, or custom) |
| `steps` | `300` | Max agentic steps per run. ⚠️ **documented, not enforced by the adapter** — see note below |
| `cheapModel` | (optional) | Cheaper model for non-critical work. ⚠️ **not consumed at runtime** — model-profile driven. See note below |
| `timeoutSec` | `300` | Max wall-clock seconds before the adapter aborts the run (`timedOut: true`) |
| `instructionsFilePath` | (empty) | Absolute path to an AGENTS.md-style bundle; injected on fresh sessions only |
| `promptTemplate` | (empty) | Text appended to the run prompt as a stable suffix |

### SSH workspace sync (warm remote servers)

`sshHost`, `sshUsername`, `sshPrivateKey` (+ `sshPort` = `2222`, `sshKnownHosts`, `strictHostKeyChecking`, `remoteServerCwd`) enable per-run workspace sync over SSH into a stable remote cwd. Leave empty for connect-only (no workspace sync).

Full field reference: [docs/configuration.md](./docs/configuration.md).
Docker deployment for the remote endpoint: [deploy/README.md](./deploy/README.md).

### Notes on `steps` and `cheapModel`

These fields are declared for forward compatibility. opencode enforces `steps` only in the serve's per-agent config (not addressable via the message REST call), and cheap-model selection is driven by the server-side model-profile controller — so the adapter does not read either at runtime. See `AGENTS.md` gotchas #6/#9 and the CHANGELOG for the investigation.

## How It Works

```
Paperclip Server
    │
    ├─ spawns opencode serve as child process   (spawn mode only)
    │
    ├─ adapter.execute(ctx)
    │   ├─ ensureRunning() → healthcheck / spawn
    │   ├─ [ssh] prepare() → push workspace + skills to stable remote cwd
    │   ├─ POST /session          → create or resume session
    │   ├─ POST /session/:id/message → send prompt
    │   ├─ parse structured JSON response → TranscriptEntry[]
    │   ├─ [ssh] restore() → pull changes back (finally)
    │   └─ return AdapterExecutionResult
    │
    └─ on shutdown → SIGTERM child process (spawn mode)
```

## Development

```bash
git clone https://github.com/ZeroClue/opencode-server-adapter
cd opencode-server-adapter
pnpm install
pnpm typecheck
pnpm test
```

- **Node 22** (CI matrix); `AbortSignal.timeout` requires Node ≥ 18.17.
- ESM-only with `.js` extensions in relative imports.
- Read [AGENTS.md](./AGENTS.md) and [docs/architecture.md](./docs/architecture.md) before touching `src/server/*`.

## License

MIT
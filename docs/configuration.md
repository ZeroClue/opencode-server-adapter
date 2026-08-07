# Configuration

## Fields

### hostname
- Type: string
- Default: `"127.0.0.1"`
- The hostname where `opencode serve` listens. Use `127.0.0.1` for local, or an IP/hostname for remote instances.

### port
- Type: number
- Default: `4096`
- The port where `opencode serve` listens.

### password
- Type: secret
- Default: (empty)
- Sets `OPENCODE_SERVER_PASSWORD` for HTTP basic auth when spawning the server. Required for remote instances.

### command
- Type: string
- Default: `"opencode"`
- Path to the opencode binary. Defaults to resolving from PATH.

### mode
- Type: `"spawn"` | `"connect"`
- Default: `"spawn"`
- Controls server lifecycle behavior.
  - `spawn`: Paperclip starts `opencode serve` as a child process and owns its lifecycle (SIGTERM on teardown). Use for local dev.
  - `connect`: Paperclip polls an existing `opencode serve` endpoint and never spawns. Use for remote/Docker servers; on unreachable, the adapter returns an error — it cannot restart a remote container.
- Auto-promotion: if `mode` is unset and `hostname` is anything other than `127.0.0.1` / `localhost` / `::1`, the adapter treats it as `connect`. Set explicitly to override.

### model
- Type: model (dropdown)
- Required: yes
- Default: `"opencode-go/deepseek-v4-flash"`
- The model to use in provider/model format. Populated from connected providers.

### cheapModel
- Type: model (dropdown)
- Required: no
- Optional cheaper model for non-critical work.

### agent
- Type: string
- Default: `"build"`
- The OpenCode agent to route to. Built-in agents: `build`, `plan`. Custom agents also supported.

### steps
- Type: number
- Default: `300`
- Maximum agentic steps per run. 0 = unlimited (native doom_loop guard applies).
- ⚠️ **Not yet enforced by the adapter** — documented for forward compatibility; the runtime does not read `steps`.

### timeoutSec
- Type: number
- Default: `300`
- Maximum wall-clock seconds a run may take before the adapter aborts it as timed out (`timedOut: true`).

### instructionsFilePath
- Type: string
- Default: (empty)
- Absolute path to an AGENTS.md-style instructions bundle on the Paperclip host. Injected into fresh sessions; skipped on resumed sessions to avoid token burn.

### promptTemplate
- Type: textarea
- Default: (empty)
- Template text appended to the run prompt as a stable suffix (e.g. reporting format, output contract). Combined with the instructions and task context.

### SSH + workspace sync (warm remote servers)

These fields enable per-run workspace sync from the Paperclip host into the
remote serve container over SSH. When `sshHost`, `sshUsername`,
`sshPrivateKey`, and `remoteServerCwd` are all set, each heartbeat syncs the
local workspace up to the stable remote cwd before sending the message, then
pulls changes back when the run completes. Leave them empty for
connect-only mode (no workspace sync).

### sshHost
- Type: string
- Default: (empty)
- Tailnet hostname for the VPS running the serve container. Empty disables workspace sync.

### sshPort
- Type: number
- Default: `2222`
- SSH port exposed by the serve container. Use a high port (e.g. `2222`) to avoid colliding with host ssh.

### sshUsername
- Type: string
- Default: (empty)
- SSH user for workspace sync (key-based auth).

### sshPrivateKey
- Type: secret
- Default: (empty)
- Private key content used to reach the VPS. Prefer referencing a Paperclip secret rather than committing plaintext.

### sshKnownHosts
- Type: textarea
- Default: (empty)
- Optional known_hosts content to pin the VPS host key. Leave empty to use the default known_hosts.

### strictHostKeyChecking
- Type: toggle
- Default: `true`
- Reject SSH connections with an unverified host key. Disable only for ephemeral test environments.

### remoteServerCwd
- Type: string
- Default: (empty)
- Stable working directory the serve process uses on the VPS. Workspace sync targets this path. It must match the container's `WORKDIR`. **Reuse the same dir across heartbeats** so opencode can resume the session instead of re-reading the repo.

### cwd
- Type: string
- Default: (empty)
- Optional override for the local workspace directory used as the sync source. Defaults to the Paperclip execution workspace.

## Example (remote warm server)

```json
{
  "model": "opencode-go/deepseek-v4-flash",
  "hostname": "agent-a.tailnet",
  "port": 4096,
  "password": "{{ secret:opencode-server-pass }}",
  "mode": "connect",
  "agent": "build",
  "steps": 300,
  "sshHost": "agent-a.tailnet",
  "sshPort": 2222,
  "sshUsername": "opencode",
  "sshPrivateKey": "{{ secret:opencode-vps-key }}",
  "remoteServerCwd": "/work"
}
```
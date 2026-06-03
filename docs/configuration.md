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

## Example

```json
{
  "model": "opencode-go/deepseek-v4-flash",
  "hostname": "127.0.0.1",
  "port": 4096,
  "command": "opencode",
  "agent": "build",
  "steps": 300
}
```
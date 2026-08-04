# Remote Docker deployment

This is a worked example for running `opencode serve` in a Docker container on
a Tailscale tailnet, and pointing a Paperclip agent at it. For the deploy
artifacts themselves, see [`deploy/README.md`](../deploy/README.md) — the
Dockerfile, compose file, and `.env.example` all live there.

## Why

The `opencode_server` adapter's `mode: "connect"` config treats the endpoint
as a warm server: Paperclip polls `/global/health`, never spawns, and on
unreachable returns a clear `opencode_server_remote_unreachable` error
suggesting you restart your container host. This matches Docker's
`restart: always` semantics — the remote host owns restart, Paperclip owns
orchestration.

Over a Tailscale tailnet, HTTP Basic auth (`OPENCODE_SERVER_PASSWORD`) is the
only auth you need — it's adequate over WireGuard. Do not run this on the
public internet without TLS termination in front.

## Worked example

```sh
# 1. Build and run the container on the remote host (a VM on your tailnet).
cd ~/projects/opencode-server-adapter/deploy
cp .env.example .env
# set OPENCODE_SERVER_PASSWORD to e.g. `head -c 32 /dev/urandom | base64`
docker compose up -d

# 2. (Optional) add the Tailscale sidecar per deploy/README.md and verify
#    the tailnet hostname resolves from your Paperclip host:
curl http://opencode-serve.<your-tailnet>:4096/global/health
# {"healthy":true,"version":"1.0.180"}

# 3. Store the password in Paperclip's secret store.
paperclipai secret create opencode-server-password
# paste the same OPENCODE_SERVER_PASSWORD value you put in deploy/.env

# 4. Create the Paperclip agent in connect mode.
paperclipai agent create \
  --name "remote-opencode" \
  --adapter opencode_server \
  --adapter-config '{
    "hostname": "opencode-serve.<your-tailnet>",
    "port": 4096,
    "mode": "connect",
    "password": { "type": "secret_ref", "secretId": "opencode-server-password", "version": "latest" },
    "model": "opencode-go/deepseek-v4-flash"
  }'
```

## Restart-supervisor caveat

Remote unreachable ≠ Paperclip can restart the box. The adapter deliberately
never spawns when `mode: "connect"`, so if the container or its host goes
down, Paperclip reports the failure and waits — that's by design. Your
deployment's restart policy is the supervisor:

- **Docker / Compose:** `restart: always` in `docker-compose.yml` (already
  set in `deploy/docker-compose.yml`). Covers container crashes and host
  reboots (Docker daemon auto-restarts containers with this policy on boot).
- **Bare metal / systemd:** if you run `opencode serve` directly in a systemd
  service rather than a container, set `Restart=always` and
  `RestartSec=5s` on the unit. The adapter still treats it as connect-mode
  remote; only the supervisor differs.
- **Kubernetes:** fall back to a `Deployment` with `restartPolicy: Always`
  (the default). Avoid a one-shot `Job` — M3 does not cover K8s, but the
  principle is the same: anything that owns the runtime lifecycle.

For the fuller deploy story (image build instructions, Tailscale sidecar
snippet, credential persistence for `opencode auth login`), see
[`deploy/README.md`](../deploy/README.md).

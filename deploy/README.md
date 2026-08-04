# opencode-serve Docker deployment

A self-contained Docker image that runs `opencode serve` as a long-lived HTTP
endpoint. Point a Paperclip agent at it over a tailnet (or any private network)
and the `opencode_server` adapter will connect in `mode: "connect"` — polling
this endpoint instead of spawning a child process per heartbeat.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Builds the image: Debian slim + static `opencode` binary, non-root user, `opencode serve --hostname 0.0.0.0 --port 4096` entrypoint. |
| `docker-compose.yml` | Single service, `restart: always`, `.env`-sourced password, port mapping, `/global/health` healthcheck. |
| `.env.example` | Template — copy to `.env` and fill in `OPENCODE_SERVER_PASSWORD`. |

## Build

```sh
cd deploy
cp .env.example .env
# edit .env and set OPENCODE_SERVER_PASSWORD to a strong random string
docker compose build
```

To pin a specific opencode version:

```sh
docker compose build --build-arg OPENCODE_VERSION=1.0.180
```

## Run

```sh
docker compose up -d
docker compose logs -f
```

The server is now listening on `http://127.0.0.1:${OPENCODE_PORT:-4096}` (or
`${OPENCODE_HOST}:${OPENCODE_PORT}` if you set `OPENCODE_HOST`). Healthcheck:

```sh
curl http://127.0.0.1:4096/global/health
# {"healthy":true,"version":"1.0.180"}
```

## Put it on a tailnet (Tailscale sidecar — recommended)

The recommended deployment is a Tailscale sidecar container next to the
`opencode-serve` container, sharing its network namespace so the Paperclip
host can reach `opencode` via a stable tailnet hostname over WireGuard.

1. Generate a Tailscale auth key at https://login.tailscale.com/admin/settings/keys
   (reusable, tagged for this deployment).
2. Add a sidecar service to `docker-compose.yml`:

   ```yaml
   services:
     tailscale:
       image: tailscale/tailscale:latest
       hostname: opencode-serve
       environment:
         TS_AUTHKEY: tskey-auth-XXXXX       # from .env or your secret manager
         TS_STATE_DIR: /var/lib/tailscale
       volumes:
         - tailscale-state:/var/lib/tailscale
       cap_add:
         - NET_ADMIN
       network_mode: service:opencode-serve   # share network namespace
     opencode-serve:
       # ...as above; remove the `ports:` mapping since tailnet handles exposure
   volumes:
     tailscale-state:
   ```

3. `docker compose up -d`. The container appears in your tailnet admin console
   as `opencode-serve.<your-tailnet>`. Paperclip reaches it at
   `http://opencode-serve.<your-tailnet>:4096`.

The sidecar pattern is portable across Docker hosts without depending on the
host having Tailscale installed. Host-level Tailscale also works if you'd
rather not run a second container, but you'll need to expose `4096` to the
tailnet interface explicitly (`OPENCODE_HOST=` of the tailnet IP, plus a
firewall rule if needed).

## Point a Paperclip agent at it

Now that the adapter supports `mode: "connect"` (see the adapter's
`docs/configuration.md`), the Paperclip agent config is straightforward —
explicit `mode`, the tailnet hostname, and the password as a Paperclip secret
reference (so it's not committed in plaintext agent config).

```sh
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

Use a separate `paperclipai secret create opencode-server-password` to store
the password in Paperclip's secret store and reference it from the agent
config as above. Don't commit the password in plaintext.

## Caveats

- **Restart semantics.** When the remote container is unreachable, the
  adapter won't try to restart it — that's `Docker`'s job (`restart: always`
  above). If the *host* goes down, that's outside Paperclip's reach too; use a
  process supervisor (`systemd` for bare metal, the orchestrator for k8s) on
  the remote box. The adapter will healthcheck, surface a clear
  `opencode_server_remote_unreachable` diagnostic in `testEnvironment`, and
  keep retrying on the next heartbeat.
- **HTTP Basic is the only auth over the wire.** Adequate over WireGuard; do
  not expose this server on the public internet without TLS termination in
  front.
- **Provider credentials live on the server, not the Paperclip host.** Run
  `docker compose exec opencode-serve opencode auth login` once the container
  is up to configure provider credentials (Anthropic, OpenAI, Zai, etc.).
  These persist in the `opencode` user's home dir inside the container; if you
  recreate the container, you'll need to re-auth. For long-lived deployments,
  mount a volume at `/home/opencode/.config/opencode` to persist auth across
  container rebuilds.

## See also

- [docs/remote-docker.md](../docs/remote-docker.md) — worked example with
  a tailnet hostname, plus the restart-supervisor caveat amplified.
- [../AGENT_CONFIGURATION_DOC](../src/index.ts) — the adapter
  `agentConfigurationDoc` string (rendered in Paperclip's UI).

# opencode-serve Docker deployment

A self-contained Docker image that runs `opencode serve` as a long-lived HTTP
endpoint **plus an in-container sshd**. Point a Paperclip agent at it over a
tailnet (or any private network) and the `opencode_server` adapter connects in
`mode: "connect"`, then syncs the workspace / skills / instructions into the
container's stable cwd over SSH so warm sessions are resumed instead of
cold-restarted.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Builds the image: Debian slim + static `opencode` binary + `openssh-server`, non-root `opc` user (uid/gid 1000), stable `/work` cwd. |
| `entrypoint.sh` | Starts sshd on 2222, then `opencode serve` on 4096 as `opc`. |
| `docker-compose.yml` | Single service, `restart: always`, `.env`-sourced creds, both ports, persistence volumes, `/global/health` healthcheck. |
| `.env.example` | Template — copy to `.env` and fill in `OPENCODE_SERVER_PASSWORD` + `OPENCODE_API_KEY`. |
| `ssh/` | **gitignored** — put your generated deploy keypair here (private key stays local; only `authorized_keys` is mounted into the container). |

## Build

```sh
cd deploy
cp .env.example .env
# edit .env: set OPENCODE_SERVER_PASSWORD (HTTP Basic) and
# OPENCODE_API_KEY (opencode zen provider credential, provider "opencode").
docker compose build
```

To pin a specific opencode version:

```sh
docker compose build --build-arg OPENCODE_VERSION=1.0.180
```

## Set up the SSH deploy key

The adapter host SSHes into the container (port 2222) to sync the workspace
and skills. Generate a keypair on the host and authorize it:

```sh
mkdir -p deploy/ssh
ssh-keygen -t ed25519 -N "" -f deploy/ssh/paperclip_deploy_ed25519
cp deploy/ssh/paperclip_deploy_ed25519.pub deploy/ssh/authorized_keys
```

`deploy/ssh/` is gitignored — never commit the private key.

## Run

```sh
docker compose up -d
docker compose logs -f
```

The server listens on `http://127.0.0.1:${OPENCODE_PORT:-4096}` and sshd on
`${SSH_PORT:-2222}`. Healthcheck:

```sh
curl -fsS -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:4096/global/health
```

## Upgrading opencode

The opencode version is baked into the image at build time. Updating it means
rebuilding the image and re-creating the container — nothing hot-reloads the
binary:

```sh
cd deploy
# pick a specific version, or omit the arg to pull the latest stable:
docker compose build --build-arg OPENCODE_VERSION=<new-version>
docker compose up -d --force-recreate
```

Notes:

- **State survives.** The `opencode-auth` and `opencode-state` volumes persist
  provider login and warm session state across the rebuild, so warm sessions
  keep resuming. SSH sync (`authorized_keys` + `/work`) is unaffected.
- **Not a rolling update.** `restart: always` only restarts the *same* image
  on crash; it never pulls a new one. Rebuild + recreate is the update path.
- **Versioned builds are the safe default** (`--build-arg OPENCODE_VERSION=X`)
  so your deploys are reproducible. Omitting the arg uses whatever the
  upstream install script ships that day.
- Optionally tag the result (`image: opencode-serve:vX.Y.Z` in the compose
  file, or `docker tag`) so a fixed set of pinned images can be pulled by
  multiple hosts.
- **Separate from the adapter.** This updates `opencode serve` *inside the
  container*. `opencode_server` (the Paperclip adapter package on the control
  host) is updated independently via `~/.paperclip/adapter-plugins.json` +
  server restart.

## Point a Paperclip agent at it

With the adapter's `mode: "connect"` + SSH sync support, the agent config is:

```sh
paperclipai agent create \
  --name "remote-opencode" \
  --adapter opencode_server \
  --adapter-config '{
    "hostname": "<tailnet-hostname-or-ip>",
    "port": 4096,
    "mode": "connect",
    "password": { "type": "secret_ref", "secretId": "<paperclip-secret-uuid>", "version": "latest" },
    "model": "opencode/<model-id>",
    "sshHost": "<tailnet-hostname-or-ip>",
    "sshPort": 2222,
    "sshUsername": "opc",
    "sshPrivateKey": { "type": "secret_ref", "secretId": "<paperclip-secret-uuid>", "version": "latest" },
    "sshKnownHosts": "<remote known_hosts line>",
    "remoteServerCwd": "/work"
  }'
```

`remoteServerCwd: /work` must match the container `WORKDIR`, which stays stable
across heartbeats so opencode can resume the session. Provider credentials are
the `OPENCODE_API_KEY` env (zen) — set at container runtime, not in agent
config.

**Secrets:** `password` and `sshPrivateKey` reference Paperclip secrets via the
canonical env-binding form `{ "type": "secret_ref", "secretId": "<UUID>",
"version": "latest" }` — `secretId` is the secret's UUID, not its name. (A
plain string there is stored as a literal value; a `{{ secret:name }}`
placeholder is not a supported syntax.) The deploy private key itself stays on
the local host only — never put its contents inline in agent config; store it
as a Paperclip secret and reference it.

## Caveats

- **Restart semantics.** When the remote container is unreachable, the adapter
  won't restart it — that's `Docker`'s job (`restart: always`). The adapter
  healthchecks and surfaces a clear `opencode_server_remote_unreachable`
  diagnostic in `testEnvironment`.
- **HTTP Basic is the only auth over the wire.** Adequate over WireGuard; do
  not expose this server on the public internet without TLS in front.
- **Secrets live in `.env` / the host's filesystem**, never baked into the
  image or committed: `OPENCODE_SERVER_PASSWORD`, `OPENCODE_API_KEY`, and the
  deploy private key are all gitignored.

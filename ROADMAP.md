# Roadmap

> **Living artifact.** Forward plan + implementation guide for `opencode-server-adapter`.
> Navigation entry: [AGENTS.md](./AGENTS.md). Current state + gotchas live there.

## Theme (v0.2.0): anywhere-able `opencode serve`

The agent contract is uniform: **URL + HTTP Basic auth + model ID**. Whether the
endpoint is a local child process, a remote VM, or a container on a tailnet host
is invisible to the agent. v0.2.0 makes that real:

- Each Paperclip agent wires to exactly one `opencode serve` endpoint via its
  own `hostname` / `port` / `password` config.
- Paperclip stops being the only thing that can spawn the server — any keeper
  (local spawn, `docker restart=always`, systemd) is valid. The adapter polls
  `/global/health` and uses the endpoint if healthy; it spawns-and-owns only in
  the optional local-dev mode.
- The remote path is a first-class Docker deployment on a Tailscale tailnet.
  HTTP Basic (`OPENCODE_SERVER_PASSWORD`) is the only auth — adequate over
  WireGuard; do not over-engineer.

## v0.1.0 — Initial Release (shipped)

- [x] Plugin scaffold (ESM, `tsc`, vitest, `@paperclipai/adapter-utils`)
- [x] Server lifecycle management (`lifecycle.ts`)
- [x] `execute()` via REST API
- [x] `testEnvironment()` diagnostics
- [x] `listModels()` and `getQuotaWindows()`
- [x] Config schema (schema-driven UI, no React) + ui-parser
- [x] Session resume codec
- [ ] Integration testing with Paperclip (carried to v0.2.0 as the closing gate)

## v0.2.0 — Remote-Docker / Multi-instance

The everywhere-able adapter. Ordered so each milestone produces shippable state.

### M1 — Make discovery remote-aware (unblocks everything)
- [ ] **`src/index.ts`**: stop hardcoding `listModels` / `getQuotaWindows` to
      `127.0.0.1:4096`. Thread the agent config (or the per-adapter connection
      object) through to both helpers, the same way `execute` /
      `testEnvironment` already use `buildServerConfig`. **This is the single
      most urgent blocker for remote use** — see AGENTS.md gotcha #2.
  - Tests: add `models.test.ts` / `stats.test.ts` cases asserting the
    configured `hostname`/`port`/`password` actually reach the right URL.
- [ ] **`src/server/models.ts` + `stats.ts`**: accept the connection config as
      a typed arg (move them off bare positional `conn` where it's loose);
      reuse a single `serverUrl(config)` + `basicAuthHeaders(config)` pair.

### M2 — Multi-instance: per-config child state
- [x] **`src/server/lifecycle.ts`**: replace module-global `childProcess` /
      `currentPid` with per-`serverUrl` state (a `Map<string, ChildProcess>`
      keyed by `http://host:port`). Concurrent agents → independent children.
      See AGENTS.md gotcha #3.
  - Tests: assert two different configs result in two different children.
- [x] Spawn vs connect semantics: when the config indicates remote (e.g. an
      explicit `mode: "connect"` flag, or auto-detect off `hostname !==
      127.0.0.1 / localhost`), `ensureOpenCodeServerRunning` must **skip spawn**
      and only healthcheck; on unhealthy, return a clear
      "remote server unreachable — cannot restart remotely; restart your
      container host" error, never spawn. Define `mode` in
      `src/ui/config-schema.ts` + `docs/configuration.md`.
  - Tests: connect-mode never calls `child_process.spawn`.

### M3 — Docker deployment story
- [x] Create `deploy/` at repo root (parallel to `docs/`):
  - `deploy/Dockerfile` — `opencode` installed, `opencode serve` entrypoint,
        `OPENCODE_SERVER_PASSWORD` from env, `4096` exposed, non-root user.
  - `deploy/docker-compose.yml` — single service, `restart: always`,
        `.env`-sourced password, port mapping, healthcheck hitting
        `/global/health`.
  - `deploy/.env.example` — `OPENCODE_SERVER_PASSWORD=`, `OPENCODE_HOST=`,
        `OPENCODE_PORT=4096`.
  - `deploy/README.md` — how to build/run, how to put it on a tailnet
        (Tailscale sidecar container vs host-level Tailscale — recommend the
        sidecar pattern for portability), and how to point a Paperclip agent
        at it (the exact `paperclipai agent create --adapter opencode_server
        --adapter-config` command with a remote URL + password).
- [x] `docs/remote-docker.md` — short pointer to `deploy/README.md` + a
      worked example (tailnet hostname, Basic auth via Paperclip secret
      reference — see AGENTS.md gotcha #8), and the restart-supervisor caveat
      (remote unreachable ≠ Paperclip can restart it; design `restart=always`
      or equivalent).

### M4 — Documentation & smoke equality
- [x] **Fix doc drift** in `src/index.ts` `AGENT_CONFIGURATION_DOC`: cheap
      model should read `opencode-go/deepseek-v4-flash`, not `mimo-v2.5`
      (AGENTS.md gotcha #6).
- [x] Add a `pnpm build:ui-parser` script (or move `ui-parser.ts` under `src/`
      and let tsc build it) so `dist/ui-parser.js` is no longer hand-maintained
      (AGENTS.md gotcha #1). Prefer moving under `src/` — simpler; only the
      package `./ui-parser` export path needs updating if we keep the
      repo-root source.
- [ ] Wire a real Paperclip agent to a remote `opencode serve` container on
      the tailnet and run one issue end-to-end. This is the closing v0.1.0
      "Integration testing with Paperclip" item promoted here.

### M5 — Release v0.2.0
- [x] Bump `package.json` to `0.2.0`; update `CHANGELOG.md`.
- [x] Run the full `pnpm typecheck && pnpm test` gate on Node 22.
- [ ] Tag `v0.2.0`; publish to npm (`pnpm publish` — `prepublishOnly` builds).
      **Paused**: awaiting operator verification of the adapter in a running
      Paperclip instance before the irreversible publish. Tag + publish will
      run only after explicit greenlight.

## v0.3.0+ — Polish (deferred from old roadmap)

- [ ] Model refresh endpoint (avoid restart to refresh provider list)
- [ ] Error recovery improvements (retry on transient fetch failures; backoff
      with jitter; classify 5xx vs network)
- [ ] Performance benchmarks vs `opencode_local` (cold-start cost, throughput,
      memory) — publish results

## Future

- [ ] Server metrics/monitoring surface (adapter exposes structured metrics
      from `/session` history beyond quota windows)
- [ ] Contribute to Paperclip upstream as a reference adapter plugin
- [ ] Investigate `opencode web` (web+serve combined) as a deployment target
      — does the same REST API still apply, or does that change the contract?

## Out of scope (deliberate)

- **mTLS / OAuth / dedicated auth provider.** HTTP Basic over Tailscale
  WireGuard is the authenticator. Revisit only if a deployment ever runs this
  outside a tailnet — not in scope for v0.2.0.
- **Built-in process supervisor inside the adapter.** The remote host owns
  restart semantics (`docker restart=always`, systemd, etc.). The adapter
  healthchecks; it does not remotely spawn or restart.
- **Adapter-implemented skills discovery** (`listSkills`/`syncSkills`), model
  detection, or session management beyond the resume codec — all upstream
  contract areas deliberately left unimplemented (AGENTS.md "Adapter ↔
  Paperclip contract surface").

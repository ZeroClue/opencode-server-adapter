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

## v0.2.0 — Remote-Docker / Multi-instance / Warm-serve sync

The everywhere-able adapter. Ordered so each milestone produces shippable state.

### M1 — Warm-server workspace sync over SSH (shipped ahead of plan)
The persistent-serve contract needs the local workspace materialized into the
remote serve's STABLE cwd each run and pulled back after, so opencode can
resume the session across heartbeats instead of cold-re-reading the repo.

- [x] **`src/server/remote-sync.ts`** (new): `RemoteSyncConfig`,
      `readRemoteSyncConfig`, `sshEnabled` (requires sshHost + sshUsername +
      sshPrivateKey + remoteServerCwd), `buildSshSpec`, `buildRemoteSync`
      → `{ enabled, spec, remoteDir, prepare(), restore() }`. Uses
      `prepareWorkspaceForSshExecution` / `restoreWorkspaceFromSshExecution`
      from `@paperclipai/adapter-utils/ssh` into a STABLE remote dir (NOT the
      throwaway `.paperclip-runtime/runs/<runId>` staging that
      `prepareRemoteManagedRuntime` uses, which would break warm-session
      identity).
- [x] **`src/server/execute.ts`**: `prepare()` before POST /session/message,
      `restore()` in `finally` (even on error) so the local workspace never
      goes stale; `activeCwd` = remote cwd when ssh enabled.
- [x] **`src/ui/config-schema.ts`** + **`docs/configuration.md`**: SSH fields
      (`sshHost`, `sshPort`=2222, `sshUsername`, `sshPrivateKey`,
      `sshKnownHosts`, `strictHostKeyChecking` toggle, `remoteServerCwd`).
- [x] Tests: `src/server/__tests__/remote-sync.test.ts` (7 tests).

### M1b — Skills materialization (shipped ahead of plan)
Warm servers can't take a per-run `--skills` CLI flag, so desired Paperclip
skills must be materialized onto the remote host's discovery paths
(`~/.claude/skills/*`, `~/.config/opencode/skills/*`) during prepare.

- [x] **`src/server/skills.ts`** (new): `listSkills` / `syncSkills`
      entrypoints (`listOpenCodeServerSkills` / `syncOpenCodeServerSkills`)
      via `buildPersistentSkillSnapshot`; `pushSkillsToRemote` syncs each
      desired skill dir over SSH to every relative discovery path during
      execute prepare.
- [x] **`src/index.ts`**: wire `listSkills` / `syncSkills` into the
      `ServerAdapterModule`.
- [x] Tests: `src/server/__tests__/skills.test.ts` (6 tests).

### M1c — Instructions bundle + safe session resume (shipped ahead of plan)
Warm-serve correctness: the agent's instructions bundle must reach the model
without being re-burned on every heartbeat, and a session saved for a
different workspace must never be resumed.

- [x] **`src/server/execute.ts`**: read the resolved `instructionsFilePath`
      (absolute, or relative to the execution cwd) and inject it into the
      prompt on a FRESH session only; on a resumed session log that it is
      skipped to avoid wasting tokens (mirrors `opencode-local`).
- [x] **`src/server/execute.ts`**: guard session resume — resume only when the
      stored `cwd` matches the active execution cwd
      (`canResumeSession`); otherwise log and start fresh.
- [x] Tests: instructions injected on fresh-only, cwd-mismatch not resumed,
      cwd-match resumed (in `execute.test.ts`).

### M1 — Make discovery remote-aware (unblocks everything)
- [x] **`src/index.ts`**: stop hardcoding `listModels` / `getQuotaWindows` to
      `127.0.0.1:4096`. Thread the agent config (or the per-adapter connection
      object) through to both helpers, the same way `execute` /
      `testEnvironment` already use `buildServerConfig`. **This is the single
      most urgent blocker for remote use** — see AGENTS.md gotcha #2.
      Shipped in v0.2.10: the hooks now build their `ServerConnection` from the
      host-provided per-agent discovery context (`ctx?.config`) when present,
      falling back to the factory discovery config then `DEFAULT_CONN`.
  - Tests: `src/__tests__/index.test.ts` asserts the per-agent
    `hostname`/`port`/`password` reach the right URL (and the default fallback
    when no ctx) for both `listModels` and `getQuotaWindows`.
- [x] **`src/server/models.ts` + `stats.ts`**: accept the connection config as
      a typed arg (move them off bare positional `conn` where it's loose);
      reuse a single `serverUrl(config)` + `basicAuthHeaders(config)` pair.
      Both already take a typed `ServerConnection` and reuse the shared
      `serverUrl` / `basicAuthHeaders` pair from `conn.ts`.

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
- [ ] Memory persistence over the active warm server session (à la the
      `syncSkills` pattern, on the warm serve's disk) — the remaining
      deliberately-unimplemented contract surface

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
- **Adapter-implemented model detection, memory persistence, or session
  management beyond the resume codec** — the remaining upstream contract areas
  deliberately left unimplemented. Skills discovery (`listSkills`/`syncSkills`)
  was shipped in v0.2.0 M1b (AGENTS.md "Adapter ↔ Paperclip contract
  surface").

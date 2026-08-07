# Changelog

## 0.2.10 (2026-08-07)

### Fixed
- **`listModels` / `getQuotaWindows` hit hardcoded `127.0.0.1:4096`**, ignoring a remote agent's configured `hostname`/`port`/`password`. Each paperclip agent is wired to its own `opencode serve` endpoint; the host already passes the agent's resolved adapter config into the discovery hooks via the per-agent discovery context. The hooks now build their `ServerConnection` from that context (`ctx?.config`) when present, falling back to the factory discovery config and then `DEFAULT_CONN`. This is the critical fix for remote/multi-instance: quota and model discovery now target the agent's actual endpoint instead of silently polling localhost.
- Added `src/__tests__/index.test.ts` covering per-agent ctx override + default fallback for both hooks. Published `@paperclipai/adapter-utils@^2026.529.0` predates the `ctx` parameter, so the adapter types it structurally (`DiscoveryContextInput`) rather than importing the unavailable type.

## 0.2.9 (2026-08-07)

### Fixed
- **`onMeta` passed an empty `env: {}`.** The adapter-invocation run event hid
  every environment variable that reached the warm server (GH_TOKEN, API keys,
  etc.), making run diagnostics blind to env. The resolved agent env is now
  forwarded; the server redacts secret_ref-derived keys before persisting the
  event, so it is diagnostic-safe.

### Investigated (deliberately not wired)
- `steps` and `cheapModel` are documented/forward-compat fields, not per-run
  runtime controls. opencode enforces `steps` only in the serve's per-agent
  config, and cheap-model selection is driven by the server-side model-profile
  controller — neither is addressable via the `/message` REST call. Wiring them
  would mean writing/injecting the serve's `opencode.json` mid-run (fragile,
  merge/schema/reload risk) or overriding the server's profile mechanism
  (wrong layer). Left as documented forwarding only.

## 0.2.8 (2026-08-07)

Parser parity fix: restore exit-code / status / metadata feedback for tool
results that the built-in `opencode_local` parser surfaces but this adapter
silently dropped.

### Fixed

- **Tool results lost status + exit-code metadata.** The board renders tool
  results by scanning a `status:` / `exit_code:` / metadata header block that
  the built-in `opencode_local` parser prepends to each `tool_result`. Our
  parser was emitting only the raw output and discarding `state.metadata`, so
  exit codes, error details, and run feedback never appeared in the run detail.
  Now `tool_result.content` carries a `<status>: <metadata>` header block before
  the output, matching the upstream contract.
- Added `part.id` as a fallback for the tool use id (was only `part.callID`),
  matching the built-in parser.

### Tests
- 3 new ui-parser tests: metadata header on completed tools, `part.id` fallback,
  and no spurious `tool_result` for in-progress tools.

### Docs
- Corrected `AGENTS.md` gotchas #1 (parser is now built under `src/` — no manual
  `dist/ui-parser.js` step) and #6 (no `mimo-v2.5` reference remains; model docs
  are aligned).

## 0.2.7 (2026-08-07)

Config-schema/UI alignment pass. Exposes capabilities the adapter already had
but the agent-config form did not let operators configure, and documents two
dead fields so nobody mistakes them for working.

### Added

- `timeoutSec` schema field (number, default 300) — already consumed by
  `execute` as the run's wall-clock timeout, but was not editable in the UI.
- `promptTemplate` schema field (textarea) — appended to the run prompt as a
  stable suffix; was consumed by `execute` but invisible in the form.
- New `src/ui/__tests__/config-schema.test.ts` locking the declared field set
  (no duplicates, all expected keys, numeric defaults, mode options) so a dead
  or missing field can't silently regress.
- `meta:{secret:true}` added to the `password` field (parity with the SSH key).

### Documented

- `steps` and `cheapModel` are declared in the schema but **not yet enforced by
  the runtime** (`config.steps` / `config.cheapModel` are never read). Flagged
  in `docs/configuration.md` and `AGENTS.md` so users aren't misled.
- Clarified that secret masking for `text` fields is not enforced by the board's
  generic `SchemaConfigFields` renderer (it ignores `meta.secret`) — that masking
  is a board-side change, out of scope here.

## 0.2.6 (2026-08-07)

Adapter correctness pass surfaced by a gap analysis of capabilities, the config
UI, and board UI feedback for adapter-backed runs. Fixes four correctness bugs
in result reporting and environment testing; no behavior change to session
resume, remote sync, or git auth.

### Added

- `isTimeoutError` helper distinguishing `AbortSignal.timeout` rejections
  (`TimeoutError`) from manual aborts (`AbortError`), used by `execute` and the
  outer catch.

### Fixed

- **Timeout misdetection (highest impact).** `AbortSignal.timeout()` rejects
  with a DOMException named `TimeoutError`, but the message-POST and outer
  catches only tested `name === "AbortError"`. Real run timeouts were reported
  as generic failures (`exitCode: 1`, `timedOut: false`) instead of
  `exitCode: -1` / `timedOut: true`. Both call sites now use `isTimeoutError`.
- **usage/cost double-counting on the POST path.** opencode's message-level
  `tokens` is already the sum across every part (including each `step-finish`),
  but the adapter added `step-finish` tokens and cost on top, reporting roughly
  2x the true usage. Now the message-level aggregate is authoritative and
  `step-finish` parts are only summed as a fallback when the message-level
  figures are absent or zero.
- **Quota token fields never populated.** `getQuotaWindows` read
  `tokens_input` / `tokens_output` / `tokens_cache_read` which do not exist on
  opencode sessions (real shape is `tokens.input` / `tokens.output` /
  `tokens.cache.read`), so the board always showed 0 tokens / 0 cache reads.
- **`testEnvironment` ignored HTTP Basic auth.** All probe calls
  (`/global/health`, `/provider`, session create, message probe, cleanup) now
  send `basicAuthHeaders` using the configured password, so environment tests
  against password-protected servers no longer get 401s.

Authenticate the remote agent's git operations against github.com over HTTPS so
the mirrored `origin` (added in 0.2.4) is actually usable for fetch/rebuild
instead of failing with `could not read Username` and burning tokens hunting
for credentials.

### Added

- **Agent env forwarding.** The adapter now forwards the agent's resolved
  `ctx.config.env` (which Paperclip's core expands from `secret_ref` bindings
  into plaintext values) into the `shell.env` plugin's per-run env file. This
  surfaces `GH_TOKEN` (and any other bound env vars) to the warm-server agent's
  bash tools.
- **Remote `GIT_ASKPASS` helper.** After workspace sync, installs a
  `~/.git-askpass` script on the container that answers git's password prompt
  with the injected `GH_TOKEN`, sets `core.askPass`, the `x-access-token`
  github.com username, and clears ambient helpers. Plain
  `git fetch origin` / `git push` now authenticate automatically — no manual
  token entry, no `gh` CLI.

### Fixed

- `git fetch origin` on the synced workspace previously failed with
  `fatal: could not read Username for 'https://github.com'` and the agent
  burned ~8 tool calls investigating missing credentials before working around
  it. GH_TOKEN was bound in the agent's config but never shipped into the
  container.

## 0.2.4 (2026-08-06)

Complete the git provenance of the SSH-synced workspace so a remote agent's
"fetch / rebase / check remote" instructions resolve instead of failing on a
bundle-imported repo that has no remotes.

### Added

- **Origin remote mirroring.** After the workspace is synced, the local repo's
  `origin` URL (credential-stripped — the host's token is never shipped into
  the container) is added as `origin` on the remote copy. The agent's
  "git fetch origin && git rebase origin/main" instructions now have a remote
  to resolve, instead of failing with `No such remote 'origin'` and burning
  tokens re-discovering the git layout on every run.
- **`.paperclip-runtime/` gitignore.** Appends the sync staging dir to the
  remote `.git/info/exclude` so it stops showing up as untracked in every
  `git status` the agent runs.
- Non-fatal: git configuration failures log a warning and never fail the run.

### Fixed

- Remote-workspace git provenance was incomplete (`LocalGitWorkspaceSnapshot`
  only carried `headCommit`/`branchName`/`deletedPaths`, never the remote URL),
  so synced copies had no `origin` and every git-remote instruction failed.

## 0.2.3 (2026-08-06)

Mirror the agent's runtime footprint into the remote serve container so a warm
`opencode serve` agent can resolve `$AGENT_HOME/rules/*`, reach the Paperclip
board API, and stop burning tokens hunting for host-local paths.

### Added

- **Agent-home mirroring (`src/server/agent-home.ts`).** Syncs the agent's
  instructions bundle (`AGENTS.md`, `TOOLS.md`, `rules/*.md`) into the
  container at `agentHomeRemoteDir` (default `/home/opc/agent-home`) ahead of
  each run. `AGENT_HOME` then resolves `$AGENT_HOME/rules/...`, so rules the
  instruction bundle references are actually reachable. Source dir is derived
  from the injected `instructionsFilePath` (the bundle's parent) or overridden
  via `agentHomeDir`.
- **`shell.env` plugin injection.** Deploys `paperclip-env.js` into the
  container's `~/.config/opencode/plugins/` (auto-discovered by opencode). The
  plugin reads a per-run env file and injects it into every `bash` tool
  execution: `AGENT_HOME`, `PAPERCLIP_API_URL`, `PAPERCLIP_RUN_ID`,
  `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, and the run-scoped
  `PAPERCLIP_API_KEY` (the adapter's `authToken`). The agent can now post
  completion comments / update issue status via the Paperclip API.
- **Host workspace-path rewrite in injected instructions.** `readInstructionsPrefix`
  rewrites literal Paperclip host paths (`~/.paperclip/instances/...`,
  `/home/.../.paperclip/instances/...`) baked into `AGENTS.md` to the remote
  cwd (e.g. `/work`) and appends a "you are on a remote server" note. Prevents
  the agent from trying to `cd` into a nonexistent local path every run.
- **New config fields:** `agentHomeDir`, `agentHomeRemoteDir`,
  `deployAgentHomePlugin`, `paperclipApiUrl` (defaulted from Paperclip runtime
  env, matching `buildPaperclipEnv`).

### Fixed

- Long-lived `opencode serve` agents previously had no `PAPERCLIP_*` env and
  no reachable `$AGENT_HOME`, so they burned tokens hunting for rule files and
  could never complete board work. Both are now injected per run.

### Tests

- New execute case asserting host workspace paths are rewritten to the remote
  cwd in the injected prompt. Suite now 63 tests across 9 files.

## 0.2.0 (2026-08-04)

First public release. Ships the initial adapter (formerly tracked as 0.1.0)
plus the v0.2.0 work making `opencode serve` anywhere-able: discovery is
remote-aware, child-process state is per-config, spawn-vs-connect is explicit,
and a Docker deployment story is included.

### Added

- **Discovery is remote-aware (M1).** `createServerAdapter(discoveryConfig?)`
  accepts an optional connection config and closes `listModels` /
  `getQuotaWindows` over the coerced `{hostname, port, password?}` connection.
  Removed the dead-hardcoded `127.0.0.1:4096` literal at the call site;
  per-process default retained when no config is supplied (preserves live
  Paperclip behavior since `plugin-loader.ts` calls the factory with no args).
- **HTTP Basic auth on `listModels` (M1).** `models.ts` previously sent no
  `Authorization` header, so any remote `opencode serve` with
  `OPENCODE_SERVER_PASSWORD` set would silently 401 and the adapter reported
  `0 models`. Now uses the shared `basicAuthHeaders(conn)` helper.
- **Shared connection helpers (M1).** New `src/server/conn.ts` exports
  `ServerConnection`, `DEFAULT_CONN`, `serverUrl(conn)`, `basicAuthHeaders(conn)`,
  and `coerceConn(input, fallback)`. `models.ts`, `stats.ts`, and `lifecycle.ts`
  reuse a single `serverUrl` / Basic-auth pair instead of re-implementing it.
- **Per-config child state (M2).** `lifecycle.ts` replaces module-global
  `childProcess` / `currentPid` with `Map<string, ChildProcess>` +
  `Map<string, number>` keyed by `serverUrl(config)`. Concurrent agents with
  different endpoints now get independent children (AGENTS.md gotcha #3).
- **Spawn vs connect mode (M2).** New `mode` config field (`"spawn"` |
  `"connect"`, default `"spawn"`). `ensureOpenCodeServerRunning` skips spawn
  entirely in connect mode and only healthchecks; on unhealthy it throws a
  clear, URL-interpolated `REMOTE_UNREACHABLE_ERROR` ("cannot restart remotely;
  restart your container host or tailnet VM") rather than silently spawning a
  doomed local process. Auto-promotes to connect mode when `mode` is unset and
  `hostname` is non-loopback. Operators can override.
- **Docker deployment story (M3).** New `deploy/` directory: `Dockerfile`
  (Debian slim + static `opencode` binary, non-root user, `opencode serve
  --hostname 0.0.0.0 --port 4096` entrypoint, `OPENCODE_SERVER_PASSWORD` from
  runtime env), `docker-compose.yml` (`restart: always`, `.env`-sourced
  password, `/global/health` healthcheck), `.env.example`, and `README.md`
  with the Tailscale sidecar pattern + the `paperclipai agent create` command
  using `mode: "connect"` with a Paperclip secret reference for the password.
- **Remote Docker walkthrough (M3).** `docs/remote-docker.md` — short pointer
  to `deploy/README.md` plus a worked example and an amplified restart-supervisor
  caveat covering Docker, systemd, and Kubernetes.

### Changed

- **`AGENT_CONFIGURATION_DOC` fixed (M4).** Cheap-model name corrected from
  `mimo-v2.5` to `opencode-go/deepseek-v4-flash` (AGENTS.md gotcha #6). Doc
  core-fields list now includes `mode`; the Notes section distinguishes
  spawn-mode (auto-start child) from connect-mode (remote host owns restart).
- **`ui-parser.ts` now built automatically (M4).** Moved from repo root to
  `src/ui-parser.ts` so `pnpm build` (a single `tsc` invocation with
  `rootDir: src`) produces `dist/ui-parser.js` alongside everything else
  (AGENTS.md gotcha #1 — the previous hand-maintained build step is gone).
  The `package.json` `./ui-parser` export path is unchanged.
- `docs/configuration.md` — added the `mode` field reference + updated the
  example JSON.
- `src/server/test.ts` `testEnvironment` classifies the connect-mode
  unreachable case into a dedicated `opencode_server_remote_unreachable`
  check with a connect-appropriate hint (don't tell the operator to install
  opencode locally — tell them to restart their container host).

### Tests

- New `src/server/__tests__/lifecycle.test.ts` covering per-config child
  isolation and spawn-vs-connect mode resolution (8 cases).
- Added `models.test.ts` / `stats.test.ts` cases asserting non-localhost
  `hostname`/`port`/`password` reach the right URL with the right
  `Authorization` header.
- Suite: 36 tests across 6 files (was 12 across 5 at v0.1.0 baseline).

## 0.1.0 (unreleased — internal scaffold)

- Initial scaffold (ESM, TypeScript, vitest, `@paperclipai/adapter-utils`)
- Server lifecycle management (`lifecycle.ts`)
- `execute()` with session creation and message sending via REST API
- `testEnvironment()` diagnostics (health, providers, hello probe)
- `listModels()` via `/provider` endpoint
- `getQuotaWindows()` via session history
- Session codec for resume support
- Config schema with declarative UI fields
- UI parser for stdout transcript rendering
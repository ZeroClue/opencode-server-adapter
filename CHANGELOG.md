# Changelog

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
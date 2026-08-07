# AGENTS.md — opencode-server-adapter

> **You are here.** This is the navigation entry point for working in this repo.
> Forward work lives in [ROADMAP.md](./ROADMAP.md) — this file stays stable.

## What this repo is

First-party Paperclip adapter plugin (`@zeroclue/opencode-server-adapter`, v0.1.0) that connects Paperclip to a persistent [`opencode serve`](https://opencode.ai/docs/server/) instance over its REST API — replacing the per-heartbeat subprocess model of the legacy `opencode_local` adapter with a warm-server architecture.

**The contract:** each Paperclip agent is wired to exactly one `opencode serve` endpoint. The endpoint is just a URL + HTTP Basic auth + a model ID. Whether that endpoint is a local child process, a remote VM, or a container on a tailnet host is invisible to the agent — it's all the same `hostname`/`port`/`password` config.

This is a **first-party** adapter (authored by ZeroClue, the same entity that runs the Paperclip instance). The upstream contract we must stay compatible with is the `ServerAdapterModule` interface from `@paperclipai/adapter-utils` (v2026.529.0). When the Paperclip server's adapter-utils bumps, revalidate against the new API.

## How it fits into the Paperclip instance

- Registered as a local adapter plugin in `~/.paperclip/adapter-plugins.json` (installed 2026-06-03).
- Source-of-truth checkout: `~/projects/opencode-server-adapter` (this repo).
- **Current status:** installed and built; **not yet wired into any agent's adapter config**. The road to first real agent usage goes through [ROADMAP.md](./ROADMAP.md) v0.2.0 (remote/Docker/multi-instance).

## Architecture (deep dive)

See [docs/architecture.md](./docs/architecture.md) for design decisions and the data-flow diagram. **Read it before changing `src/server/*`.** This section is a stable pointer; do not duplicate the architecture content here.

The one-line mental model:

```
Paperclip heartbeat
    → adapter.execute(ctx)
    → ensureOpenCodeServerRunning(config)  [healthcheck / spawn-or-connect]
    → POST /session  (or resume by sessionId)
    → POST /session/:id/message
    → parse JSON → AdapterExecutionResult
```

## File map

| Path | Responsibility |
|------|----------------|
| `src/index.ts` | `createServerAdapter()` factory → returns the `ServerAdapterModule` Paperclip loads. Wires capability flags, `agentConfigurationDoc`, default model profile. |
| `src/server/lifecycle.ts` | Spawn / healthcheck / SIGTERM the `opencode serve` child. ⚠️ Currently **module-global state** — one child per adapter process. Roadmap fixes this. |
| `src/server/execute.ts` | Core `execute(ctx)` REST orchestration: create-or-resume session → send message → aggregate tokens/cost. |
| `src/server/codec.ts` | `sessionCodec` enabling session resume across heartbeats (key aliases `sessionId`/`session_id`/`sessionID`, cwd fallbacks). |
| `src/server/models.ts` | `listModels` via `GET /provider` — one model per connected provider (the default). Fail-open: `[]` on error. |
| `src/server/stats.ts` | `getQuotaWindows` via `GET /session` history. Fail-open: `{ok:false}` on error. |
| `src/server/test.ts` | `testEnvironment` diagnostics. ⚠️ **Has real side effects** — sends a probe message incurring real model cost every run. |
| `src/ui/config-schema.ts` | Declarative config form (8 fields). No React — Paperclip renders generically. |
| `src/ui/index.ts` | UI barrel. |
| `ui-parser.ts` (repo **root**, not `src/`) | `parseStdoutLine` → converts `opencode serve` NDJSON stdout into `TranscriptEntry[]`. Wired via the `./ui-parser` package export + `paperclip.adapterUiParser: "1.0"` metadata. |
| `docs/architecture.md` | Design decisions + data-flow diagram. |
| `docs/configuration.md` | Field-by-field config reference. |
| `ROADMAP.md` | Forward plan — recentered on v0.2.0 remote/Docker/multi-instance. |
| `CONTRIBUTING.md` | PR process, TDD, style. |

## Build / test commands

```bash
pnpm install                      # lockfile frozen in CI: pnpm install --frozen-lockfile || pnpm install
pnpm typecheck                    # tsc --noEmit   ← CI gate
pnpm test                         # vitest run     ← CI gate
pnpm test:watch                   # interactive
pnpm build                        # tsc → dist/
pnpm clean                        # rm -rf dist
```

- **Node 22** (CI matrix). `AbortSignal.timeout` and `DOMException` timeouts require Node ≥18.17; older local Node breaks silently.
- **pnpm@10.33.0** pinned via `packageManager`. Use `corepack enable` if pnpm isn't on PATH.

## Conventions

- **ESM-only** with `.js` extensions in relative imports (required for Node ESM resolution). Don't write `import { x } from "./foo"` — it must be `./foo.js`.
- **TypeScript strict**; `esModuleInterop`, `skipLibCheck`, `isolatedModules`, `forceConsistentCasingInFileNames` all on. See `tsconfig.json`.
- **Config coercion:** use `asString` / `asNumber` / `parseObject` from `@paperclipai/adapter-utils/server-utils` rather than manual `typeof` checks. See `src/server/execute.ts:buildServerConfig` for the pattern.
- **Fail-open pattern:** `listModels`, `getQuotaWindows`, `healthcheck` swallow errors and return `[]` / `false` / `{ok:false}` — never throw. Assert this in tests.
- **Style:** 2-space indent, LF, UTF-8, trim trailing whitespace, final newline (`.editorconfig` enforces). No lint/format tooling configured — `.editorconfig` is the only style enforcement; "follow existing style" is the rule.
- **Testing:** vitest, `globals: true`. Module deps via `vi.mock`, network via `vi.spyOn(globalThis, "fetch")`. `beforeEach(() => vi.restoreAllMocks)` per file. See `src/server/__tests__/execute.test.ts` for the canonical pattern.
- **PR flow:** issue-first, fork, feature branch, **TDD**, `pnpm typecheck && pnpm test` must pass. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Gotchas (prioritized by severity)

1. **Keep `ui-parser.ts` output parity with the built-in `opencode_local` parser.** The parser now lives at `src/ui-parser.ts` under `tsconfig.include`, so `pnpm build` compiles it and the `./ui-parser` export ships it — no manual `dist/ui-parser.js` step needed (this trap was fixed when the file moved under `src/`). But the board renders tool results by reading the `status: / exit_code: / metadata` header lines that `opencode_local` prepends to tool results; if you change the parser, keep that header contract or exit codes and run feedback silently disappear from the UI.

2. **`listModels` / `getQuotaWindows` discovery must honor the per-agent config.** Fixed in v0.2.10: the discovery hooks now build their `ServerConnection` from the host-provided discovery context (`ctx?.config` — the agent's resolved `hostname`/`port`/`password`) when present, falling back to the factory discovery config then `DEFAULT_CONN`. Keep this precedence. Note the published `@paperclipai/adapter-utils@^2026.529.0` predates the `ctx` parameter, so the adapter types it structurally (`DiscoveryContextInput` in `src/index.ts`) and the pinned typings don't typecheck a one-arg call — the tests in `src/__tests__/index.test.ts` are the source of truth. (Historically the hooks were hardcoded to `127.0.0.1:4096`, ignoring a remote agent's configured endpoint — the single most urgent blocker for remote use.)

3. **`lifecycle.ts` holds module-global `childProcess` / `currentPid` state.** Only one `opencode serve` child per adapter process; concurrent agents in the same Paperclip server process clobber each other's pointer. ROADMAP v0.2.0 (multi-instance) fixes this.

4. **`testEnvironment` incurs real model cost** — it creates a live session and sends "Respond with hello." against the configured provider on every run. Don't invoke it casually in CI or during exploration.

5. **`execute` only sends the model to the server when the `model` string contains `/`.** A bare model name silently falls back to the server default (no error). Always use `provider/model` format in agent config.

6. **Dead fields `steps` and `cheapModel`** (see #9 below) are the only known config-doc drift; the `AGENT_CONFIGURATION_DOC`, `docs/configuration.md`, and `config-schema.ts` all agree on `opencode-go/deepseek-v4-flash` for both model and cheapModel. (Historical note: a `mimo-v2.5` reference in `AGENT_CONFIGURATION_DOC` was already aligned.)

7. **`dist/` is in `.gitignore` but committed in the working tree.** Check `git status` before committing — don't accidentally commit regenerated dist unless intended. The `files` array in `package.json` ships `dist`, `src`, and `ui-parser.ts` to npm.

8. **Secret masking is not enforced by the board renderer.** `password` and `sshPrivateKey` are `text` fields marked `meta:{secret:true}`, but the generic `SchemaConfigFields` component renders them as plain `DraftInput` inputs — it ignores `meta.secret`. `password` is set as `OPENCODE_SERVER_PASSWORD` env on spawn (`lifecycle.ts`) and used as HTTP Basic (`stats.ts`), and the SSH key is used for workspace sync. For remote use, source them from Paperclip secret references — don't commit them in plaintext agent config. (Masking secrets in the form is a **board** change in `paperclip/ui/src/adapters/schema-config-fields.tsx`.)

9. **Dead fields `steps` and `cheapModel`** are declared in `config-schema.ts` and `AGENT_CONFIGURATION_DOC` but no runtime code reads `config.steps` / `config.cheapModel`. They exist for forward compatibility. If you build step-limit or cheap-model support, wire the actual consumption in `execute.ts` at the same time, and remove the "not yet enforced" note from `docs/configuration.md`.

## Adapter ↔ Paperclip contract surface

Implemented hooks: `type`, `execute`, `testEnvironment`, `sessionCodec`, `listModels`, `getQuotaWindows`, `getConfigSchema`, `modelProfiles`, `supportsLocalAgentJwt`, `supportsInstructionsBundle`, `instructionsPathKey`, `requiresMaterializedRuntimeSkills`, `agentConfigurationDoc`.

**Not implemented** (deliberately): `refreshModels`, `detectModel`,
`sessionManagement`, `onHireApproved`. (`listSkills` / `syncSkills` were added
in v0.2.0 — see ROADMAP M1b.) If you need one of these, check the upstream
`adapter-utils` typings first — don't invent a new contract.

## Forward work

See [ROADMAP.md](./ROADMAP.md) for the forward plan — recentered on **v0.2.0: remote-Docker / multi-instance**, the unifying theme that makes "anywhere-able `opencode serve`" real. The roadmap doubles as the implementation plan to start work against from this folder.

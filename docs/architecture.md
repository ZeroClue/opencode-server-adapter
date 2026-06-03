# Architecture

## Overview

The `opencode-server-adapter` is an external Paperclip plugin that implements the `ServerAdapterModule` interface. Instead of spawning `opencode run` as a subprocess per heartbeat, it communicates with a persistent `opencode serve` instance via HTTP REST API.

## Key Design Decisions

### Child Process Lifecycle
Paperclip spawns `opencode serve` as a child process. This gives us:
- Clean lifecycle binding (Paperclip shutdown → child shutdown)
- No tmux or external process manager dependency
- Automatic restart on crash via healthcheck polling

### Schema-Driven UI
No React components. The adapter uses `getConfigSchema()` to declare its config form fields, which Paperclip's UI renders generically. This means we don't need to ship React components or maintain UI build tooling.

### Session Resume
OpenCode's `POST /session/:id/message` API automatically continues an existing session when you POST to an existing session ID. The KV cache from the provider persists. No special resume logic needed beyond storing the session ID.

### Model Discovery
`GET /provider` returns all connected providers with their default models. The adapter builds a model list from this data. No CLI subprocess needed.

## Data Flow

```
Agent heartbeat triggered
    │
    ▼
adapter.execute(ctx)
    │
    ├─ ensureRunning()
    │   ├─ GET /global/health → 200? return
    │   └─ spawn opencode serve → poll health → return
    │
    ├─ Resume existing session?
    │   ├─ Yes: use stored sessionId
    │   └─ No: POST /session → get new sessionId
    │
    ├─ POST /session/:id/message
    │   ├─ model, parts (text), agent
    │   └─ Response: cost, tokens, parts[]
    │
    ├─ Parse response
    │   ├─ Aggregate step-level tokens/cost
    │   ├─ Extract summary from text parts
    │   └─ Return AdapterExecutionResult
    │
    └─ Error? Return error result with clear message
```
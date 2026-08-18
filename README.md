# TianShu (天枢) — DSH Failure Root-Cause Analyzer

> **天枢** (TianShu, "Celestial Pivot") — the pivot star of the Big Dipper, used to locate the
> North Star. This plugin locates the **root cause** of a failed [DeepSeek Harness][dsh] agent
> session and produces a shareable diagnostic report.

[![Version](https://img.shields.io/badge/version-0.2.0-blue)](./package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-purple)](https://github.com/deepseek-ai/deepseek-harness)

TianShu combines a **zero-cost rule engine** (10 failure modes, no LLM calls) with an optional
**LLM deep-diagnosis layer** that reuses the session's own model route — no extra API key required.

---

## Features

- **Rule engine (10 failure modes)** — tool-error loops, identical-call dead loops, max-tokens
  truncation, sandbox denials, approval blocks, LLM errors/aborts, prompt-injection signals,
  token burn, no-progress stalls.
- **LLM deep diagnosis** — asks the session's own model "why did this fail?" with the rule
  findings as structured context. Reuses the route from `assistant/message` provenance.
- **Agent tool** — `diagnose_session` lets the agent self-diagnose a failed task and retry smarter.
- **Auto-trigger** — subscribes to `turn/end` and runs analysis automatically on `error` /
  `blocked` / `interrupted` / `aborted` outcomes.
- **Markdown reports** — persisted to `~/.dsh/tianshu-reports/`, ready to paste into a GitHub Issue.
- **Web UI panel** — injects a "⚕︎ Diagnose" button into the session header; opens a panel
  showing findings, tool-call heat map, fork points, and the LLM diagnosis.

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 20
- [pnpm](https://pnpm.io/) ≥ 9
- [DeepSeek Harness][dsh] (the `dsh` CLI, or a local clone of the harness repo)

### 1. Install

```sh
git clone <this-repo-url> tianshu-analyzer
cd tianshu-analyzer
pnpm install
pnpm build          # produces lib/ (host ESM + browser CJS bundle)
```

### 2. Load into DSH

TianShu ships with a Cordis patch overlay that inserts it into an active DSH profile:

```sh
dsh web --patch ./cordis.patch.yml
```

That's it — open http://127.0.0.1:3080, pick any session, and click the **⚕︎ Diagnose**
button in the session header.

### 3. (Optional) Tune thresholds

Edit [cordis.patch.yml](./cordis.patch.yml) — every config key is documented inline. See the
[Configuration](#configuration) table below for the full reference.

---

## Usage

TianShu can be triggered in **four** ways. They all share the same engine and produce the same
`DiagnosisReport`.

### A. Web UI panel (interactive)

1. Open DSH Web (`dsh web`).
2. Open any session.
3. Click **⚕︎ Diagnose** in the session header utilities slot.
4. The panel opens. Toggle **"LLM deep diagnosis"** if you want the LLM layer, then click **Analyze**.
5. Findings, heat map, fork points, and the Markdown report render inline.

### B. Auto-trigger (hands-off)

Enabled by default. Whenever a `turn/end` event arrives with reason `error` / `blocked` /
`interrupted` / `aborted`, TianShu runs the analysis in the background and:

- Writes a Markdown report to `~/.dsh/tianshu-reports/<sessionId>-<timestamp>.md`
- Caches the report in memory (the Web UI reads it via the `/tianshu` RPC channel)
- Emits a `tianshu/report` event other plugins can subscribe to

To disable auto-trigger, set `autoTrigger: false` in [cordis.patch.yml](./cordis.patch.yml).

### C. Agent tool (self-diagnosis)

The agent itself can call the `diagnose_session` tool:

```text
diagnose_session(sessionId: "<session-id>", useLlm?: boolean)
```

Returns a structured summary the agent can use to retry smarter (e.g., avoid the tool it was
looping on, or request a model route change). The agent does **not** need an LLM call to use this
— the rule engine runs synchronously and is free.

### D. Programmatic (host-side)

Other DSH host plugins can read the in-process service directly:

```ts
// In any host plugin that declares `inject: ['tianshu']`
const report = await ctx.tianshu.analyze(sessionId, { useLlm: true })
const cached  = await ctx.tianshu.getReport(sessionId)
const all     = await ctx.tianshu.listReports()
const markdown = await ctx.tianshu.readMarkdown(sessionId)
```

> **Note:** `ctx.tianshu` is **host-process only**. Browser client code must call the host via
> the generic Connection RPC channel — see [Architecture](#architecture) below.

---

## Configuration

All config lives in [cordis.patch.yml](./cordis.patch.yml). A patch replaces the targeted row's
whole `config`, so every key below is authoritative when the patch is active.

| Key | Default | Description |
|---|---|---|
| `autoTrigger` | `true` | Auto-run analysis on failed `turn/end` events |
| `autoTriggerReasons` | `[error, blocked, interrupted, aborted]` | Which `turn/end` reasons trigger |
| `llmDiagnose` | `true` | Enable LLM deep diagnosis (needs `ctx.llm`) |
| `llmMaxTokens` | `2048` | Output cap for the diagnostic LLM call |
| `llmTimeoutMs` | `30000` | Per-call deadline (ms) |
| `provider` | *(unset)* | Override the model provider; omit to reuse the session's |
| `model` | *(unset)* | Override the model id; omit to reuse the session's |
| `reportDir` | `~/.dsh/tianshu-reports` | Where Markdown reports are saved |
| `keepReports` | `50` | Max report files retained (oldest pruned) |
| `rules.<id>.enabled` | `true` | Toggle individual rules |
| `rules.<id>.threshold` | rule-specific | Loop detection thresholds (see below) |

### Rule thresholds

| Rule | Key | Default | Meaning |
|---|---|---|---|
| `toolErrorLoop` | `threshold` | `3` | Same tool errored N times → finding |
| `toolResultLoop` | `threshold` | `3` | Same tool + identical args called N times → dead loop |
| `tokenBurn` | `inputThreshold` / `outputThreshold` | `50000` / `100` | Single call: >50k input, <100 output → burn |
| `noProgress` | `windowSteps` | `5` | N consecutive steps with shrinking assistant output → stall |

---

## Failure Modes

| id | severity | What it detects |
|---|---|---|
| `tool-error-loop` | major → critical | Same tool errored ≥ `threshold` times |
| `tool-result-loop` | critical | Same tool + identical args called ≥ `threshold` times (dead loop) |
| `max-tokens-truncated` | major | `turn/end.reason.kind === 'max-tokens'` |
| `sandbox-denied` | major | Tool result contains permission/sandbox denial |
| `approval-blocked` | major | `turn/end.reason.kind === 'blocked'` |
| `llm-error` | critical | `turn/end.reason.kind === 'error'` with failure code |
| `llm-aborted` | critical | `turn/end.reason.kind === 'aborted'` |
| `prompt-injection-signal` | major | User message contains injection patterns |
| `token-burn` | minor | Single call: >50k input tokens, <100 output |
| `no-progress` | major | N consecutive steps with shrinking assistant output |

---

## How It Works

```
turn/end (reason=error|blocked|interrupted|aborted)
    │  auto-trigger (or: Web UI click, or: agent tool call)
    ▼
ctx.sessionQuery.readSession(id)  →  events[]
    │
    ├─► [Rule engine]  →  findings[]   (failure mode + evidence + fix)
    │                                      (no LLM call — free, synchronous)
    │
    └─► [LLM diagnose]  (optional)
            │  reuses the session's own model route (no extra API key)
            │  ctx.llm.stream({ purpose: 'session-title', ... })
            ▼
     DiagnosisReport
    │
    ├─► Markdown file   (~/.dsh/tianshu-reports/<sid>-<timestamp>.md)
    ├─► In-memory cache  (Web UI reads via /tianshu RPC channel)
    ├─► Tool result      (agent receives a structured summary)
    └─► tianshu/report event (other plugins can subscribe)
```

---

## Architecture

```
src/
├── index.ts                    # Host entry: tool + auto-trigger + server API + /tianshu RPC channel
├── config.ts                   # Config schema + validation
├── types.ts                    # Shared types (Finding, DiagnosisReport, …)
├── analyzer/
│   ├── session-loader.ts       # Load events from ctx.sessionQuery (live + persisted)
│   ├── rule-engine.ts          # 10 rules + heat map + fork-point recommender
│   └── llm-diagnoser.ts        # Reuse ctx.llm + session route for deep diagnosis
└── report/
    ├── markdown.ts             # Render DiagnosisReport → Markdown
    └── store.ts                # Persist to disk + in-memory cache for the UI

client/
├── index.ts                    # Browser entry: locale + slot injection + RPC client
├── HeaderAction.tsx            # The "⚕︎ Diagnose" button in the session header
├── Panel.tsx                   # The diagnosis panel (findings, heatmap, forks, LLM)
└── locales.ts                  # en / zh strings
```

### Host ↔ Browser bridge

DSH has **no automatic host→client service bridge**. `ctx.provide('tianshu', api)` is
process-local (host-only). TianShu bridges the browser to the host via the generic
[Connection RPC][dsh-rpc] channel `/tianshu`:

- **Host** ([src/index.ts](./src/index.ts)) registers `ctx.connection.rpc.handle('/tianshu', …)`
  with `authority: 'trusted-host'` and dispatches `analyze` / `getReport` / `listReports` /
  `readMarkdown` endpoints.
- **Browser** ([client/index.ts](./client/index.ts)) declares `inject: ['connection']` and calls
  `ctx.connection.rpc.call('/tianshu', endpoint, payload)`, unwrapping the `RpcResult` envelope.

No separate API key or proxy is needed — the channel rides DSH's existing trust fence.

---

## Build

```sh
pnpm build          # one-shot build (host ESM + browser CJS bundle)
pnpm watch          # rebuild on change (dev)
pnpm typecheck      # tsc --noEmit
```

The build produces two artifacts under `lib/`:

| Output | Format | Loaded by |
|---|---|---|
| `lib/index.mjs` + `*.d.mts` | ESM | DSH host (Node) |
| `lib/client.js` | CJS factory | DSH browser shell via `window.__ModuleLoader__.load({ id, factory })` |

---

## Troubleshooting

### "loaded without registering via __ModuleLoader__.load"

The browser bundle must be a CJS factory wrapped in `window.__ModuleLoader__.load({ id, factory })`.
This is handled by [tsdown.config.ts](./tsdown.config.ts) — if you fork the build config, keep the
`banner` / `intro` / `footer` that emit the wrapper.

### "cannot get property 'tianshu' without inject"

The browser client must declare `inject: ['connection']` (it reads `ctx.connection.rpc`, **not**
`ctx.tianshu`). The host-side `ctx.tianshu` is process-local and never crosses to the browser.

### "cannot get property 'sessionQuery' without inject"

The host plugin must declare `inject: ['tools', 'llm', 'sessionQuery', 'sessions']`. Missing any of
these raises this error at the first access.

### "⚕︎ Diagnose button not visible"

1. Confirm the patch is active: `dsh web --patch ./cordis.patch.yml`
2. Hard-reload the browser tab (the client bundle is revision-tagged; stale tabs may cache the old
   `client.js`).
3. Check the browser console — the slot error boundary retries once on connection-ready.

---

## Author

**Zhou Long (Tianshu Intelligent / 天枢智能)**

- WeChat: `longling1031`
- Email: `1033085514@qq.com`
- Location: Pinghu, Jiaxing, Zhejiang, China
- Blog: <https://www.zhihu.com/people/tianshu_cn>

---

## License

[MIT](./LICENSE) © Zhou Long (Tianshu Intelligent / 天枢智能)

[dsh]: https://github.com/deepseek-ai/deepseek-harness
[dsh-rpc]: https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/client/connection

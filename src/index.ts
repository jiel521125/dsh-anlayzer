/**
 * TianShu (天枢) — host-side entry point.
 *
 * Registers the `diagnose_session` agent tool, subscribes to `session/event`
 * for automatic failure-triggered analysis, exposes a server-side API the
 * browser panel reads via the client-runtime RPC bridge, and persists Markdown
 * reports to disk.
 *
 * @module dsh-tianshu-analyzer
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

// Extend Context with our service property (declared via `provide`).
declare module '@deepseek-ai/cordis' {
  interface Context {
    tianshu?: TianShuServerApi
  }
}
import type { TianShuConfig, DiagnosisReport } from './types.ts'
import { resolveConfig, DEFAULT_CONFIG } from './config.ts'
import { loadSession } from './analyzer/session-loader.ts'
import type { AnalyzedSession } from './analyzer/session-loader.ts'
import { runRuleEngine, buildHeatmap, recommendForkPoints } from './analyzer/rule-engine.ts'
import { safeDiagnoseWithLlm } from './analyzer/llm-diagnoser.ts'
import { renderMarkdown } from './report/markdown.ts'
import { ReportStore, resolveReportDir } from './report/store.ts'

// ---------------------------------------------------------------------------
// Cordis plugin contract
// ---------------------------------------------------------------------------

export const name = 'dsh-tianshu-analyzer'
export const inject = ['tools', 'llm', 'sessionQuery', 'sessions']
export const provide = ['tianshu']

/** The host entry point. `config` arrives from the cordis.patch.yml overlay. */
export function apply(ctx: Context, config: unknown = DEFAULT_CONFIG): void {
  const cfg = resolveConfig(config)
  const store = new ReportStore(resolveReportDir(cfg.reportDir), cfg.keepReports)

  // --- Auto-trigger: analyze on failed turn/end ---
  if (cfg.autoTrigger) {
    ctx.on('session/event', async (session: SessionLike, event: SessionEventLike) => {
      if (event.type !== 'turn/end') return
      const reason = (event.data as { reason?: { kind?: string } })?.reason?.kind
      if (reason === undefined || !cfg.autoTriggerReasons.includes(reason)) return
      const sid = String(session.id ?? '')
      if (sid.length === 0) return
      // Fire-and-forget; never block the event loop.
      void analyzeSession(ctx, cfg, store, sid, reason).catch(error => {
        ctx.logger.warn('tianshu: auto-trigger analysis failed')
        ctx.logger.warn(error)
      })
    })
  }

  // --- Agent tool: diagnose_session ---
  ctx.tools.register(defineTool({
    name: 'diagnose_session',
    description: 'Analyze a failed or completed session to identify the root cause of failure, '
      + 'detect agent loops, and recommend fork points. Call this after a task fails, stalls, '
      + 'or when you want to复盘 a session. Pass the sessionId to analyze.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'The session id to analyze.' },
      useLlm: {
        type: 'boolean',
        description: 'Whether to enable LLM deep diagnosis (defaults to the plugin config).',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const sessionId = String(args.sessionId ?? '')
      const useLlmRaw = args.useLlm
      const useLlm = typeof useLlmRaw === 'boolean' ? useLlmRaw : cfg.llmDiagnose
      const effectiveConfig: TianShuConfig = useLlm === cfg.llmDiagnose
        ? cfg
        : { ...cfg, llmDiagnose: useLlm }
      const report = await analyzeSession(ctx, effectiveConfig, store, sessionId, null, exec.signal)
      // Return a human-readable summary as the canonical value; the model reads it directly.
      const lines: string[] = [
        `## TianShu Diagnosis: ${report.sessionId}`,
        ``,
        `**Findings:** ${report.findings.length}`,
      ]
      const critical = report.findings.filter(f => f.severity === 'critical')
      if (critical.length > 0) {
        lines.push(`**Critical findings:**`)
        for (const f of critical) lines.push(`- ${f.mode}: ${f.headline}`)
      }
      if (report.forkPoints.length > 0) {
        lines.push(`**Recommended fork points:**`)
        for (const fp of report.forkPoints) lines.push(`- seq ${fp.seq} — ${fp.rationale}`)
      }
      if (report.llmDiagnosis !== null && report.llmDiagnosis.length > 0) {
        lines.push(``, `**LLM deep diagnosis:**`, ``, report.llmDiagnosis)
      }
      return lines.join('\n')
    },
  }))

  // --- Server-side API surface (read by the client RPC bridge) ---
  // The client panel calls these via ctx.tianshu.* through the typert RPC bridge.
  provideTianshuApi(ctx, cfg, store)
}

// ---------------------------------------------------------------------------
// Core analysis pipeline (shared by auto-trigger and the agent tool)
// ---------------------------------------------------------------------------

async function analyzeSession(
  ctx: Context,
  cfg: TianShuConfig,
  store: ReportStore,
  sessionId: string,
  triggerReason: string | null,
  signal?: AbortSignal,
): Promise<DiagnosisReport> {
  const session = await loadSession(ctx, sessionId)
  if (session === null) {
    throw new Error(`tianshu: session "${sessionId}" not found or has no events`)
  }

  // 1. Rule engine
  const findings = runRuleEngine(session, cfg)
  const heatmap = buildHeatmap(session)
  const forkPoints = recommendForkPoints(session, findings)

  // 2. LLM deep diagnosis (optional)
  let llmDiagnosis: string | null = null
  let llmDiagnosisError: string | null = null
  if (cfg.llmDiagnose) {
    const result = await safeDiagnoseWithLlm(ctx, cfg, session, findings, signal)
    llmDiagnosis = result.text
    llmDiagnosisError = result.error
  }

  const report: DiagnosisReport = {
    sessionId,
    analyzedAt: new Date().toISOString(),
    triggerReason,
    route: session.route,
    stats: session.stats,
    findings,
    heatmap,
    forkPoints,
    llmDiagnosis,
    llmDiagnosisError,
  }

  // 3. Persist + cache
  await store.save(report)
  return report
}

// ---------------------------------------------------------------------------
// Server-side API for the client RPC bridge
// ---------------------------------------------------------------------------

/** The API surface exposed to the client panel via typert. */
export interface TianShuServerApi {
  analyze(sessionId: string, useLlm?: boolean): Promise<DiagnosisReport>
  getReport(sessionId: string): Promise<DiagnosisReport | null>
  listReports(): Promise<readonly { sessionId: string; analyzedAt: string; findingsCount: number; filePath: string | null }[]>
  readMarkdown(sessionId: string): Promise<string | null>
}

// ---------------------------------------------------------------------------
// Browser RPC bridge (generic Connection RPC channel)
// ---------------------------------------------------------------------------
// ctx.provide('tianshu', api) is process-local: it never crosses to the browser.
// DSH exposes no automatic host→client service bridge; a third-party plugin
// must carry its own channel. We register a dedicated `/tianshu` channel on
// the Connection transport: the browser panel calls
// ctx.connection.rpc.call('/tianshu', endpoint, payload) and receives an
// RpcResult envelope. The shapes below mirror @deepseek-ai/dsh-host-apiproxy
// so no extra dependency is needed for types.

/** Success/failure envelope, matching the Connection RPC contract. */
type TianShuRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, unknown> } }

/** Minimal host-side Connection.rpc.handle signature (avoids a type-only dep). */
interface HostConnectionRpcLike {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<TianShuRpcResult<unknown>>,
    options: { readonly authority: 'trusted-host' | 'loopback' },
  ): () => Promise<void>
}

/** Dispatch one RPC endpoint to the TianShu server API. */
async function dispatchTianshuRpc(api: TianShuServerApi, endpoint: string, payload: unknown): Promise<unknown> {
  const p = (payload ?? {}) as { sessionId?: unknown; useLlm?: unknown }
  switch (endpoint) {
    case 'analyze':
      return api.analyze(String(p.sessionId ?? ''), p.useLlm === undefined ? undefined : Boolean(p.useLlm))
    case 'getReport':
      return api.getReport(String(p.sessionId ?? ''))
    case 'listReports':
      return api.listReports()
    case 'readMarkdown':
      return api.readMarkdown(String(p.sessionId ?? ''))
    default:
      throw new Error(`tianshu: unknown RPC endpoint ${JSON.stringify(endpoint)}`)
  }
}

function provideTianshuApi(ctx: Context, cfg: TianShuConfig, store: ReportStore): void {
  const api: TianShuServerApi = {
    async analyze(sessionId: string, useLlm?: boolean) {
      const effectiveConfig: TianShuConfig = useLlm === undefined
        ? cfg
        : { ...cfg, llmDiagnose: useLlm }
      return analyzeSession(ctx, effectiveConfig, store, sessionId, null)
    },
    async getReport(sessionId: string) {
      return store.get(sessionId) ?? null
    },
    async listReports() {
      const stored = await store.list()
      return stored.map(s => ({
        sessionId: s.sessionId,
        analyzedAt: s.analyzedAt,
        findingsCount: s.findingsCount,
        filePath: s.filePath,
      }))
    },
    async readMarkdown(sessionId: string) {
      return store.readMarkdown(sessionId)
    },
  }

  // In-process registration (other host plugins may read ctx.tianshu directly).
  ctx.provide('tianshu', api)

  // Browser bridge: register the /tianshu channel on the Connection transport.
  // Deferred so the plugin still loads (tool + auto-trigger) in a headless
  // profile where the Connection service is absent.
  ctx.inject(['connection'], (connectionCtx) => {
    const rpc = (connectionCtx as Context & { connection: HostConnectionRpcLike }).connection.rpc
    rpc.handle('/tianshu', async (endpoint, payload) => {
      try {
        const value = await dispatchTianshuRpc(api, endpoint, payload)
        return { ok: true, value }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            details: {},
          },
        }
      }
    }, { authority: 'trusted-host' })
  })
}

// ---------------------------------------------------------------------------
// Loose runtime types (the canonical types live in @deepseek-ai/dsh-session;
// we narrow at runtime so the plugin never hard-fails on a version drift)
// ---------------------------------------------------------------------------

interface SessionLike {
  readonly id?: unknown
}

interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

export { renderMarkdown, type TianShuConfig, type DiagnosisReport }

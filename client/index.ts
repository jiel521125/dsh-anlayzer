/**
 * TianShu — browser-side entry point.
 *
 * Injects a "Diagnosis" action into the session header utilities slot. When
 * the user clicks it, the panel opens, calls the host-side `ctx.tianshu`
 * API through the client-runtime RPC bridge, and renders the diagnosis.
 *
 * @module dsh-tianshu-analyzer/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TianShuHeaderAction } from './HeaderAction.tsx'
import type { TianShuPanelInjected } from './Panel.tsx'
import { NS, en, zh, type TianShuLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'tianshu-analyzer': TianShuLocaleKey
  }
}

export const name = 'dsh-tianshu-analyzer/client'
export const inject = ['slots', 'locale', 'connection']

// The host-side `ctx.provide('tianshu', api)` is process-local and never
// reaches the browser. DSH has no automatic host→client service bridge, so
// the panel calls the host through the generic Connection RPC channel
// `/tianshu` that the host plugin registers. The shapes below mirror
// @deepseek-ai/dsh-host-apiproxy so no extra client dependency is needed.
type TianShuRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: unknown } }

interface TianShuConnectionHandle {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<TianShuRpcResult>
  }
}

/** Browser entry point: register locale + inject the header action. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tianshu: browser dictionaries')
  const api = createTianshuClientApi(ctx)
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'tianshu-analyzer',
    locale: NS,
    inject: (): TianShuPanelInjected => ({ api }),
  }, TianShuHeaderAction))
}

/** Build the panel API backed by the `/tianshu` Connection RPC channel. */
function createTianshuClientApi(ctx: ClientContext): TianShuPanelApi {
  const connection = (ctx as ClientContext & { connection?: TianShuConnectionHandle }).connection
  const call = async (endpoint: string, payload: unknown): Promise<unknown> => {
    if (connection === undefined) {
      throw new Error('TianShu: Connection RPC channel unavailable (host plugin not loaded).')
    }
    const result = await connection.rpc.call('/tianshu', endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  return {
    async analyze(sessionId, useLlm) {
      return call('analyze', { sessionId, useLlm }) as Promise<DiagnosisReportLike>
    },
    async getReport(sessionId) {
      return call('getReport', { sessionId }) as Promise<DiagnosisReportLike | null>
    },
    async listReports() {
      return call('listReports', {}) as Promise<readonly { sessionId: string; analyzedAt: string; findingsCount: number; filePath: string | null }[]>
    },
    async readMarkdown(sessionId) {
      return call('readMarkdown', { sessionId }) as Promise<string | null>
    },
  }
}

/** The host-side API the panel reads (mirrors TianShuServerApi, carried over RPC). */
export interface TianShuPanelApi {
  analyze(sessionId: string, useLlm?: boolean): Promise<DiagnosisReportLike>
  getReport(sessionId: string): Promise<DiagnosisReportLike | null>
  listReports(): Promise<readonly { sessionId: string; analyzedAt: string; findingsCount: number; filePath: string | null }[]>
  readMarkdown(sessionId: string): Promise<string | null>
}

/** Loose diagnosis report shape for the browser side. */
export interface DiagnosisReportLike {
  readonly sessionId: string
  readonly analyzedAt: string
  readonly triggerReason: string | null
  readonly route: { provider: string; model: string } | null
  readonly stats: {
    readonly totalEvents: number
    readonly totalTurns: number
    readonly totalToolCalls: number
    readonly totalToolErrors: number
    readonly totalInputTokens: number
    readonly totalOutputTokens: number
    readonly durationMs: number | null
  }
  readonly findings: readonly {
    readonly mode: string
    readonly headline: string
    readonly detail: string
    readonly severity: 'critical' | 'major' | 'minor'
    readonly evidenceSeqs: readonly number[]
    readonly suggestion: string
  }[]
  readonly heatmap: readonly {
    name: string
    calls: number
    errors: number
    errorRate: number
    avgLatencyMs: number | null
    maxLatencyMs: number | null
    firstSeq: number
    lastSeq: number
  }[]
  readonly performance: {
    avgToolLatencyMs: number | null
    maxToolLatencyMs: number | null
    p50ToolLatencyMs: number | null
    p95ToolLatencyMs: number | null
    p99ToolLatencyMs: number | null
    avgTurnLatencyMs: number | null
    outputTokensPerSec: number | null
    inputTokensPerSec: number | null
    durationMs: number | null
  }
  readonly quality: {
    score: number
    grade: 'A' | 'B' | 'C' | 'D' | 'F'
    breakdown: {
      successRate: number
      toolReliability: number
      tokenEfficiency: number
      progress: number
      loopFree: number
    }
    summary: string
  }
  readonly forkPoints: readonly { seq: number; rationale: string; tryInstead: string }[]
  readonly llmDiagnosis: string | null
  readonly llmDiagnosisError: string | null
}

/**
 * LLM deep-diagnosis module.
 *
 * Reuses the session's own model route (or an explicit override from config)
 * to ask the model "why did this session fail?" with the rule-engine findings
 * as structured context. Follows the dsh-session-title-llm auxiliary-call
 * pattern: marks the call with `purpose: 'session-title'`, assembles the
 * streamed chunks via BlockAssembler, and respects a deadline signal.
 *
 * @module dsh-tianshu-analyzer/analyzer/llm-diagnoser
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { TianShuConfig, DiagnosisReport, Finding } from '../types.ts'
import type { AnalyzedSession } from './session-loader.ts'

/** Resolve the model route: explicit config overrides win, else the session's own route. */
function resolveRoute(config: TianShuConfig, session: AnalyzedSession): { provider: string; model: string } | null {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  return session.route
}

/** Build the system prompt instructing the model to diagnose the failure. */
function systemPrompt(): string {
  return [
    'You are TianShu (天枢), a failure root-cause analyzer for AI agent sessions.',
    'You are given a structured summary of a failed agent session plus the rule-engine findings.',
    'Your job is to produce a precise root-cause diagnosis in natural language.',
    '',
    'Structure your answer as:',
    '1. **Root Cause**: one-paragraph statement of the single most likely root cause.',
    '2. **Evidence**: 2-4 bullet points citing the specific signals from the findings and stats.',
    '3. **Why it failed**: explain the causal chain from the root cause to the observed failure.',
    '4. **Recommended fix**: the single most effective action to prevent this failure class.',
    '5. **Fork advice**: which point in the session is the best place to retry from, and what to try differently.',
    '',
    'Be concrete and specific. Reference tool names, seq numbers, and token counts when relevant.',
    'Do not invent facts not present in the input. If the root cause is ambiguous, say so and list the top candidates.',
    'Write in the same language as the session content.',
  ].join('\n')
}

/** Render the session summary + findings as the user message for the diagnostic call. */
function frameDiagnosticInput(session: AnalyzedSession, findings: readonly Finding[]): string {
  const stats = session.stats
  const lines: string[] = [
    'Diagnose the following failed agent session.',
    '',
    '## Session stats',
    `- sessionId: ${session.sessionId}`,
    `- totalEvents: ${stats.totalEvents}`,
    `- totalTurns: ${stats.totalTurns}`,
    `- totalToolCalls: ${stats.totalToolCalls}`,
    `- totalToolErrors: ${stats.totalToolErrors}`,
    `- totalInputTokens: ${stats.totalInputTokens}`,
    `- totalOutputTokens: ${stats.totalOutputTokens}`,
    `- durationMs: ${stats.durationMs ?? 'unknown'}`,
    `- lastTurnEndReason: ${session.lastTurnEnd?.reason.kind ?? 'unknown'}`,
    ...(session.lastTurnEnd?.reason.failure !== undefined
      ? [`  - failureCode: ${session.lastTurnEnd.reason.failure.code}`,
          `  - failureMessage: ${session.lastTurnEnd.reason.failure.message}`]
      : []),
    ...(session.route !== null
      ? [`- route: ${session.route.provider}/${session.route.model}`]
      : []),
    '',
    '## Rule-engine findings',
  ]
  if (findings.length === 0) {
    lines.push('(no findings — the rule engine detected no known failure pattern)')
  } else {
    for (const [i, f] of findings.entries()) {
      lines.push(
        `### Finding ${i + 1}: [${f.severity}] ${f.mode}`,
        `headline: ${f.headline}`,
        `detail: ${f.detail}`,
        `suggestion: ${f.suggestion}`,
        ...(f.evidenceSeqs.length > 0 ? [`evidenceSeqs: ${f.evidenceSeqs.join(', ')}`] : []),
        '',
      )
    }
  }

  // Include a compact event trace (types + seqs, truncated) so the model can see the shape.
  lines.push('## Event trace (compact, last 60 events)')
  const trace = session.events.slice(-60)
  for (const e of trace) {
    let summary = `seq=${e.seq} type=${e.type}`
    if (e.type === 'tool/call' && e.data !== undefined) {
      const d = e.data as { name?: string }
      if (d.name !== undefined) summary += ` tool=${d.name}`
    } else if (e.type === 'tool/result' && e.data !== undefined) {
      const d = e.data as { isError?: boolean }
      summary += ` isError=${d.isError ?? false}`
    } else if (e.type === 'turn/end' && e.data !== undefined) {
      const d = e.data as { reason?: { kind?: string } }
      summary += ` reason=${d.reason?.kind ?? 'unknown'}`
    }
    lines.push(summary)
  }

  return lines.join('\n')
}

/** Run the LLM diagnosis. Returns the natural-language text, or throws on failure. */
export async function diagnoseWithLlm(
  ctx: Context,
  config: TianShuConfig,
  session: AnalyzedSession,
  findings: readonly Finding[],
  signal?: AbortSignal,
): Promise<string> {
  const route = resolveRoute(config, session)
  if (route === null) {
    throw new Error('tianshu: no model route available — configure provider+model, or ensure the session has an assistant message with a model source')
  }

  const userText = frameDiagnosticInput(session, findings)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'plugin', plugin: 'dsh-tianshu-analyzer' },
  })]

  // Combine the caller's signal with a deadline.
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs)

  try {
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages,
      system: systemPrompt(),
      maxTokens: config.llmMaxTokens,
      purpose: 'session-title', // auxiliary call marker (reuse the only non-loop purpose)
      signal: controller.signal,
    }

    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(options)) {
      controller.signal.throwIfAborted()
      assembler.push(chunk)
    }
    controller.signal.throwIfAborted()

    // A terminal error finish becomes a thrown diagnosis failure.
    const finish = assembler.finish
    if (finish !== undefined && (finish.kind === 'error' || finish.kind === 'aborted')) {
      throw new Error(`tianshu: LLM diagnosis call failed (${finish.kind}): ${finish.failure.message} [${finish.failure.code}]`)
    }
    if (finish?.kind === 'max-tokens') {
      // Partial diagnosis is still useful; fall through with what we have.
    }

    const text = assembler.blocks()
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim()

    if (text.length === 0) {
      throw new Error('tianshu: LLM diagnosis produced no text output')
    }
    return text
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Run the LLM diagnosis, capturing any failure into `llmDiagnosisError` instead of throwing. */
export async function safeDiagnoseWithLlm(
  ctx: Context,
  config: TianShuConfig,
  session: AnalyzedSession,
  findings: readonly Finding[],
  signal?: AbortSignal,
): Promise<{ text: string | null; error: string | null }> {
  try {
    const text = await diagnoseWithLlm(ctx, config, session, findings, signal)
    return { text, error: null }
  } catch (e) {
    return { text: null, error: e instanceof Error ? e.message : String(e) }
  }
}

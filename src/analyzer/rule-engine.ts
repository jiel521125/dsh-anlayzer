/**
 * Rule engine: pattern-based failure-mode detection over a loaded session.
 *
 * Each rule is a pure function `(session, config) => Finding[]`. The engine
 * runs every enabled rule and returns findings ordered by severity then by
 * the first evidence seq.
 *
 * @module dsh-tianshu-analyzer/analyzer/rule-engine
 */

import type { TianShuConfig, Finding, Severity, ForkPoint, ToolHeatmapEntry } from '../types.ts'
import type { AnalyzedSession } from './session-loader.ts'
import { ruleConfig } from '../config.ts'

/** A rule: detect one failure mode over one session. */
interface Rule {
  readonly id: string
  run(session: AnalyzedSession, config: TianShuConfig): Finding[]
}

// ---------------------------------------------------------------------------
// Rule 1: tool-error-loop — same tool errored ≥ threshold times in a row.
// ---------------------------------------------------------------------------

const toolErrorLoop: Rule = {
  id: 'tool-error-loop',
  run(session, config) {
    const cfg = ruleConfig(config, 'tool-error-loop')
    if (!cfg.enabled) return []
    const threshold = cfg.threshold ?? 3

    const findings: Finding[] = []
    // Walk tool/results paired with their preceding tool/call (by toolCallId).
    const callByName = new Map<string, { seq: number; name: string }>()
    for (const { seq, data } of session.toolResults) {
      const id = data.toolCallId
      if (id === undefined || data.isError !== true) continue
      const call = callByName.get(id)
      if (call === undefined) continue
      // Count consecutive errors for the same tool name ending here.
      // (Simplified: we count all errors per tool and flag when ≥ threshold.)
    }
    // Build a simpler aggregate: errors per tool name.
    const nameToCallSeqs = new Map<string, number[]>()
    for (const { seq, data } of session.toolCalls) {
      if (data.name === undefined) continue
      const arr = nameToCallSeqs.get(data.name) ?? []
      arr.push(seq)
      nameToCallSeqs.set(data.name, arr)
    }
    const errorSeqsByName = new Map<string, number[]>()
    for (const { seq, data } of session.toolResults) {
      if (data.isError !== true || data.toolCallId === undefined) continue
      // Find the matching call by id; we need the name, so scan toolCalls.
      const call = session.toolCalls.find(c => c.data.toolCallId === data.toolCallId)
      if (call?.data.name === undefined) continue
      const arr = errorSeqsByName.get(call.data.name) ?? []
      arr.push(seq)
      errorSeqsByName.set(call.data.name, arr)
    }
    for (const [name, seqs] of errorSeqsByName) {
      if (seqs.length < threshold) continue
      findings.push({
        mode: 'tool-error-loop',
        severity: seqs.length >= threshold * 2 ? 'critical' : 'major',
        headline: `Tool "${name}" errored ${seqs.length} times`,
        detail: `The tool "${name}" returned errors at ${seqs.length} separate call sites. `
          + `Repeated tool errors usually mean the tool's arguments are wrong, the environment is broken, `
          + `or the model keeps retrying the same failing approach.`,
        evidenceSeqs: seqs.slice(0, 10),
        suggestion: `Inspect the first error for "${name}" (seq ${seqs[0]!}). If the arguments are wrong, `
          + `correct the model's approach. If the environment is broken, fix the tool's prerequisites. `
          + `If the model is stuck in a retry loop, fork before the first error and redirect.`,
      })
    }
    return findings
  },
}

// ---------------------------------------------------------------------------
// Rule 2: tool-result-loop — same tool + same arguments called ≥ threshold times.
// ---------------------------------------------------------------------------

const toolResultLoop: Rule = {
  id: 'tool-result-loop',
  run(session, config) {
    const cfg = ruleConfig(config, 'tool-result-loop')
    if (!cfg.enabled) return []
    const threshold = cfg.threshold ?? 3

    // Group tool/call events by (name, arguments) and count.
    const signatureToSeqs = new Map<string, number[]>()
    for (const { seq, data } of session.toolCalls) {
      if (data.name === undefined) continue
      const sig = `${data.name}::${data.arguments ?? ''}`
      const arr = signatureToSeqs.get(sig) ?? []
      arr.push(seq)
      signatureToSeqs.set(sig, arr)
    }

    const findings: Finding[] = []
    for (const [, seqs] of signatureToSeqs) {
      if (seqs.length < threshold) continue
      const firstCall = session.toolCalls.find(c => c.seq === seqs[0])
      const name = firstCall?.data.name ?? '<unknown>'
      findings.push({
        mode: 'tool-result-loop',
        severity: 'critical',
        headline: `Tool "${name}" called ${seqs.length} times with identical arguments`,
        detail: `The model called "${name}" ${seqs.length} times with the exact same arguments `
          + `(seqs: ${seqs.slice(0, 6).join(', ')}${seqs.length > 6 ? '…' : ''}). `
          + `This is a classic agent loop: the model is not learning from the tool's result and keeps retrying.`,
        evidenceSeqs: seqs.slice(0, 10),
        suggestion: `Fork to just before the second call (seq ${seqs[1]!}) and give the model an explicit hint. `
          + `The repeated call means the model did not interpret the first result correctly — rephrase the task `
          + `or check whether the tool is returning something the model cannot parse.`,
      })
    }
    return findings
  },
}

// ---------------------------------------------------------------------------
// Rule 3: max-tokens-truncated — turn ended because output hit max-tokens.
// ---------------------------------------------------------------------------

const maxTokensTruncated: Rule = {
  id: 'max-tokens-truncated',
  run(session, _config) {
    const cfg = ruleConfig(_config, 'max-tokens-truncated')
    if (!cfg.enabled) return []
    const findings: Finding[] = []
    for (const turn of session.turns) {
      if (turn.reason.kind === 'max-tokens') {
        findings.push({
          mode: 'max-tokens-truncated',
          severity: 'major',
          headline: `Turn ${turn.turn} was truncated at max-tokens`,
          detail: `The model's output for turn ${turn.turn} was cut off mid-generation because it hit the `
            + `output token limit. The assistant's response is incomplete and may be syntactically invalid.`,
          evidenceSeqs: [],
          suggestion: `Increase the model's maxTokens, or break the task into smaller steps so the model `
            + `does not need to produce a long single response. If the model was outputting a large file, `
            + `ask it to write to disk in chunks instead.`,
        })
      }
    }
    return findings
  },
}

// ---------------------------------------------------------------------------
// Rule 4: sandbox-denied — a tool result mentions sandbox/permission denial.
// ---------------------------------------------------------------------------

const SANDBOX_SIGNALS = [
  'permission denied',
  'sandbox',
  'operation not permitted',
  'access denied',
  'operation was rejected',
  'not allowed',
] as const

const sandboxDenied: Rule = {
  id: 'sandbox-denied',
  run(session, config) {
    const cfg = ruleConfig(config, 'sandbox-denied')
    if (!cfg.enabled) return []
    const findings: Finding[] = []
    for (const { seq, data } of session.toolResults) {
      if (data.isError !== true) continue
      const text = JSON.stringify(data.content ?? '').toLowerCase()
      const hit = SANDBOX_SIGNALS.find(s => text.includes(s))
      if (hit === undefined) continue
      findings.push({
        mode: 'sandbox-denied',
        severity: 'major',
        headline: `Sandbox/permission denial at seq ${seq}`,
        detail: `A tool call was rejected by the sandbox with a "${hit}" signal. The model attempted an `
          + `operation the security policy does not allow.`,
        evidenceSeqs: [seq],
        suggestion: `Either approve the operation in the harness approval flow, or adjust the sandbox policy `
          + `to allow this specific operation. If the operation is genuinely unsafe, redirect the model to a `
          + `policy-compliant alternative.`,
      })
    }
    return findings
  },
}

// ---------------------------------------------------------------------------
// Rule 5: approval-blocked — turn ended because a tool call was blocked.
// ---------------------------------------------------------------------------

const approvalBlocked: Rule = {
  id: 'approval-blocked',
  run(session, config) {
    const cfg = ruleConfig(config, 'approval-blocked')
    if (!cfg.enabled) return []
    const findings: Finding[] = []
    for (const turn of session.turns) {
      if (turn.reason.kind === 'blocked') {
        findings.push({
          mode: 'approval-blocked',
          severity: 'major',
          headline: `Turn ${turn.turn} was blocked by the approval gate`,
          detail: `The turn ended because a tool call was denied or left unapproved. `
            + `${turn.reason.failure?.message ?? ''}`,
          evidenceSeqs: [],
          suggestion: `Review the blocked tool call. If it was a false positive, adjust the approval policy. `
            + `If the call was correctly blocked, redirect the model to an approved alternative.`,
        })
      }
    }
    return findings
  },
}

// ---------------------------------------------------------------------------
// Rule 6 & 7: llm-error / llm-aborted — the model call itself failed.
// ---------------------------------------------------------------------------

function llmTerminalFailure(kind: 'error' | 'aborted'): Rule {
  return {
    id: kind === 'error' ? 'llm-error' : 'llm-aborted',
    run(session, config) {
      const cfg = ruleConfig(config, kind === 'error' ? 'llm-error' : 'llm-aborted')
      if (!cfg.enabled) return []
      const findings: Finding[] = []
      for (const turn of session.turns) {
        if (turn.reason.kind !== kind) continue
        const failure = turn.reason.failure
        findings.push({
          mode: kind === 'error' ? 'llm-error' : 'llm-aborted',
          severity: 'critical',
          headline: kind === 'error'
            ? `Turn ${turn.turn} ended in an LLM error`
            : `Turn ${turn.turn} was aborted`,
          detail: kind === 'error'
            ? `The model provider returned a terminal error${failure?.status !== undefined ? ` (HTTP ${failure.status})` : ''}: `
              + `${failure?.message ?? 'unknown error'} (code: ${failure?.code ?? 'unknown'})`
            : `The model call was aborted, likely due to a timeout, user cancellation, or signal. `
              + `${failure?.message ?? ''}`,
          evidenceSeqs: [],
          suggestion: kind === 'error'
            ? failure?.code === 'RATE_LIMIT'
              ? `Rate-limited by the provider; wait and retry, or reduce the request frequency.`
              : failure?.code === 'AUTH'
                ? `Authentication failed; check the API key in the harness Models page.`
                : `The provider reported an error. Check the provider's status page and the harness logs.`
            : `If this was a timeout, increase the call deadline. If the user cancelled, no action needed.`,
        })
      }
      return findings
    },
  }
}

// ---------------------------------------------------------------------------
// Rule 8: prompt-injection-signal — user message contains injection patterns.
// ---------------------------------------------------------------------------

const INJECTION_SIGNALS = [
  'ignore all previous instructions',
  'ignore your instructions',
  'you are now',
  'system prompt',
  'disregard the above',
  'forget your rules',
  'new instructions:',
  '<system>',
  '</system>',
] as const

const promptInjection: Rule = {
  id: 'prompt-injection-signal',
  run(session, config) {
    const cfg = ruleConfig(config, 'prompt-injection-signal')
    if (!cfg.enabled) return []
    const findings: Finding[] = []
    for (const { seq, message } of session.messages) {
      if (message.role !== 'user') continue
      const text = (message.content ?? [])
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join(' ')
        .toLowerCase()
      const hit = INJECTION_SIGNALS.find(s => text.includes(s))
      if (hit === undefined) continue
      findings.push({
        mode: 'prompt-injection-signal',
        severity: 'major',
        headline: `Possible prompt injection at seq ${seq}`,
        detail: `A user message contains the pattern "${hit}", which is a common prompt-injection signal. `
          + `If the model followed this instruction, the failed turn may be the result of the model abandoning `
          + `its original task.`,
        evidenceSeqs: [seq],
        suggestion: `If this was a legitimate user instruction, no action is needed. If it came from an `
          + `untrusted source (e.g., scraped web content), sanitize inputs before passing them to the model, `
          + `or use a system prompt that instructs the model to treat all user content as data.`,
      })
    }
    return findings
  },
}

// ---------------------------------------------------------------------------
// Rule 9: token-burn — a single step consumed huge input tokens but produced almost nothing.
// ---------------------------------------------------------------------------

const tokenBurn: Rule = {
  id: 'token-burn',
  run(session, config) {
    const cfg = ruleConfig(config, 'token-burn')
    if (!cfg.enabled) return []
    const inputThreshold = cfg.inputThreshold ?? 50_000
    const outputThreshold = cfg.outputThreshold ?? 100
    const findings: Finding[] = []
    for (const usage of session.usageEvents) {
      const input = usage.inputTokens ?? 0
      const output = usage.outputTokens ?? 0
      if (input < inputThreshold || output > outputThreshold) continue
      findings.push({
        mode: 'token-burn',
        severity: 'minor',
        headline: `Token burn: ${input} input tokens → ${output} output tokens`,
        detail: `A single model call consumed ${input} input tokens but produced only ${output} output tokens. `
          + `This usually means the context window is bloated (e.g., a huge file was loaded) and the model `
          + `is spending most of its budget re-reading redundant context every step.`,
        evidenceSeqs: [],
        suggestion: `Trim the context: use compaction, reduce the file size being loaded, or break the task `
          + `into smaller sub-tasks. If a large file is the cause, load only the relevant section.`,
      })
    }
    return findings
  },
}

// ---------------------------------------------------------------------------
// Rule 10: no-progress — many consecutive steps with shrinking assistant output.
// ---------------------------------------------------------------------------

const noProgress: Rule = {
  id: 'no-progress',
  run(session, config) {
    const cfg = ruleConfig(config, 'no-progress')
    if (!cfg.enabled) return []
    const window = cfg.windowSteps ?? 5
    // Collect assistant message lengths in order.
    const lengths: { seq: number; len: number }[] = []
    for (const { seq, message } of session.messages) {
      if (message.role !== 'assistant') continue
      const len = (message.content ?? [])
        .filter(b => b.type === 'text')
        .reduce((sum, b) => sum + (b.text?.length ?? 0), 0)
      lengths.push({ seq, len })
    }
    if (lengths.length < window) return []
    const findings: Finding[] = []
    // Slide a window; flag when all entries are non-zero but strictly decreasing.
    for (let i = 0; i <= lengths.length - window; i++) {
      const slice = lengths.slice(i, i + window)!
      const allDecreasing = slice.every((v, j) => j === 0 || v.len < slice[j - 1]!.len)
      const allNonZero = slice.every(v => v.len > 0)
      if (allDecreasing && allNonZero) {
        findings.push({
          mode: 'no-progress',
          severity: 'major',
          headline: `No progress: ${window} consecutive steps with shrinking output`,
          detail: `Assistant output length decreased over ${window} consecutive steps (seqs `
            + `${slice[0]!.seq}→${slice[window - 1]!.seq}). The model is producing less and less each turn, `
            + `which is a strong signal it is stuck and rephrasing the same dead-end approach.`,
          evidenceSeqs: slice.map(s => s.seq),
          suggestion: `Fork to before the first shrinking step (seq ${slice[0]!.seq}) and give the model a `
            + `concrete new direction. The model has exhausted its current strategy.`,
        })
      }
    }
    return findings
  },
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const RULES: readonly Rule[] = [
  toolErrorLoop,
  toolResultLoop,
  maxTokensTruncated,
  sandboxDenied,
  approvalBlocked,
  llmTerminalFailure('error'),
  llmTerminalFailure('aborted'),
  promptInjection,
  tokenBurn,
  noProgress,
]

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  critical: 0,
  major: 1,
  minor: 2,
}

/** Run every enabled rule over the session and return ordered findings. */
export function runRuleEngine(session: AnalyzedSession, config: TianShuConfig): readonly Finding[] {
  const all: Finding[] = []
  for (const rule of RULES) {
    try {
      all.push(...rule.run(session, config))
    } catch {
      // A single rule must never crash the whole engine.
    }
  }
  return all.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (sev !== 0) return sev
    return (a.evidenceSeqs[0] ?? 0) - (b.evidenceSeqs[0] ?? 0)
  })
}

/** Build the per-tool call/error heat map. */
export function buildHeatmap(session: AnalyzedSession): readonly ToolHeatmapEntry[] {
  const map = new Map<string, ToolHeatmapEntry & { calls: number; errors: number; firstSeq: number; lastSeq: number }>()
  for (const { seq, data } of session.toolCalls) {
    if (data.name === undefined) continue
    const existing = map.get(data.name)
    if (existing === undefined) {
      map.set(data.name, { name: data.name, calls: 1, errors: 0, firstSeq: seq, lastSeq: seq })
    } else {
      existing.calls += 1
      existing.lastSeq = seq
    }
  }
  for (const { seq, data } of session.toolResults) {
    if (data.isError !== true || data.toolCallId === undefined) continue
    const call = session.toolCalls.find(c => c.data.toolCallId === data.toolCallId)
    if (call?.data.name === undefined) continue
    const entry = map.get(call.data.name)
    if (entry !== undefined) entry.errors += 1
  }
  return [...map.values()].sort((a, b) => b.calls - a.calls)
}

/** Recommend fork points: the seq just before each critical/major finding's first evidence. */
export function recommendForkPoints(session: AnalyzedSession, findings: readonly Finding[]): readonly ForkPoint[] {
  const points: ForkPoint[] = []
  const seen = new Set<number>()
  for (const finding of findings) {
    if (finding.severity === 'minor') continue
    const firstSeq = finding.evidenceSeqs[0]
    if (firstSeq === undefined) continue
    // Fork to one event before the evidence, clamped to 0.
    const forkSeq = Math.max(0, firstSeq - 1)
    if (seen.has(forkSeq)) continue
    seen.add(forkSeq)
    points.push({
      seq: forkSeq,
      rationale: `Forking here avoids the "${finding.headline}" that begins at seq ${firstSeq}.`,
      tryInstead: finding.suggestion,
    })
  }
  // Always offer the session midpoint as a last-resort fork.
  const mid = Math.floor(session.events.length / 2)
  if (!seen.has(mid) && session.events.length > 4) {
    points.push({
      seq: mid,
      rationale: `The session midpoint; useful when no single finding pinpoints the failure.`,
      tryInstead: `Review the first half of the session for context, then re-attempt the task with a clearer prompt.`,
    })
  }
  return points.slice(0, 5)
}

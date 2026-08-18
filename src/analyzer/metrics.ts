/**
 * Runtime metrics: performance monitoring, enhanced heatmap, and session
 * quality scoring.
 *
 * Three exports:
 * 1. computePerformanceMetrics — latency percentiles, token throughput
 * 2. enhanceHeatmap — adds errorRate + latency to each heatmap entry
 * 3. computeQualityScore — 0..100 score with weighted dimensions + grade
 *
 * @module dsh-tianshu-analyzer/analyzer/metrics
 */

import type {
  PerformanceMetrics,
  SessionQualityScore,
  QualityScoreBreakdown,
  ToolHeatmapEntry,
  Finding,
} from '../types.ts'
import type { AnalyzedSession } from './session-loader.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Average of an array of numbers; null when empty. */
function avg(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((s, v) => s + v, 0) / values.length
}

/** Percentile of a sorted-ascending copy of values; null when empty. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length))
  return sorted[idx]!
}

/** Clamp a value to [0, max]. */
function clamp(v: number, max: number): number {
  return Math.max(0, Math.min(max, v))
}

/** Build a seq → timestamp lookup from raw events. */
function buildSeqTimeMap(session: AnalyzedSession): Map<number, number> {
  const m = new Map<number, number>()
  for (const e of session.events) {
    if (typeof e.time === 'number') m.set(e.seq, e.time)
  }
  return m
}

// ---------------------------------------------------------------------------
// 1. Performance metrics
// ---------------------------------------------------------------------------

/**
 * Compute runtime performance metrics from event timestamps and token usage.
 *
 * Tool-call latency = time(tool/result) − time(tool/call), matched by
 * toolCallId. Turn latency = interval between consecutive turn/end events.
 * Token throughput = total tokens / session duration.
 */
export function computePerformanceMetrics(session: AnalyzedSession): PerformanceMetrics {
  const seqTime = buildSeqTimeMap(session)

  // --- Tool call latencies ---
  const callSeqById = new Map<string, number>()
  for (const { seq, data } of session.toolCalls) {
    if (data.toolCallId !== undefined) callSeqById.set(data.toolCallId, seq)
  }

  const toolLatencies: number[] = []
  for (const { data } of session.toolResults) {
    if (data.toolCallId === undefined) continue
    const callSeq = callSeqById.get(data.toolCallId)
    if (callSeq === undefined) continue
    const callTime = seqTime.get(callSeq)
    // The result's seq is on the event, but toolResults stores { seq, data }.
    // We need to look up the result event's time via its seq.
    const resultSeq = session.toolResults.find(r => r.data === data)?.seq
    if (resultSeq === undefined) continue
    const resultTime = seqTime.get(resultSeq)
    if (callTime === undefined || resultTime === undefined) continue
    const latency = resultTime - callTime
    if (latency >= 0) toolLatencies.push(latency)
  }

  // --- Turn latencies ---
  const turnEndTimes: number[] = []
  for (const turn of session.turns) {
    // turn/end events: find the event seq from the raw events list.
    // turns are extracted from events; we match by scanning events for turn/end.
  }
  // Simpler: collect timestamps of all turn/end events directly.
  for (const e of session.events) {
    if (e.type === 'turn/end' && typeof e.time === 'number') {
      turnEndTimes.push(e.time)
    }
  }
  const turnLatencies: number[] = []
  for (let i = 1; i < turnEndTimes.length; i++) {
    const d = turnEndTimes[i]! - turnEndTimes[i - 1]!
    if (d >= 0) turnLatencies.push(d)
  }

  // --- Duration ---
  const firstTime = session.events[0]?.time
  const lastTime = session.events[session.events.length - 1]?.time
  const durationMs = typeof firstTime === 'number' && typeof lastTime === 'number'
    ? lastTime - firstTime
    : null

  // --- Token throughput ---
  const totalInput = session.usageEvents.reduce((s, u) => s + (u.inputTokens ?? 0), 0)
  const totalOutput = session.usageEvents.reduce((s, u) => s + (u.outputTokens ?? 0), 0)
  const outputTokensPerSec = durationMs !== null && durationMs > 0
    ? (totalOutput / durationMs) * 1000
    : null
  const inputTokensPerSec = durationMs !== null && durationMs > 0
    ? (totalInput / durationMs) * 1000
    : null

  return {
    avgToolLatencyMs: avg(toolLatencies),
    maxToolLatencyMs: toolLatencies.length > 0 ? Math.max(...toolLatencies) : null,
    p50ToolLatencyMs: percentile(toolLatencies, 0.5),
    p95ToolLatencyMs: percentile(toolLatencies, 0.95),
    p99ToolLatencyMs: percentile(toolLatencies, 0.99),
    avgTurnLatencyMs: avg(turnLatencies),
    outputTokensPerSec,
    inputTokensPerSec,
    durationMs,
  }
}

// ---------------------------------------------------------------------------
// 2. Enhanced heatmap
// ---------------------------------------------------------------------------

/**
 * Enrich each base heatmap entry with errorRate, avgLatencyMs, and maxLatencyMs.
 *
 * The base entries (calls, errors, firstSeq, lastSeq) come from
 * `buildHeatmap` in rule-engine.ts. This function adds the latency fields
 * by pairing tool/call → tool/result by toolCallId and looking up event
 * timestamps.
 */
export function enhanceHeatmap(
  session: AnalyzedSession,
  base: readonly Omit<ToolHeatmapEntry, 'errorRate' | 'avgLatencyMs' | 'maxLatencyMs'>[],
): readonly ToolHeatmapEntry[] {
  const seqTime = buildSeqTimeMap(session)

  // Build per-tool-name latency lists.
  const callSeqById = new Map<string, number>()
  for (const { seq, data } of session.toolCalls) {
    if (data.toolCallId !== undefined) callSeqById.set(data.toolCallId, seq)
  }

  const latenciesByName = new Map<string, number[]>()
  for (const { seq, data } of session.toolResults) {
    if (data.toolCallId === undefined) continue
    const callSeq = callSeqById.get(data.toolCallId)
    if (callSeq === undefined) continue
    // Find the tool name from the matching call.
    const call = session.toolCalls.find(c => c.data.toolCallId === data.toolCallId)
    if (call?.data.name === undefined) continue
    const callTime = seqTime.get(callSeq)
    const resultTime = seqTime.get(seq)
    if (callTime === undefined || resultTime === undefined) continue
    const latency = resultTime - callTime
    if (latency < 0) continue
    const arr = latenciesByName.get(call.data.name) ?? []
    arr.push(latency)
    latenciesByName.set(call.data.name, arr)
  }

  return base.map((entry) => {
    const lats = latenciesByName.get(entry.name) ?? []
    return {
      ...entry,
      errorRate: entry.calls > 0 ? entry.errors / entry.calls : 0,
      avgLatencyMs: avg(lats),
      maxLatencyMs: lats.length > 0 ? Math.max(...lats) : null,
    }
  })
}

// ---------------------------------------------------------------------------
// 3. Session quality score
// ---------------------------------------------------------------------------

/** Weights for each quality dimension (must sum to 1.0). */
const QUALITY_WEIGHTS = {
  successRate: 0.35,
  toolReliability: 0.25,
  tokenEfficiency: 0.15,
  progress: 0.15,
  loopFree: 0.10,
} as const

/**
 * Compute a 0..100 session quality score from session stats and rule findings.
 *
 * Dimensions:
 * - successRate (35%): fraction of turns that did not end in error/aborted
 * - toolReliability (25%): 1 − (tool errors / tool calls)
 * - tokenEfficiency (15%): output/input token ratio (capped at 1.0)
 * - progress (15%): penalised by no-progress findings
 * - loopFree (10%): penalised by tool-error-loop / tool-result-loop findings
 */
export function computeQualityScore(
  session: AnalyzedSession,
  findings: readonly Finding[],
): SessionQualityScore {
  const { stats } = session

  // --- Success rate ---
  const errorTurns = session.turns.filter(
    t => t.reason.kind === 'error' || t.reason.kind === 'aborted',
  ).length
  const successRate = stats.totalTurns > 0
    ? clamp(((stats.totalTurns - errorTurns) / stats.totalTurns) * 100, 100)
    : 100

  // --- Tool reliability ---
  const toolReliability = stats.totalToolCalls > 0
    ? clamp((1 - stats.totalToolErrors / stats.totalToolCalls) * 100, 100)
    : 100

  // --- Token efficiency ---
  const ratio = stats.totalInputTokens > 0
    ? stats.totalOutputTokens / stats.totalInputTokens
    : 0
  const tokenEfficiency = clamp(ratio * 100, 100)

  // --- Progress: penalise for no-progress findings ---
  const noProgressCount = findings.filter(f => f.mode === 'no-progress').length
  const progress = clamp(100 - noProgressCount * 25, 100)

  // --- Loop-free: penalise for loop findings ---
  const loopCount = findings.filter(
    f => f.mode === 'tool-error-loop' || f.mode === 'tool-result-loop',
  ).length
  const loopFree = clamp(100 - loopCount * 30, 100)

  const breakdown: QualityScoreBreakdown = {
    successRate: Math.round(successRate),
    toolReliability: Math.round(toolReliability),
    tokenEfficiency: Math.round(tokenEfficiency),
    progress: Math.round(progress),
    loopFree: Math.round(loopFree),
  }

  const score = Math.round(
    breakdown.successRate * QUALITY_WEIGHTS.successRate
    + breakdown.toolReliability * QUALITY_WEIGHTS.toolReliability
    + breakdown.tokenEfficiency * QUALITY_WEIGHTS.tokenEfficiency
    + breakdown.progress * QUALITY_WEIGHTS.progress
    + breakdown.loopFree * QUALITY_WEIGHTS.loopFree,
  )

  const grade = scoreToGrade(score)
  const summary = buildSummary(score, grade, breakdown)

  return { score, grade, breakdown, summary }
}

/** Map a 0..100 score to a letter grade. */
function scoreToGrade(score: number): SessionQualityScore['grade'] {
  if (score >= 90) return 'A'
  if (score >= 75) return 'B'
  if (score >= 60) return 'C'
  if (score >= 40) return 'D'
  return 'F'
}

/** Build a one-line human-readable summary of the score. */
function buildSummary(
  score: number,
  grade: string,
  b: QualityScoreBreakdown,
): string {
  const weakest = Object.entries(b).sort(([, a], [, v]) => a - v)[0]
  const weakestLabel: Record<string, string> = {
    successRate: 'turn success rate',
    toolReliability: 'tool reliability',
    tokenEfficiency: 'token efficiency',
    progress: 'progress',
    loopFree: 'loop freedom',
  }
  return `Grade ${grade} (${score}/100) — weakest dimension: ${weakestLabel[weakest[0]] ?? weakest[0]} at ${weakest[1]}/100`
}

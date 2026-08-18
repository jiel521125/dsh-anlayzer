/**
 * TianShu (天枢) — core type vocabulary for failure root-cause analysis.
 *
 * @module dsh-tianshu-analyzer/types
 */

// ---------------------------------------------------------------------------
// Session-event shape (defensive: the canonical types live in @deepseek-ai/dsh-session,
// but we narrow at runtime so the analyzer never crashes on an unknown event variant).
// ---------------------------------------------------------------------------

/** The structural minimum every session event carries. */
export interface SessionEvent {
  readonly type: string
  readonly seq: number
  readonly time?: number
  readonly data?: unknown
}

/** A `{ kind }` finish/reason union member, narrowed loosely. */
export interface ReasonPayload {
  readonly kind: string
  readonly failure?: {
    readonly message: string
    readonly code: string
    readonly status?: number
  }
}

/** Turn-end event data: `{ turn, reason }`. */
export interface TurnEndData {
  readonly turn: number
  readonly reason: ReasonPayload
}

/** A content block inside an assistant/user message. */
export interface ContentBlockLike {
  readonly type: string
  readonly text?: string
  readonly name?: string
  readonly arguments?: string
  readonly toolCallId?: string
  readonly content?: readonly ContentBlockLike[]
  readonly isError?: boolean
}

/** A message stored in the session log. */
export interface MessageLike {
  readonly role: 'user' | 'assistant' | 'system' | 'tool'
  readonly content?: readonly ContentBlockLike[]
  readonly source?: {
    readonly kind: string
    readonly provider?: string
    readonly model?: string
  }
}

/** Message event data shared by `user/message` and `assistant/message`. */
export interface MessageEventData {
  readonly message?: MessageLike
}

/** Tool-call event data. */
export interface ToolCallData {
  readonly toolCallId?: string
  readonly name?: string
  readonly arguments?: string
}

/** Tool-result event data. */
export interface ToolResultData {
  readonly toolCallId?: string
  readonly content?: readonly ContentBlockLike[]
  readonly isError?: boolean
}

/** Token usage carried by an assistant/message or usage event. */
export interface TokenUsageLike {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}

// ---------------------------------------------------------------------------
// Analysis output
// ---------------------------------------------------------------------------

/** Stable identifiers for every failure mode the rule engine can detect. */
export type FailureModeId =
  | 'tool-error-loop'
  | 'tool-result-loop'
  | 'max-tokens-truncated'
  | 'sandbox-denied'
  | 'approval-blocked'
  | 'llm-error'
  | 'llm-aborted'
  | 'prompt-injection-signal'
  | 'token-burn'
  | 'no-progress'

/** Severity bucket: how much this finding contributed to the failed outcome. */
export type Severity = 'critical' | 'major' | 'minor'

/** One rule-engine finding: a single detected failure signal with its evidence. */
export interface Finding {
  /** The failure mode this finding reports. */
  readonly mode: FailureModeId
  /** One-line human-readable headline (what happened). */
  readonly headline: string
  /** Detailed explanation (why this is a failure signal). */
  readonly detail: string
  /** How much this contributed to the failed outcome. */
  readonly severity: Severity
  /** Session-event seqs that are the evidence for this finding. */
  readonly evidenceSeqs: readonly number[]
  /** A concrete, actionable fix suggestion. */
  readonly suggestion: string
}

/** A tool-call heat-map entry: how often a tool was called and how often it erred. */
export interface ToolHeatmapEntry {
  readonly name: string
  readonly calls: number
  readonly errors: number
  /** Seqs of the first and last call to this tool. */
  readonly firstSeq: number
  readonly lastSeq: number
}

/** A recommended fork point: a seq the user can rewind to for a clean retry. */
export interface ForkPoint {
  /** The seq to fork from. */
  readonly seq: number
  /** Why this seq is a good fork candidate. */
  readonly rationale: string
  /** What to try differently after forking. */
  readonly tryInstead: string
}

/** The model route used by the session (reused for the diagnostic LLM call). */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** Aggregate statistics over the analyzed session. */
export interface SessionStats {
  readonly totalEvents: number
  readonly totalTurns: number
  readonly totalToolCalls: number
  readonly totalToolErrors: number
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly durationMs: number | null
}

/** The full diagnosis produced by one analysis run. */
export interface DiagnosisReport {
  /** Session id that was analyzed. */
  readonly sessionId: string
  /** ISO timestamp of the analysis. */
  readonly analyzedAt: string
  /** The turn/end reason that triggered analysis, if any. */
  readonly triggerReason: string | null
  /** Model route the session used (and the diagnostic call reused). */
  readonly route: ModelRoute | null
  /** Aggregate session stats. */
  readonly stats: SessionStats
  /** Every finding the rule engine produced, ordered by severity then seq. */
  readonly findings: readonly Finding[]
  /** Per-tool call/error heat map. */
  readonly heatmap: readonly ToolHeatmapEntry[]
  /** Recommended fork points, best first. */
  readonly forkPoints: readonly ForkPoint[]
  /** Natural-language deep-dive from the LLM, when enabled. */
  readonly llmDiagnosis: string | null
  /** The LLM diagnosis failure reason, when the call itself failed. */
  readonly llmDiagnosisError: string | null
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Per-rule threshold config. */
export interface RuleConfig {
  readonly enabled: boolean
  readonly threshold?: number
  readonly inputThreshold?: number
  readonly outputThreshold?: number
  readonly windowSteps?: number
}

/** Full plugin config (validated from the cordis.patch.yml overlay). */
export interface TianShuConfig {
  readonly autoTrigger: boolean
  readonly autoTriggerReasons: readonly string[]
  readonly llmDiagnose: boolean
  readonly llmMaxTokens: number
  readonly llmTimeoutMs: number
  readonly provider?: string
  readonly model?: string
  readonly reportDir: string | null
  readonly keepReports: number
  readonly rules: Readonly<Record<string, RuleConfig>>
}

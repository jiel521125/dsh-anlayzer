/**
 * Session-event loading and normalization.
 *
 * Pulls events from `ctx.sessionQuery` (preferred, works for live AND persisted
 * sessions) or falls back to the live `session.events` array when the query
 * service is unavailable. The output is a typed {@link AnalyzedSession} the
 * rule engine and LLM diagnoser consume.
 *
 * @module dsh-tianshu-analyzer/analyzer/session-loader
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  SessionEvent,
  TurnEndData,
  MessageLike,
  MessageEventData,
  ToolCallData,
  ToolResultData,
  TokenUsageLike,
  ModelRoute,
  SessionStats,
} from '../types.ts'

/** A loaded session ready for analysis: header + events + pre-derived facts. */
export interface AnalyzedSession {
  readonly sessionId: string
  readonly events: readonly SessionEvent[]
  readonly turns: readonly TurnEndData[]
  readonly lastTurnEnd: TurnEndData | null
  readonly messages: readonly { seq: number; message: MessageLike }[]
  readonly toolCalls: readonly { seq: number; data: ToolCallData }[]
  readonly toolResults: readonly { seq: number; data: ToolResultData }[]
  readonly assistantSources: readonly { provider: string; model: string }[]
  readonly usageEvents: readonly TokenUsageLike[]
  readonly route: ModelRoute | null
  readonly stats: SessionStats
}

/** Type guard: is this event a turn/end? */
export function isTurnEnd(event: SessionEvent): event is SessionEvent & { data: TurnEndData } {
  return event.type === 'turn/end' && event.data !== undefined
}

/** Type guard: is this event a user/message or assistant/message? */
export function isMessageEvent(event: SessionEvent): event is SessionEvent & { data: MessageEventData } {
  return (event.type === 'user/message' || event.type === 'assistant/message')
    && event.data !== undefined
}

/** Type guard: is this event a tool/call? */
export function isToolCall(event: SessionEvent): event is SessionEvent & { data: ToolCallData } {
  return event.type === 'tool/call' && event.data !== undefined
}

/** Type guard: is this event a tool/result? */
export function isToolResult(event: SessionEvent): event is SessionEvent & { data: ToolResultData } {
  return event.type === 'tool/result' && event.data !== undefined
}

/** Extract a MessageLike from a message event (defensive against shape drift). */
function extractMessage(data: MessageEventData): MessageLike | null {
  if (data.message !== undefined) return data.message
  // Some variants store the message at the event root after a fold; tolerate both.
  if (typeof (data as { role?: unknown }).role === 'string') return data as unknown as MessageLike
  return null
}

/** Load a session by id via ctx.sessionQuery, falling back to live sessions. */
export async function loadSession(
  ctx: Context,
  sessionId: string,
): Promise<AnalyzedSession | null> {
  let events: readonly SessionEvent[]

  // Preferred: the session-query service reads both live and persisted logs.
  const hasQuery = (ctx as Context & { sessionQuery?: unknown }).sessionQuery !== undefined
  if (hasQuery) {
    try {
      const sq = (ctx as unknown as {
        sessionQuery: {
          readSession(id: string): Promise<{ events: readonly SessionEvent[] }>
        }
      }).sessionQuery
      const snapshot = await sq.readSession(sessionId)
      events = snapshot.events
    } catch {
      events = liveEvents(ctx, sessionId) ?? []
    }
  } else {
    events = liveEvents(ctx, sessionId) ?? []
  }

  if (events.length === 0) return null
  return prepareSession(sessionId, events)
}

/** Read events from the in-memory live session registry. */
function liveEvents(ctx: Context, sessionId: string): readonly SessionEvent[] | null {
  const sessions = (ctx as unknown as {
    sessions?: {
      get?(id: string): { events?: readonly SessionEvent[] } | undefined
    }
  }).sessions
  const session = sessions?.get?.(sessionId)
  return session?.events ?? null
}

/** Fold raw events into the pre-derived shape the analyzers consume. */
export function prepareSession(sessionId: string, events: readonly SessionEvent[]): AnalyzedSession {
  const turns: TurnEndData[] = []
  const messages: { seq: number; message: MessageLike }[] = []
  const toolCalls: { seq: number; data: ToolCallData }[] = []
  const toolResults: { seq: number; data: ToolResultData }[] = []
  const assistantSources: { provider: string; model: string }[] = []
  const usageEvents: TokenUsageLike[] = []

  for (const event of events) {
    if (isTurnEnd(event)) {
      turns.push(event.data)
    } else if (isMessageEvent(event)) {
      const msg = extractMessage(event.data)
      if (msg !== null) {
        messages.push({ seq: event.seq, message: msg })
        if (msg.source?.kind === 'model'
          && typeof msg.source.provider === 'string'
          && typeof msg.source.model === 'string') {
          assistantSources.push({ provider: msg.source.provider, model: msg.source.model })
        }
        // Token usage may ride on assistant messages or a dedicated usage field.
        const usage = (event.data as unknown as { usage?: TokenUsageLike }).usage
        if (usage !== undefined) usageEvents.push(usage)
      }
    } else if (isToolCall(event)) {
      toolCalls.push({ seq: event.seq, data: event.data })
    } else if (isToolResult(event)) {
      toolResults.push({ seq: event.seq, data: event.data })
    } else if (event.type === 'usage' && event.data !== undefined) {
      usageEvents.push(event.data as TokenUsageLike)
    }
  }

  const route = assistantSources.at(-1) ?? null
  const lastTurnEnd = turns.at(-1) ?? null

  return {
    sessionId,
    events,
    turns,
    lastTurnEnd,
    messages,
    toolCalls,
    toolResults,
    assistantSources,
    usageEvents,
    route,
    stats: computeStats(events, turns, toolCalls, toolResults, usageEvents),
  }
}

/** Derive aggregate stats from the folded events. */
function computeStats(
  events: readonly SessionEvent[],
  turns: readonly TurnEndData[],
  toolCalls: readonly { seq: number; data: ToolCallData }[],
  toolResults: readonly { seq: number; data: ToolResultData }[],
  usageEvents: readonly TokenUsageLike[],
): SessionStats {
  const totalToolErrors = toolResults.filter(r => r.data.isError === true).length
  const totalInputTokens = usageEvents.reduce((sum, u) => sum + (u.inputTokens ?? 0), 0)
  const totalOutputTokens = usageEvents.reduce((sum, u) => sum + (u.outputTokens ?? 0), 0)

  const firstTime = events[0]?.time
  const lastTime = events[events.length - 1]?.time
  const durationMs = typeof firstTime === 'number' && typeof lastTime === 'number'
    ? lastTime - firstTime
    : null

  return {
    totalEvents: events.length,
    totalTurns: turns.length,
    totalToolCalls: toolCalls.length,
    totalToolErrors,
    totalInputTokens,
    totalOutputTokens,
    durationMs,
  }
}

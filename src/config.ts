/**
 * TianShu config schema and validation.
 *
 * @module dsh-tianshu-analyzer/config
 */

import type { TianShuConfig, RuleConfig } from './types.ts'

/** Default config applied when a key is absent from the patch overlay. */
export const DEFAULT_CONFIG: TianShuConfig = {
  autoTrigger: true,
  autoTriggerReasons: ['error', 'blocked', 'interrupted', 'aborted'],
  llmDiagnose: true,
  llmMaxTokens: 2048,
  llmTimeoutMs: 30_000,
  reportDir: null,
  keepReports: 50,
  rules: {
    'tool-error-loop': { enabled: true, threshold: 3 },
    'tool-result-loop': { enabled: true, threshold: 3 },
    'max-tokens-truncated': { enabled: true },
    'sandbox-denied': { enabled: true },
    'approval-blocked': { enabled: true },
    'llm-error': { enabled: true },
    'llm-aborted': { enabled: true },
    'prompt-injection-signal': { enabled: true },
    'token-burn': { enabled: true, inputThreshold: 50_000, outputThreshold: 100 },
    'no-progress': { enabled: true, windowSteps: 5 },
  },
}

/** Coerce an untrusted config object into a validated {@link TianShuConfig}. */
export function resolveConfig(input: unknown): TianShuConfig {
  if (input === null || typeof input !== 'object') return DEFAULT_CONFIG
  const raw = input as Record<string, unknown>

  const rules: Record<string, RuleConfig> = { ...DEFAULT_CONFIG.rules }
  if (raw.rules !== null && typeof raw.rules === 'object') {
    for (const [key, value] of Object.entries(raw.rules as Record<string, unknown>)) {
      if (value === null || typeof value !== 'object') continue
      const r = value as Record<string, unknown>
      rules[key] = {
        enabled: r.enabled !== false,
        ...(typeof r.threshold === 'number' ? { threshold: r.threshold } : {}),
        ...(typeof r.inputThreshold === 'number' ? { inputThreshold: r.inputThreshold } : {}),
        ...(typeof r.outputThreshold === 'number' ? { outputThreshold: r.outputThreshold } : {}),
        ...(typeof r.windowSteps === 'number' ? { windowSteps: r.windowSteps } : {}),
      }
    }
  }

  return {
    autoTrigger: raw.autoTrigger !== false,
    autoTriggerReasons: Array.isArray(raw.autoTriggerReasons)
      ? (raw.autoTriggerReasons as unknown[]).filter((v): v is string => typeof v === 'string')
      : DEFAULT_CONFIG.autoTriggerReasons,
    llmDiagnose: raw.llmDiagnose !== false,
    llmMaxTokens: typeof raw.llmMaxTokens === 'number' && raw.llmMaxTokens > 0
      ? raw.llmMaxTokens
      : DEFAULT_CONFIG.llmMaxTokens,
    llmTimeoutMs: typeof raw.llmTimeoutMs === 'number' && raw.llmTimeoutMs > 0
      ? raw.llmTimeoutMs
      : DEFAULT_CONFIG.llmTimeoutMs,
    ...(typeof raw.provider === 'string' && raw.provider.length > 0 ? { provider: raw.provider } : {}),
    ...(typeof raw.model === 'string' && raw.model.length > 0 ? { model: raw.model } : {}),
    reportDir: typeof raw.reportDir === 'string' && raw.reportDir.length > 0
      ? raw.reportDir
      : null,
    keepReports: typeof raw.keepReports === 'number' && raw.keepReports > 0
      ? Math.floor(raw.keepReports)
      : DEFAULT_CONFIG.keepReports,
    rules,
  }
}

/** Look up a rule config by id, defaulting to disabled when absent. */
export function ruleConfig(config: TianShuConfig, id: string): RuleConfig {
  return config.rules[id] ?? { enabled: false }
}

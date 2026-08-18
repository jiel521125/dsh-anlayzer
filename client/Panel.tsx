/**
 * The TianShu diagnosis panel: runs analysis, renders findings, heatmap,
 * fork points, and the LLM deep diagnosis.
 *
 * @module dsh-tianshu-analyzer/client/Panel
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import type { TianShuPanelApi, DiagnosisReportLike } from './index.ts'

export interface TianShuPanelInjected {
  readonly api: TianShuPanelApi | undefined
}

export interface TianShuPanelProps {
  readonly sessionId: string
  readonly api: TianShuPanelApi | undefined
  readonly onClose: () => void
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; report: DiagnosisReportLike }
  | { kind: 'error'; message: string }

const SEVERITY_COLOR: Readonly<Record<string, string>> = {
  critical: '#dc2626',
  major: '#ea580c',
  minor: '#ca8a04',
}

export function TianShuPanel({ sessionId, api, onClose }: TianShuPanelProps): ReactNode {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [useLlm, setUseLlm] = useState(true)

  const run = useCallback(async () => {
    if (api === undefined) {
      setState({ kind: 'error', message: 'TianShu API is not available (host plugin not loaded).' })
      return
    }
    setState({ kind: 'loading' })
    try {
      const report = await api.analyze(sessionId, useLlm)
      setState({ kind: 'ready', report })
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [api, sessionId, useLlm])

  // Auto-run once on open if the host already has a cached report.
  useEffect(() => {
    void (async () => {
      if (api === undefined) return
      try {
        const cached = await api.getReport(sessionId)
        if (cached !== null) setState({ kind: 'ready', report: cached })
        else void run()
      } catch {
        void run()
      }
    })()
  }, [api, sessionId, run])

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={panelStyle} onClick={(e) => { e.stopPropagation() }}>
        <div style={headerStyle}>
          <h2 style={{ margin: 0, fontSize: '16px' }}>⚕︎ TianShu — Failure Diagnosis</h2>
          <button type="button" onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        <div style={toolbarStyle}>
          <label style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <input type="checkbox" checked={useLlm} onChange={(e) => { setUseLlm(e.target.checked) }} />
            LLM deep diagnosis
          </label>
          <button
            type="button"
            onClick={() => { void run() }}
            disabled={state.kind === 'loading'}
            style={runBtnStyle}
          >
            {state.kind === 'loading' ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>

        <div style={bodyStyle}>
          {state.kind === 'idle' && <p style={muted}>Click "Analyze" to diagnose this session.</p>}
          {state.kind === 'loading' && <p style={muted}>Analyzing session…</p>}
          {state.kind === 'error' && <p style={{ color: '#dc2626' }}>Analysis failed: {state.message}</p>}
          {state.kind === 'ready' && <ReportView report={state.report} api={api} sessionId={sessionId} />}
        </div>
      </div>
    </div>
  )
}

function ReportView({ report, api, sessionId }: { report: DiagnosisReportLike; api: TianShuPanelApi | undefined; sessionId: string }): ReactNode {
  return (
    <>
      <QualityScoreBar quality={report.quality} />
      <StatsBar report={report} />
      <Section title={`Findings (${report.findings.length})`}>
        {report.findings.length === 0
          ? <p style={muted}>No failure patterns detected by the rule engine.</p>
          : report.findings.map((f, i) => (
            <div key={i} style={findingStyle(f.severity)}>
              <div style={{ fontWeight: 600 }}>
                <span style={{ color: SEVERITY_COLOR[f.severity] ?? '#666' }}>●</span>{' '}
                [{f.severity}] {f.mode} — {f.headline}
              </div>
              <p style={{ margin: '4px 0', fontSize: '13px', color: '#555' }}>{f.detail}</p>
              {f.evidenceSeqs.length > 0 && (
                <p style={{ margin: '2px 0', fontSize: '12px', color: '#888' }}>
                  evidence: seqs {f.evidenceSeqs.join(', ')}
                </p>
              )}
              <p style={{ margin: '4px 0 0', fontSize: '13px' }}>
                <strong>Fix:</strong> {f.suggestion}
              </p>
            </div>
          ))
        }
      </Section>

      {report.heatmap.length > 0 && (
        <Section title="Tool call heat map">
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>tool</th>
                <th style={thStyle}>calls</th>
                <th style={thStyle}>errors</th>
                <th style={thStyle}>err%</th>
                <th style={thStyle}>avg ms</th>
                <th style={thStyle}>max ms</th>
                <th style={thStyle}>first</th>
                <th style={thStyle}>last</th>
              </tr>
            </thead>
            <tbody>
              {report.heatmap.map((h) => (
                <tr key={h.name}>
                  <td style={tdStyle}><code>{h.name}</code></td>
                  <td style={tdStyle}>{h.calls}</td>
                  <td style={{ ...tdStyle, color: h.errors > 0 ? '#dc2626' : '#666' }}>{h.errors}</td>
                  <td style={{ ...tdStyle, color: h.errorRate > 0.3 ? '#dc2626' : '#666' }}>
                    {(h.errorRate * 100).toFixed(0)}%
                  </td>
                  <td style={tdStyle}>{h.avgLatencyMs !== null ? formatMs(h.avgLatencyMs) : '—'}</td>
                  <td style={tdStyle}>{h.maxLatencyMs !== null ? formatMs(h.maxLatencyMs) : '—'}</td>
                  <td style={tdStyle}>{h.firstSeq}</td>
                  <td style={tdStyle}>{h.lastSeq}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      <PerformanceView perf={report.performance} />

      {report.forkPoints.length > 0 && (
        <Section title="Recommended fork points">
          {report.forkPoints.map((fp, i) => (
            <div key={i} style={forkStyle}>
              <div style={{ fontWeight: 600 }}>Fork at seq {fp.seq}</div>
              <p style={{ margin: '2px 0', fontSize: '13px', color: '#555' }}>{fp.rationale}</p>
              <p style={{ margin: '2px 0 0', fontSize: '13px' }}><strong>Try:</strong> {fp.tryInstead}</p>
            </div>
          ))}
        </Section>
      )}

      {report.llmDiagnosis !== null && (
        <Section title="LLM deep diagnosis">
          <pre style={preStyle}>{report.llmDiagnosis}</pre>
        </Section>
      )}
      {report.llmDiagnosisError !== null && (
        <Section title="LLM deep diagnosis">
          <p style={{ color: '#888', fontSize: '13px' }}>
            LLM diagnosis was enabled but failed: {report.llmDiagnosisError}
          </p>
        </Section>
      )}

      {api !== undefined && (
        <div style={{ marginTop: '12px', textAlign: 'right' }}>
          <button
            type="button"
            onClick={() => { void downloadMarkdown(api, sessionId) }}
            style={downloadBtnStyle}
          >
            Download Markdown
          </button>
        </div>
      )}
    </>
  )
}

function StatsBar({ report }: { report: DiagnosisReportLike }): ReactNode {
  const s = report.stats
  return (
    <div style={statsStyle}>
      <span>{s.totalEvents} events</span>
      <span>·</span>
      <span>{s.totalTurns} turns</span>
      <span>·</span>
      <span>{s.totalToolCalls} tool calls ({s.totalToolErrors} errors)</span>
      <span>·</span>
      <span>{s.totalInputTokens} in / {s.totalOutputTokens} out tokens</span>
      {report.route !== null && (
        <>
          <span>·</span>
          <span><code>{report.route.provider}/{report.route.model}</code></span>
        </>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div style={{ marginTop: '12px' }}>
      <h3 style={sectionTitleStyle}>{title}</h3>
      {children}
    </div>
  )
}

const GRADE_COLOR: Readonly<Record<string, string>> = {
  A: '#16a34a', B: '#ca8a04', C: '#ea580c', D: '#dc2626', F: '#7f1d1d',
}

function QualityScoreBar({ quality }: { quality: DiagnosisReportLike['quality'] }): ReactNode {
  const color = GRADE_COLOR[quality.grade] ?? '#666'
  const b = quality.breakdown
  return (
    <div style={{ ...qualityStyle, borderColor: color }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span style={{ fontSize: '22px', fontWeight: 700, color }}>{quality.grade}</span>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>{quality.score}/100</div>
          <div style={{ fontSize: '11px', color: '#888' }}>{quality.summary}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', fontSize: '11px', color: '#666' }}>
        <span>success {b.successRate}</span>
        <span>·</span>
        <span>tools {b.toolReliability}</span>
        <span>·</span>
        <span>tokens {b.tokenEfficiency}</span>
        <span>·</span>
        <span>progress {b.progress}</span>
        <span>·</span>
        <span>loops {b.loopFree}</span>
      </div>
    </div>
  )
}

function PerformanceView({ perf }: { perf: DiagnosisReportLike['performance'] }): ReactNode {
  const fmt = (v: number | null): string => v !== null ? formatMs(v) : '—'
  const tps = (v: number | null): string => v !== null ? v.toFixed(1) : '—'
  return (
    <Section title="⏱ Runtime Performance">
      <div style={perfGridStyle}>
        <Metric label="duration" value={perf.durationMs !== null ? formatMs(perf.durationMs) : '—'} />
        <Metric label="avg tool latency" value={fmt(perf.avgToolLatencyMs)} />
        <Metric label="max tool latency" value={fmt(perf.maxToolLatencyMs)} />
        <Metric label="p50 latency" value={fmt(perf.p50ToolLatencyMs)} />
        <Metric label="p95 latency" value={fmt(perf.p95ToolLatencyMs)} />
        <Metric label="p99 latency" value={fmt(perf.p99ToolLatencyMs)} />
        <Metric label="avg turn latency" value={fmt(perf.avgTurnLatencyMs)} />
        <Metric label="input tok/s" value={tps(perf.inputTokensPerSec)} />
        <Metric label="output tok/s" value={tps(perf.outputTokensPerSec)} />
      </div>
    </Section>
  )
}

function Metric({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div style={metricStyle}>
      <div style={{ fontSize: '11px', color: '#888' }}>{label}</div>
      <div style={{ fontSize: '14px', fontWeight: 600 }}>{value}</div>
    </div>
  )
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

async function downloadMarkdown(api: TianShuPanelApi, sessionId: string): Promise<void> {
  const md = await api.readMarkdown(sessionId)
  if (md === null) return
  const blob = new Blob([md], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `tianshu-${sessionId}.md`
  a.click()
  URL.revokeObjectURL(url)
}

// --- styles ---
const overlayStyle: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center',
  justifyContent: 'center', zIndex: 1000,
}
const panelStyle: React.CSSProperties = {
  background: 'var(--dsh-bg, #fff)', color: 'var(--dsh-text, #222)',
  borderRadius: '10px', width: 'min(720px, 92vw)', maxHeight: '85vh',
  display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
}
const headerStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '12px 16px', borderBottom: '1px solid var(--dsh-border, #eee)',
}
const closeBtnStyle: React.CSSProperties = {
  border: 'none', background: 'transparent', fontSize: '16px', cursor: 'pointer', color: '#888',
}
const toolbarStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '8px 16px', borderBottom: '1px solid var(--dsh-border, #eee)',
}
const runBtnStyle: React.CSSProperties = {
  padding: '4px 12px', borderRadius: '6px', border: '1px solid var(--dsh-border, #ccc)',
  background: 'var(--dsh-accent, #2563eb)', color: '#fff', cursor: 'pointer', fontSize: '13px',
}
const bodyStyle: React.CSSProperties = { padding: '16px', overflowY: 'auto', flex: 1 }
const muted: React.CSSProperties = { color: '#888', fontSize: '14px' }
const sectionTitleStyle: React.CSSProperties = {
  margin: '0 0 8px', fontSize: '14px', fontWeight: 600, color: '#444',
}
const statsStyle: React.CSSProperties = {
  display: 'flex', gap: '6px', flexWrap: 'wrap', fontSize: '12px', color: '#666',
  padding: '8px', background: 'var(--dsh-bg-alt, #f7f7f7)', borderRadius: '6px',
}
const findingStyle = (sev: string): React.CSSProperties => ({
  padding: '8px', marginBottom: '8px', borderRadius: '6px',
  borderLeft: `3px solid ${SEVERITY_COLOR[sev] ?? '#ccc'}`,
  background: 'var(--dsh-bg-alt, #fafafa)',
})
const forkStyle: React.CSSProperties = {
  padding: '8px', marginBottom: '8px', borderRadius: '6px',
  background: 'var(--dsh-bg-alt, #f0f7ff)',
}
const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: '13px',
}
const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #ddd', fontWeight: 600,
}
const tdStyle: React.CSSProperties = { padding: '4px 8px', borderBottom: '1px solid #eee' }
const preStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13px',
  background: 'var(--dsh-bg-alt, #f7f7f7)', padding: '12px', borderRadius: '6px',
  margin: 0,
}
const downloadBtnStyle: React.CSSProperties = {
  padding: '4px 12px', borderRadius: '6px', border: '1px solid var(--dsh-border, #ccc)',
  background: 'transparent', cursor: 'pointer', fontSize: '13px',
}
const qualityStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  flexWrap: 'wrap', gap: '6px', padding: '10px 12px', marginBottom: '8px',
  borderRadius: '8px', border: '2px solid #ccc', background: 'var(--dsh-bg-alt, #f9f9f9)',
}
const perfGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px',
}
const metricStyle: React.CSSProperties = {
  padding: '6px 8px', borderRadius: '6px', background: 'var(--dsh-bg-alt, #f7f7f7)',
  textAlign: 'center',
}

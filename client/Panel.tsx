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
                <th style={thStyle}>first seq</th>
                <th style={thStyle}>last seq</th>
              </tr>
            </thead>
            <tbody>
              {report.heatmap.map((h) => (
                <tr key={h.name}>
                  <td style={tdStyle}><code>{h.name}</code></td>
                  <td style={tdStyle}>{h.calls}</td>
                  <td style={{ ...tdStyle, color: h.errors > 0 ? '#dc2626' : '#666' }}>{h.errors}</td>
                  <td style={tdStyle}>{h.firstSeq}</td>
                  <td style={tdStyle}>{h.lastSeq}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

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

/**
 * Report store: persist Markdown reports to disk and keep an in-memory cache
 * for the Web UI to read via the client RPC bridge.
 *
 * @module dsh-tianshu-analyzer/report/store
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DiagnosisReport } from '../types.ts'
import { renderMarkdown } from './markdown.ts'

/** Resolve the report directory: explicit config, else ~/.dsh/tianshu-reports. */
export function resolveReportDir(configured: string | null): string {
  if (configured !== null && configured.length > 0) return resolve(configured)
  return join(homedir(), '.dsh', 'tianshu-reports')
}

/** A stored report entry the UI can list. */
export interface StoredReport {
  readonly id: string
  readonly sessionId: string
  readonly analyzedAt: string
  readonly triggerReason: string | null
  readonly findingsCount: number
  readonly filePath: string | null
}

/** In-memory + on-disk report store. */
export class ReportStore {
  private readonly cache = new Map<string, DiagnosisReport>()
  private readonly dir: string
  private readonly keep: number

  constructor(dir: string, keep: number) {
    this.dir = dir
    this.keep = keep
  }

  /** Persist a report to disk (if a dir is writable) and cache it in memory. */
  async save(report: DiagnosisReport): Promise<StoredReport> {
    this.cache.set(report.sessionId, report)
    let filePath: string | null = null
    try {
      await mkdir(this.dir, { recursive: true })
      const stamp = report.analyzedAt.replace(/[:.]/g, '-')
      const name = `${report.sessionId}-${stamp}.md`
      filePath = join(this.dir, name)
      await writeFile(filePath, renderMarkdown(report), 'utf8')
      await this.prune()
    } catch {
      // Disk is best-effort; the in-memory cache still serves the UI.
      filePath = null
    }
    return {
      id: report.sessionId,
      sessionId: report.sessionId,
      analyzedAt: report.analyzedAt,
      triggerReason: report.triggerReason,
      findingsCount: report.findings.length,
      filePath,
    }
  }

  /** Get a cached report (memory only — the UI reads from here). */
  get(sessionId: string): DiagnosisReport | undefined {
    return this.cache.get(sessionId)
  }

  /** List all on-disk reports (newest first). */
  async list(): Promise<StoredReport[]> {
    const entries = await readdir(this.dir).catch(() => [] as string[])
    const results: StoredReport[] = []
    for (const name of entries) {
      if (!name.endsWith('.md')) continue
      const match = /^(.+)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.md$/.exec(name)
      const sessionId = match?.[1] ?? name.replace(/\.md$/, '')
      const analyzedAt = match?.[2]?.replace(/-(\d{2})-(\d{2})$/, ':$1:$2') ?? ''
      results.push({
        id: sessionId,
        sessionId,
        analyzedAt,
        triggerReason: null,
        findingsCount: 0,
        filePath: join(this.dir, name),
      })
    }
    return results.sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt))
  }

  /** Read a report's Markdown from disk. */
  async readMarkdown(sessionId: string): Promise<string | null> {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) return renderMarkdown(cached)
    const entries = await readdir(this.dir).catch(() => [] as string[])
    const name = entries.find(n => n.startsWith(`${sessionId}-`))
    if (name === undefined) return null
    return readFile(join(this.dir, name), 'utf8')
  }

  /** Prune old reports beyond the keep limit. */
  private async prune(): Promise<void> {
    if (this.keep <= 0) return
    const entries = await readdir(this.dir).catch(() => [] as string[])
    const mdFiles = entries.filter(n => n.endsWith('.md')).sort().reverse()
    const stale = mdFiles.slice(this.keep)
    if (stale.length === 0) return
    await Promise.all(stale.map(n => unlink(join(this.dir, n)).catch(() => {})))
  }
}

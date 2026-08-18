/**
 * TianShu locale strings.
 *
 * @module dsh-tianshu-analyzer/client/locales
 */

export const NS = 'tianshu-analyzer' as const

export type TianShuLocaleKey =
  | 'action.diagnose'
  | 'action.reanalyze'
  | 'action.download'
  | 'panel.title'
  | 'panel.loading'
  | 'panel.empty'
  | 'panel.error'
  | 'panel.noFindings'
  | 'panel.findings'
  | 'panel.heatmap'
  | 'panel.forkPoints'
  | 'panel.llmDiagnosis'
  | 'panel.stats'
  | 'panel.useLlm'
  | 'severity.critical'
  | 'severity.major'
  | 'severity.minor'

export const en: Readonly<Record<TianShuLocaleKey, string>> = {
  'action.diagnose': 'Diagnose failure',
  'action.reanalyze': 'Re-analyze',
  'action.download': 'Download Markdown',
  'panel.title': 'TianShu Failure Diagnosis',
  'panel.loading': 'Analyzing session…',
  'panel.empty': 'No diagnosis yet. Click "Diagnose failure" to analyze this session.',
  'panel.error': 'Analysis failed:',
  'panel.noFindings': 'No failure patterns detected by the rule engine.',
  'panel.findings': 'Findings',
  'panel.heatmap': 'Tool call heat map',
  'panel.forkPoints': 'Recommended fork points',
  'panel.llmDiagnosis': 'LLM deep diagnosis',
  'panel.stats': 'Session stats',
  'panel.useLlm': 'Enable LLM deep diagnosis',
  'severity.critical': 'Critical',
  'severity.major': 'Major',
  'severity.minor': 'Minor',
}

export const zh: Readonly<Record<TianShuLocaleKey, string>> = {
  'action.diagnose': '诊断失败',
  'action.reanalyze': '重新分析',
  'action.download': '下载 Markdown',
  'panel.title': '天枢失败诊断',
  'panel.loading': '正在分析会话…',
  'panel.empty': '暂无诊断结果。点击"诊断失败"分析当前会话。',
  'panel.error': '分析失败：',
  'panel.noFindings': '规则引擎未检测到已知失败模式。',
  'panel.findings': '发现的问题',
  'panel.heatmap': '工具调用热力图',
  'panel.forkPoints': '建议的回退点',
  'panel.llmDiagnosis': 'LLM 深度诊断',
  'panel.stats': '会话统计',
  'panel.useLlm': '启用 LLM 深度诊断',
  'severity.critical': '严重',
  'severity.major': '主要',
  'severity.minor': '次要',
}

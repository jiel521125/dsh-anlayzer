/**
 * The header action button that opens the TianShu diagnosis panel.
 *
 * @module dsh-tianshu-analyzer/client/HeaderAction
 */

import type { ReactNode } from 'react'
import { useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { TianShuPanelInjected } from './Panel.tsx'
import { TianShuPanel } from './Panel.tsx'

export interface HeaderActionProps {
  readonly sessionId: SessionId
  readonly api: TianShuPanelInjected['api']
}

/** A header-utilities slot component: renders the diagnose button + panel. */
export function TianShuHeaderAction({ sessionId, api }: HeaderActionProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true) }}
        title="TianShu: diagnose this session"
        style={btnStyle}
      >
        ⚕︎ Diagnose
      </button>
      {open && (
        <TianShuPanel
          sessionId={String(sessionId)}
          api={api}
          onClose={() => { setOpen(false) }}
        />
      )}
    </>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '12px',
  border: '1px solid var(--dsh-border, #ddd)',
  borderRadius: '6px',
  background: 'transparent',
  color: 'var(--dsh-text, inherit)',
  cursor: 'pointer',
}

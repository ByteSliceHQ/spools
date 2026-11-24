import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import { agentLogos } from '../landing/agent-logos'
import { agentPrompt, promptUrl } from '../site'

/** One line that says what the prompt does, and a button that copies it. The prompt itself is not shown. */
export function CopyPrompt({ className = '' }: { className?: string }) {
  const [copyState, setCopyState] = useState('Copy prompt')
  const Icon = copyState === 'Copied' ? Check : Copy

  return (
    <div className={`min-w-0 ${className}`.trim()}>
      <div className="border-line bg-background-subtle inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-2.5 rounded-[1.6rem] border py-2 pr-2 pl-4">
        <span className="text-foreground flex items-center gap-2.5" aria-hidden="true">
          {agentLogos.map((logo) => (
            <svg key={logo.name} viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path d={logo.path} />
            </svg>
          ))}
        </span>
        <span className="bg-line h-5 w-px max-sm:hidden" aria-hidden="true" />
        <span className="text-foreground mr-auto text-[0.9rem] font-medium whitespace-nowrap">
          Have your agent build your CRM
        </span>
        <button
          type="button"
          className="bg-foreground text-background inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-2 text-[0.85rem] font-medium"
          onClick={() => {
            void navigator.clipboard
              .writeText(agentPrompt)
              .then(() => setCopyState('Copied'))
              .catch(() => setCopyState('Copy failed'))
          }}
        >
          <Icon size={15} aria-hidden="true" />
          {copyState}
        </button>
      </div>
      <p className="text-muted mt-3 mb-0 text-[0.85rem]">
        Copies a prompt. Paste it into Claude Code, Codex or Cursor.{' '}
        <a href={promptUrl}>Read it first</a>
      </p>
      <span className="sr-only" role="status">
        {copyState === 'Copy prompt' ? '' : copyState}
      </span>
    </div>
  )
}

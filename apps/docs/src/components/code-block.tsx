import { useState } from 'react'

import { highlightCode } from './code-highlight'

export interface CodeBlockProps {
  children: string
  lang?: string
  className?: string
}

export function CodeBlock({ children, lang = 'tsx', className = '' }: CodeBlockProps) {
  const [copyState, setCopyState] = useState('Copy')
  const html = highlightCode(children, lang)

  return (
    <div
      className={`not-prose mt-6 mb-8 max-w-full min-w-0 [&_pre]:m-0! [&_pre]:rounded-t-none! ${className}`.trim()}
    >
      <div className="border-line bg-background-subtle text-muted flex items-center justify-between rounded-t-md border border-b-0 px-[0.8rem] py-[0.45rem] font-mono text-xs">
        <span>{lang}</span>
        <button
          type="button"
          className="border-line text-foreground cursor-pointer rounded-sm border px-2 py-1"
          aria-label="Copy code"
          onClick={() => {
            void navigator.clipboard
              .writeText(children)
              .then(() => setCopyState('Copied'))
              .catch(() => setCopyState('Select code to copy'))
          }}
        >
          {copyState}
        </button>
      </div>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <span className="sr-only" role="status">
        {copyState === 'Copy' ? '' : copyState}
      </span>
    </div>
  )
}

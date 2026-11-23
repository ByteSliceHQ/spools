import { useState } from 'react'

import { requests } from '../landing/requests'
import { highlightCode } from './code-highlight'

/** What you ask an agent for, and the few lines it writes. */
export function AskPanel() {
  const [active, setActive] = useState(0)
  const request = requests[active] ?? requests[0]

  return (
    <div className="border-line bg-background-subtle min-w-0 overflow-hidden rounded-lg border">
      <div
        role="tablist"
        aria-label="Example requests"
        className="border-line flex gap-1 overflow-x-auto border-b px-3"
      >
        {requests.map((item, index) => {
          const selected = index === active

          return (
            <button
              key={item.label}
              type="button"
              role="tab"
              id={`ask-tab-${index}`}
              aria-controls="ask-panel"
              aria-selected={selected}
              onClick={() => setActive(index)}
              className={`relative h-10 shrink-0 cursor-pointer px-3 text-[0.8rem] transition-colors ${
                selected ? 'text-foreground' : 'text-muted hover:text-foreground'
              }`}
            >
              {item.label}
              {selected ? (
                <span className="bg-foreground absolute inset-x-2 bottom-0 h-px" />
              ) : null}
            </button>
          )
        })}
      </div>
      <div
        id="ask-panel"
        role="tabpanel"
        aria-labelledby={`ask-tab-${active}`}
        className="flex h-[31rem] flex-col"
      >
        <div className="px-4 pt-4 pb-3">
          <div className="text-muted mb-1.5 font-mono text-[0.7rem]">You ask</div>
          <p className="text-foreground m-0 text-[0.9rem] leading-[1.55]">{request.prompt}</p>
        </div>
        <div className="border-line text-muted flex justify-between border-t px-4 pt-3 font-mono text-[0.7rem]">
          <span>Your agent writes</span>
          <span>{request.file}</span>
        </div>
        <div
          className="min-h-0 flex-1 overflow-auto [&_pre]:m-0! [&_pre]:min-w-max [&_pre]:border-0! [&_pre]:bg-transparent! [&_pre]:py-2! [&_pre]:text-[0.74rem]!"
          dangerouslySetInnerHTML={{ __html: highlightCode(request.code, request.lang) }}
        />
        <div className="border-line text-muted flex items-center gap-2 border-t px-4 py-2.5 font-mono text-[0.72rem]">
          <span className="text-foreground">bun run check</span>
          <span>types, lint, config, tests</span>
        </div>
      </div>
    </div>
  )
}

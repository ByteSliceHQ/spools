import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import {
  packagesFor,
  ports,
  spoolFile,
  startingSelection,
  variablesFor,
  type Port,
} from '../landing/adapters'
import { CodeBlock } from './code-block'

function PortPicker({
  port,
  value,
  onChange,
}: {
  port: Port
  value: string | null
  onChange: (value: string | null) => void
}) {
  const options = [
    ...port.choices.map(({ label }) => ({ label, value: label })),
    ...(port.optional ? [{ label: 'None', value: null }] : []),
  ]

  return (
    <fieldset className="border-line-subtle grid grid-cols-[5rem_1fr] items-center gap-3 border-b py-2.5">
      <legend className="sr-only">{port.label}</legend>
      <span className="text-muted font-mono text-xs" aria-hidden="true">
        {port.id}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <label
            key={option.label}
            className="border-line text-muted hover:text-foreground has-checked:border-foreground has-checked:text-foreground has-focus-visible:outline-foreground cursor-pointer rounded-[5px] border px-2.5 py-1 text-[0.82rem] transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2"
          >
            <input
              type="radio"
              className="sr-only"
              name={`builder-${port.id}`}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function Needs({ label, items, none }: { label: string; items: readonly string[]; none: string }) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr] gap-3 py-1.5 font-mono text-xs leading-relaxed">
      <dt className="text-muted">{label}</dt>
      <dd className="text-foreground m-0 break-words">{items.join(', ') || none}</dd>
    </div>
  )
}

/** Choose an adapter for each part and read the file it makes. */
export function SpoolBuilder() {
  const [selection, setSelection] = useState(startingSelection)

  return (
    <section className="mt-28 grid items-start gap-10 max-[640px]:mt-18 md:grid-cols-2">
      <div className="min-w-0">
        <h2 className="text-foreground mb-4 text-[1.8rem] leading-[1.25] font-medium tracking-[-0.025em]">
          Choose the services it runs on
        </h2>
        <p className="mb-6 max-w-[44rem] leading-[1.75]">
          Pick one for each part and copy the file.
        </p>
        <div className="border-line-subtle mb-6 border-t">
          {ports.map((port) => (
            <PortPicker
              key={port.id}
              port={port}
              value={selection[port.id]}
              onChange={(value) => setSelection((current) => ({ ...current, [port.id]: value }))}
            />
          ))}
        </div>
        <Link
          to="/docs/$slug"
          params={{ slug: 'adapters' }}
          hash="write-your-own"
          className="text-[0.9rem]"
        >
          Write your own adapter →
        </Link>
      </div>
      <div className="min-w-0">
        <CodeBlock lang="src/spool.server.ts" className="my-0!">
          {spoolFile(selection)}
        </CodeBlock>
        <dl className="mt-4 mb-0" aria-live="polite">
          <Needs label="Install" items={packagesFor(selection)} none="Nothing else" />
          <Needs label="Set" items={variablesFor(selection)} none="Nothing" />
        </dl>
      </div>
    </section>
  )
}

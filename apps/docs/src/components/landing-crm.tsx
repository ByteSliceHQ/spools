import { useState } from 'react'

import { deals, money, stages, timeline, total, views, type ViewId } from '../landing/crm'
import { highlightCode } from './code-highlight'

function Board() {
  return (
    <div className="grid h-full grid-cols-3 gap-2.5 p-3">
      {stages.map((stage) => {
        const column = deals.filter((deal) => deal.stage === stage.value)

        return (
          <div key={stage.value} className="min-w-0">
            <div className="mb-2 flex items-baseline justify-between gap-2 text-[0.72rem]">
              <span className="text-foreground truncate font-medium">{stage.label}</span>
              <span className="text-muted tabular-nums">{total(column)}</span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
              {column.map((deal) => (
                <div key={deal.title} className="border-line bg-background rounded-md border p-2.5">
                  <div className="text-foreground text-[0.76rem] leading-snug font-medium">
                    {deal.title}
                  </div>
                  <div className="text-foreground mt-1.5 text-[0.72rem] tabular-nums">
                    {money(deal.value)}
                  </div>
                  <div className="text-muted mt-0.5 truncate text-[0.72rem]">{deal.company}</div>
                  <div className="text-muted mt-0.5 text-[0.72rem]">{deal.closeDate}</div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Table() {
  return (
    <div className="overflow-x-auto">
      <table className="m-0 text-[0.76rem]">
        <thead>
          <tr>
            {['Title', 'Value', 'Stage', 'Company', 'Close date'].map((heading) => (
              <th
                key={heading}
                className="px-3! py-2! text-[0.68rem]! tracking-normal! whitespace-nowrap normal-case!"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {deals.map((deal) => (
            <tr key={deal.title}>
              <td className="text-foreground! px-3! py-2.5! font-medium whitespace-nowrap">
                {deal.title}
              </td>
              <td className="px-3! py-2.5! tabular-nums">{money(deal.value)}</td>
              <td className="px-3! py-2.5!">
                {stages.find((stage) => stage.value === deal.stage)?.label}
              </td>
              <td className="px-3! py-2.5! whitespace-nowrap">{deal.company}</td>
              <td className="px-3! py-2.5! whitespace-nowrap">{deal.closeDate}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="text-muted! border-0! px-3! py-2.5!">5 deals</td>
            <td className="text-foreground! border-0! px-3! py-2.5! tabular-nums">
              {total(deals)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function Record() {
  return (
    <div className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-foreground text-[0.95rem] font-medium">Warehouse fit-out</div>
          <div className="text-muted text-[0.76rem]">Larkspur Supply · {money(48000)}</div>
        </div>
        <span className="bg-foreground text-background rounded-[5px] px-2.5 py-1 text-[0.72rem] font-medium whitespace-nowrap">
          Start onboarding
        </span>
      </div>
      <ol className="border-line m-0 mt-5 grid list-none gap-4 border-l p-0 pl-4">
        {timeline.map((entry) => (
          <li key={entry.what} className="relative text-[0.78rem]">
            <span
              className="border-muted-light bg-background absolute top-[0.35rem] -left-[calc(1rem+4px)] size-[7px] rounded-full border"
              aria-hidden="true"
            />
            <div className="text-foreground">{entry.what}</div>
            <div className="text-muted text-[0.72rem]">
              {entry.who} · {entry.when}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

const panels = { board: Board, table: Table, record: Record }

/** One object shown three ways, with the lines of config that make each. */
export function LandingCrm() {
  const [active, setActive] = useState<ViewId>('board')
  const view = views.find(({ id }) => id === active) ?? views[0]
  const Panel = panels[view.id]

  return (
    <div className="border-line bg-background-subtle min-w-0 overflow-hidden rounded-lg border">
      <div
        role="tablist"
        aria-label="Views of deals"
        className="border-line flex items-center gap-1 border-b px-3"
      >
        <span className="text-foreground mr-auto text-[0.8rem] font-medium">Deals</span>
        {views.map((item) => {
          const selected = item.id === view.id

          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`crm-tab-${item.id}`}
              aria-controls="crm-panel"
              aria-selected={selected}
              onClick={() => setActive(item.id)}
              className={`relative h-10 cursor-pointer px-3 text-[0.8rem] transition-colors ${
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
        id="crm-panel"
        role="tabpanel"
        aria-labelledby={`crm-tab-${view.id}`}
        className="h-[18.5rem] overflow-y-auto"
      >
        <Panel />
      </div>
      <div className="border-line border-t">
        <div className="text-muted px-3 pt-2.5 font-mono text-[0.7rem]">crm.config.json</div>
        <div
          className="[&_pre]:m-0! [&_pre]:border-0! [&_pre]:bg-transparent! [&_pre]:py-2! [&_pre]:text-[0.74rem]!"
          dangerouslySetInnerHTML={{ __html: highlightCode(view.config, 'json') }}
        />
      </div>
    </div>
  )
}

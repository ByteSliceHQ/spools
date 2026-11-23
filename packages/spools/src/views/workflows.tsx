import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowRight, Mail, MousePointerClick, Workflow, Zap } from 'lucide-react'
import type { ReactNode } from 'react'

import { Avatar, Count, cx, relativeTime } from '../crm/ui/kit'
import { TopBar } from '../crm/ui/shell'
import { useCrmConfig } from '../crm/ui/use-crm'

const route = getRouteApi('/_crm/workflows')

const kinds = new Map([
  ['swirls', 'Swirls workflow'],
  ['campaign', 'Sequence'],
  ['local', 'App handler'],
])

/** "swirls:new_contact" -> where it runs and what it's called. */
function describeTarget(run: string) {
  const [kind = '', name = ''] = run.split(':')
  return { kind: kinds.get(kind) ?? kind, name }
}

const empty = (text: string) => <p className="text-c-fg3 px-3 py-5 text-center">{text}</p>

function Status({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="text-c-fg2 flex items-center gap-1.5 text-xs">
      <span className={cx('size-1.5 rounded-full', on ? 'bg-green-500' : 'bg-c-fg3')} />
      {label}
    </span>
  )
}

function Panel({
  title,
  count,
  anchor,
  children,
}: {
  title: string
  count: number
  /** The name guides point at this panel by. */
  anchor?: string
  children: ReactNode
}) {
  return (
    <section data-guide={anchor}>
      <h2 className="mb-2 flex items-center gap-1.5 px-1 font-medium">
        {title} <Count>{count}</Count>
      </h2>
      <div className="border-c-line bg-c-raised overflow-hidden rounded-xl border">{children}</div>
    </section>
  )
}

export function Workflows(): ReactNode {
  const data = route.useLoaderData()
  const config = useCrmConfig()
  const objectLabel = (key: string) => config.objects[key]?.label.toLowerCase() ?? key

  return (
    <>
      <TopBar icon={<Workflow className="text-c-fg2 size-3.5" />} title="Workflows" />
      <div
        data-guide="workflow-status"
        className="border-c-line flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b px-3 py-1.5"
      >
        <Status
          on={data.swirlsConfigured}
          label={
            data.swirlsConfigured
              ? 'Swirls connected'
              : 'Swirls not connected: workflow runs are skipped'
          }
        />
        <Status
          on={data.emailConfigured}
          label={
            data.emailConfigured
              ? 'Email sending on'
              : 'Email not configured: emails are logged, not sent'
          }
        />
        {!data.sequencesTick && (
          <Status
            on={false}
            label="Sequences need a scheduled job on this server: only emails with no wait are sent"
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="space-y-5" data-guide="workflow-lists">
            <Panel title="Automations" count={data.automations.length}>
              {data.automations.length === 0 && empty('No automations in crm.config.json.')}
              {data.automations.map((a) => {
                const [objectKey = '', event = ''] = a.on.split('.')
                const target = describeTarget(a.run)
                return (
                  <div
                    key={`${a.on}:${a.run}`}
                    className="border-c-line flex h-10 items-center gap-2 border-b px-3 last:border-b-0"
                  >
                    <Zap className="size-3.5 shrink-0 text-amber-500" />
                    <span className="truncate">
                      When a {objectLabel(objectKey)} is {event}
                    </span>
                    <ArrowRight className="text-c-fg3 size-3 shrink-0" />
                    <span className="truncate font-medium">{target.name}</span>
                    <span className="text-c-fg3 ml-auto shrink-0 text-xs">{target.kind}</span>
                  </div>
                )
              })}
            </Panel>

            <Panel title="Record actions" count={data.actions.length}>
              {data.actions.length === 0 && empty('No actions in crm.config.json.')}
              {data.actions.map((a) => {
                const target = describeTarget(a.run)
                return (
                  <div
                    key={`${a.objectKey}:${a.label}`}
                    className="border-c-line flex h-10 items-center gap-2 border-b px-3 last:border-b-0"
                  >
                    <MousePointerClick className="text-c-accent size-3.5 shrink-0" />
                    <span className="truncate">
                      "{a.label}" on a {objectLabel(a.objectKey)}
                    </span>
                    <ArrowRight className="text-c-fg3 size-3 shrink-0" />
                    <span className="truncate font-medium">{target.name}</span>
                    <span className="text-c-fg3 ml-auto shrink-0 text-xs">{target.kind}</span>
                  </div>
                )
              })}
            </Panel>

            <Panel title="Sequences" count={data.sequences.length}>
              {data.sequences.length === 0 && empty('No email sequences in crm.config.json.')}
              {data.sequences.map((s) => (
                <div key={s.key} className="border-c-line border-b px-3 py-2.5 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <Mail className="size-3.5 text-purple-500" />
                    <span className="font-medium">{s.label}</span>
                    <span className="text-c-fg3 ml-auto text-xs">
                      {s.steps.length} emails to{' '}
                      {config.objects[s.objectKey]?.labelPlural.toLowerCase()}
                      {s.active > 0 && ` · ${s.active.toLocaleString()} under way`}
                    </span>
                  </div>
                  <ol className="text-c-fg2 mt-2 space-y-1">
                    {s.steps.map((step, i) => (
                      <li key={step.id} className="flex items-center gap-2">
                        <span className="text-c-fg3 w-16 shrink-0 text-xs">
                          {i === 0 && step.wait.startsWith('0') ? 'At once' : `After ${step.wait}`}
                        </span>
                        <span className="truncate">{step.subject}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </Panel>
          </div>

          <Panel title="Recent runs" count={data.runs.length} anchor="workflow-runs">
            {data.runs.length === 0 && empty('Nothing has run yet.')}
            {data.runs.map((r) => (
              <Link
                key={r.id}
                to="/$object/$id"
                params={{ object: r.objectKey, id: r.recordId }}
                className="border-c-line hover:bg-c-hov flex h-10 items-center gap-2 border-b px-3 last:border-b-0"
              >
                {r.recordTitle && <Avatar name={r.recordTitle} size="sm" />}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{r.recordTitle ?? 'Deleted record'}</span>{' '}
                  <span className="text-c-fg2">{r.summary}</span>
                </span>
                <time className="text-c-fg3 shrink-0 text-xs">{relativeTime(r.createdAt)}</time>
              </Link>
            ))}
          </Panel>
        </div>
      </div>
    </>
  )
}

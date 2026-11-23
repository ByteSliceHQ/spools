import { getRouteApi, Link, useNavigate, useRouteContext } from '@tanstack/react-router'
import { ArrowUp, Home as HomeIcon, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { ObjectIcon } from '../crm/ui/icons'
import { Count, IconButton, relativeTime } from '../crm/ui/kit'
import { objectIndex, TopBar } from '../crm/ui/shell'
import { useCrmConfig } from '../crm/ui/use-crm'
import { TaskDialog, TaskRow } from '../crm/ui/workspace'

const route = getRouteApi('/_crm/')

export function Home(): ReactNode {
  const { counts, activities, tasks } = route.useLoaderData()
  const config = useCrmConfig()
  const navigate = useNavigate()
  const { user } = useRouteContext({ from: '/_crm' })
  const [prompt, setPrompt] = useState('')
  const [addingTask, setAddingTask] = useState(false)
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  const ask = () => {
    if (prompt.trim()) {
      void navigate({ to: '/assistant', search: { ask: prompt.trim() } })
    }
  }

  return (
    <>
      <TopBar icon={<HomeIcon className="text-c-fg2 size-3.5" />} title="Home" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[580px] px-4 py-10">
          <h1 className="text-lg font-semibold">
            {greeting}
            {user ? `, ${user.name.split(' ')[0]}` : ''}.
          </h1>

          <form
            data-guide="home-ask"
            className="border-c-line2 bg-c-raised focus-within:border-c-accent mt-5 rounded-xl border"
            onSubmit={(e) => {
              e.preventDefault()
              ask()
            }}
          >
            <label htmlFor="ask" className="sr-only">
              Ask the assistant
            </label>
            <textarea
              id="ask"
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  ask()
                }
              }}
              rows={2}
              placeholder="Ask about your pipeline, or tell the assistant what to update…"
              className="placeholder:text-c-fg3 block w-full resize-none bg-transparent px-3 pt-3 outline-none"
            />
            <div className="flex justify-end p-2">
              <button
                type="submit"
                aria-label="Ask"
                disabled={!prompt.trim()}
                className="bg-c-accent flex size-7 items-center justify-center rounded-lg text-white disabled:opacity-40"
              >
                <ArrowUp className="size-3.5" strokeWidth={2.5} />
              </button>
            </div>
          </form>

          <div data-guide="home-counts" className="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Object.entries(config.objects).map(([key, obj]) => (
              <Link
                key={key}
                to="/$object"
                params={{ object: key }}
                className="border-c-line hover:bg-c-hov rounded-xl border p-3"
              >
                <div className="text-c-fg2 flex items-center gap-2">
                  <ObjectIcon icon={obj.icon} index={objectIndex(config, key)} size="sm" />
                  <span className="truncate">{obj.labelPlural}</span>
                </div>
                <div className="mt-2 text-lg font-semibold tabular-nums">
                  {(counts[key] ?? 0).toLocaleString()}
                </div>
              </Link>
            ))}
          </div>

          <section className="mt-8" data-guide="home-tasks">
            <header className="mb-1 flex h-7 items-center gap-1.5">
              <h2 className="text-c-fg2 font-medium">Tasks</h2>
              <Count>{tasks.length}</Count>
              <Link to="/tasks" className="text-c-fg2 hover:text-c-fg ml-auto text-xs">
                View all
              </Link>
              <IconButton label="New task" className="size-6" onClick={() => setAddingTask(true)}>
                <Plus className="size-3.5" />
              </IconButton>
            </header>
            {tasks.length === 0 ? (
              <p className="border-c-line text-c-fg3 rounded-xl border px-3 py-5 text-center">
                Nothing assigned to you.
              </p>
            ) : (
              <div className="border-c-line overflow-hidden rounded-xl border [&>*:last-child]:border-b-0">
                {tasks.map((t) => (
                  <TaskRow key={t.id} task={t} />
                ))}
              </div>
            )}
          </section>

          <section className="mt-8" data-guide="home-activity">
            <h2 className="text-c-fg2 mb-1 flex h-7 items-center font-medium">Recent activity</h2>
            <div className="border-c-line overflow-hidden rounded-xl border">
              {activities.length === 0 && (
                <p className="text-c-fg3 px-3 py-5 text-center">Nothing yet.</p>
              )}
              {activities.map((a) => (
                <Link
                  key={a.id}
                  to="/$object/$id"
                  params={{ object: a.objectKey, id: a.recordId }}
                  className="hover:bg-c-hov flex h-9 items-center gap-2 px-3"
                >
                  <ObjectIcon
                    icon={config.objects[a.objectKey]?.icon}
                    index={objectIndex(config, a.objectKey)}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{a.actor ?? 'System'}</span>{' '}
                    <span className="text-c-fg2">{a.summary}</span>
                  </span>
                  <time className="text-c-fg3 shrink-0 text-xs">{relativeTime(a.createdAt)}</time>
                </Link>
              ))}
            </div>
          </section>
        </div>
      </div>
      <TaskDialog open={addingTask} onClose={() => setAddingTask(false)} />
    </>
  )
}

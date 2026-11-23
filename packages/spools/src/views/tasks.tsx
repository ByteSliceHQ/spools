import { getRouteApi, Link } from '@tanstack/react-router'
import { ArrowUpDown, CheckSquare, Plus } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { Button, Count, cx } from '../crm/ui/kit'
import { TopBar } from '../crm/ui/shell'
import { TaskDialog, type TaskItem, TaskRow } from '../crm/ui/workspace'

const route = getRouteApi('/_crm/tasks')

const byDue = (a: TaskItem, b: TaskItem) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')

export function Tasks(): ReactNode {
  const tasks = route.useLoaderData()
  const { scope = 'mine' } = route.useSearch()
  const [adding, setAdding] = useState(false)

  const today = new Date().toISOString().slice(0, 10)

  const open = tasks.filter((t) => !t.completedAt).toSorted(byDue)

  const groups: { title: string; items: TaskItem[] }[] = [
    { title: 'Today', items: open.filter((t) => t.dueDate && t.dueDate <= today) },
    { title: 'Upcoming', items: open.filter((t) => t.dueDate && t.dueDate > today) },
    { title: 'No due date', items: open.filter((t) => !t.dueDate) },
    { title: 'Completed', items: tasks.filter((t) => t.completedAt) },
  ]

  const scopeLink = (value: 'mine' | 'all', label: string): ReactNode => (
    <Link
      to="."
      search={{ scope: value === 'mine' ? undefined : value }}
      className={cx(
        'flex h-6 items-center rounded-md px-2 text-xs font-medium',
        scope === value ? 'bg-c-raised shadow-xs' : 'text-c-fg2 hover:text-c-fg',
      )}
    >
      {label}
    </Link>
  )

  return (
    <>
      <TopBar icon={<CheckSquare className="text-c-fg2 size-3.5" />} title="Tasks" />
      <div className="flex h-11 shrink-0 items-center gap-1.5 px-3">
        <span className="border-c-line2 flex h-7 items-center gap-1.5 rounded-lg border px-2">
          <ArrowUpDown className="text-c-fg3 size-3.5" />
          <span className="text-c-fg2">Sorted by</span>
          <span className="font-medium">Due date</span>
        </span>
        <div
          data-guide="tasks-scope"
          className="bg-c-hov flex items-center gap-0.5 rounded-lg p-0.5"
        >
          {scopeLink('mine', 'My tasks')}
          {scopeLink('all', 'All tasks')}
        </div>
        <Button
          variant="primary"
          className="ml-auto"
          data-guide="new-task"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3.5" /> New task
        </Button>
      </div>
      <div className="border-c-line text-c-fg2 flex h-8 shrink-0 items-center gap-2.5 border-y px-3 text-xs">
        <span className="w-4" />
        <span className="flex-1">Task</span>
        <span className="w-32">Due date</span>
        <span className="hidden w-44 md:block">Record</span>
        <span className="hidden w-36 lg:block">Assigned to</span>
        <span className="w-6" />
      </div>
      <div data-guide="tasks-list" className="min-h-0 flex-1 overflow-y-auto">
        {tasks.length === 0 && (
          <div className="text-c-fg3 py-20 text-center">
            <p>No tasks yet.</p>
            <Button className="mt-3" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" /> New task
            </Button>
          </div>
        )}
        {groups
          .filter((g) => g.items.length > 0)
          .map((g) => (
            <section key={g.title}>
              <h2 className="border-c-line bg-c-panel text-c-fg2 flex h-8 items-center gap-1.5 border-b px-3 text-xs font-medium">
                {g.title} <Count>{g.items.length}</Count>
              </h2>
              {g.items.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </section>
          ))}
      </div>
      <TaskDialog open={adding} onClose={() => setAdding(false)} />
    </>
  )
}

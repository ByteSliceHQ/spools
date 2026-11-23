import { lazyRouteComponent } from '@tanstack/react-router'

import { listNotesFn } from '../server/workspace.functions'

export const notesPage = {
  loader: () => listNotesFn({ data: {} }),
  component: lazyRouteComponent(() => import('../views/notes'), 'Notes'),
}

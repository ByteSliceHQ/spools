import { lazyRouteComponent } from '@tanstack/react-router'
import { z } from 'zod'

/**
 * The Files page: a file browser over the whole drive. Each record that takes
 * files has a folder here, and the shared library sits beside them. The folder
 * being shown is in the address, so a folder can be linked to.
 */

export const filesPage = {
  validateSearch: z.object({ folder: z.string().uuid().optional().catch(undefined) }),
  component: lazyRouteComponent(() => import('../views/files'), 'FilesPage'),
}

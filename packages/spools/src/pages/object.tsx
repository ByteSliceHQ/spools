import { notFound } from '@tanstack/react-router'

import type { PublicCrmConfig } from '../crm/config'

/**
 * Objects are served from the site root (/contacts, /deals), so this route also
 * catches every unknown first path segment (a typo, /favicon.ico). Answer those
 * with a 404 here instead of asking the server for an object that doesn't exist.
 */
export const objectLayout = {
  beforeLoad: ({
    context,
    params,
  }: {
    context: { config: PublicCrmConfig | null }
    params: { object: string }
  }) => {
    if (context.config && !Object.hasOwn(context.config.objects, params.object)) {
      throw notFound()
    }
  },
}

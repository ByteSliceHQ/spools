import { lazyRouteComponent, notFound } from '@tanstack/react-router'
import { z } from 'zod'

import { getRecordFn } from '../server/crm.functions'

export const recordPage = {
  validateSearch: z.object({ tab: z.string().optional() }),
  loader: async ({ params }: { params: { object: string; id: string } }) => {
    const data = await getRecordFn({ data: { objectKey: params.object, id: params.id } })

    if (!data.record) {
      throw notFound()
    }

    return { ...data, record: data.record }
  },
  component: lazyRouteComponent(() => import('../views/record'), 'RecordPage'),
}

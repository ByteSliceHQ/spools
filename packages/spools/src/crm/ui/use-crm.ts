import { notFound, useRouteContext } from '@tanstack/react-router'

import type { PublicCrmConfig } from '../config'

export function useCrmConfig(): PublicCrmConfig {
  const { config } = useRouteContext({ from: '/_crm' })

  if (!config) {
    throw new Error('CRM config missing from route context')
  }

  return config
}

export function useCrmObject(objectKey: string) {
  const config = useCrmConfig()
  const obj = config.objects[objectKey]

  if (!obj) {
    throw notFound()
  }

  const titleFieldOf = (key: string) => config.objects[key]?.titleField ?? 'id'
  return { config, obj, titleFieldOf }
}

import { z } from 'zod'

import { addActivity, defineExtensions, updateRecord } from '@swirls/spools/extensions'

/**
 * Your app's server-side extensions. This file is yours: the framework reads it
 * but upstream updates never change it. See docs/extending.md.
 */
export default defineExtensions({
  // Referenced from crm.config.json as "run": "local:<name>".
  handlers: {
    async logTouch(ctx) {
      await addActivity({
        objectKey: ctx.objectKey,
        recordId: ctx.record.id,
        kind: 'touch',
        summary: `Touched by ${ctx.actor?.email ?? 'system'}`,
        actor: ctx.actor?.email ?? 'system',
      })

      return { message: 'Logged' }
    },

    // Writes go through the service so hooks, the timeline and automations still run.
    async markCustomer(ctx) {
      await updateRecord(ctx.objectKey, ctx.record.id, { status: 'customer' }, ctx.actor)
      return { message: 'Marked as a customer' }
    },
  },

  // Record lifecycle hooks. Return new values from a before* hook to change them,
  // or throw to reject the change.
  hooks: {
    beforeCreate({ objectKey, values }) {
      const email = z.string().safeParse(values.email)

      if (objectKey === 'contacts' && email.success) {
        return { ...values, email: email.data.toLowerCase() }
      }

      return values
    },
  },
})

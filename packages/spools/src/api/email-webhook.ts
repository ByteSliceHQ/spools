import { handleDelivery } from '../server/delivery'
import { publicRoute } from '../server/runtime/boundary'

/**
 * Where the email provider reports bounces and complaints: campaigns stop
 * mailing the addresses. The email adapter checks the signature. With Resend,
 * add a webhook for email.bounced and email.complained pointing at
 * {APP_URL}/api/webhooks/email, and set RESEND_WEBHOOK_SECRET to its secret.
 */
export const emailWebhookHandlers = { POST: publicRoute('webhooks.email', handleDelivery) }

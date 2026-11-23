import { Effect } from 'effect'

import { textToHtml } from '../../../server/email'
import { runServer } from '../../../server/runtime/app'
import { Email } from '../../../server/runtime/email'
import { messageOf } from '../../../server/runtime/errors'
import { crmConfig } from '../../../server/spool'
import { and, contains, gt, startsWith } from '../../../server/store/query'
import { Store } from '../../../server/store/store'
import { isAllowed } from '../../../server/users'
import { inProduction } from './settings'
import { LINK, LINK_MINUTES, SIGN_IN } from './shared'
import { AuthVerification } from './tables'

/**
 * Links by email. Opening one proves that the address is the person's own.
 *
 * A link opens the sign-in page, which asks for one click before it uses the
 * link up. Mail filters open the links in an email to check them, and a link
 * that works once would be spent by the time the person gets to it.
 */

/** Links one address may have waiting, so that nobody's inbox can be filled by asking over and over. */
const WAITING = 5

/** The links waiting at an address. Better Auth keeps what a link is for as JSON, in this shape. */
const waitingAt = (email: string) =>
  Store.use((store) =>
    store.count(AuthVerification, {
      filter: and(
        startsWith('identifier', 'magic-link:'),
        contains('value', `"email":${JSON.stringify(email)}`),
        gt('expiresAt', new Date()),
      ),
    }),
  )

function letter(to: string, link: string) {
  const app = crmConfig().app.name

  const text = [
    `Open this link to sign in to ${app}:`,
    link,
    `It works once, in the next ${LINK_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
  ].join('\n\n')

  return {
    to,
    subject: `Sign in to ${app}`,
    text,
    html: textToHtml(text).replace(link, () => `<a href="${link}">${link}</a>`),
    // The same for each try at this one email, so a retry doesn't send it twice.
    idempotencyKey: `sign-in-${crypto.randomUUID()}`,
  }
}

const send = Effect.fn('BetterAuth.sendLink')(function* (email: string, link: string) {
  // The one being asked for is among them.
  if ((yield* waitingAt(email)) > WAITING) {
    return
  }

  const { sent } = yield* (yield* Email).send(letter(email, link))

  if (sent) {
    return
  }

  yield* Effect.sync(() => {
    // Whoever reads the log could sign in with a link in it, so in production there never is one.
    if (inProduction()) {
      console.error(
        '[auth] No email provider is set up, so a sign-in link could not be sent. See docs/auth.md.',
      )
    } else {
      console.info(`[auth] No email provider is set up. Sign-in link for ${email}:\n  ${link}`)
    }
  })
})

/**
 * Sends a link to an address on the access list, and nothing to any other. It
 * never fails: whoever asked isn't told what became of it, so that asking
 * doesn't tell who is on the list.
 */
export async function sendLink(email: string, token: string, origin: string): Promise<void> {
  try {
    if (isAllowed(email)) {
      await runServer(send(email, `${origin}${SIGN_IN}#${LINK}=${token}`))
    }
  } catch (cause) {
    console.error(`[auth] A sign-in link could not be sent: ${messageOf(cause)}`)
  }
}

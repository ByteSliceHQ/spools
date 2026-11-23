/**
 * What a browser tab remembers between pages, so moving around the CRM doesn't
 * start every click with a request for things that rarely change. Pure: no
 * server imports, so it can be tested on its own. `src/crm/ui/session.ts` wires
 * it to the server functions.
 */

export type MemorySource<Session, Found> = {
  /** Ask the server who is signed in. */
  session: () => Promise<Session>
  /** Ask the server for the records of an object a relation picker offers for what was typed. */
  search: (objectKey: string, q: string) => Promise<Found>
  /** Ask the server for one record's title; null when there is no such record. */
  title: (objectKey: string, id: string) => Promise<string | null>
  /** A session worth keeping: someone signed in who may use the CRM. */
  usable: (session: Session) => boolean
  /** False on the server, where one process answers for everybody and nothing may be shared. */
  remember: boolean
  /** How long a remembered session is used before it is also checked again in the background. */
  sessionFreshMs?: number
  /** How long a picker's answers are reused. A record added by someone else shows up after this. */
  titlesFreshMs?: number
  now?: () => number
}

/** How many answers of one kind are kept: typing in a picker asks a new question with every pause. */
const KEPT = 200

/** Answers to questions that are asked again and again, reused while they are fresh. */
function kept<T>(ask: (key: string) => Promise<T>, freshMs: number, now: () => number) {
  const answers = new Map<string, { value: Promise<T>; at: number }>()
  return {
    get(key: string): Promise<T> {
      const hit = answers.get(key)

      if (hit && now() - hit.at < freshMs) {
        return hit.value
      }

      const value = ask(key)
      answers.delete(key)
      answers.set(key, { value, at: now() })

      // The oldest answer makes room: a Map hands its keys back in the order they were set.
      const oldest = answers.keys().next()

      if (answers.size > KEPT && !oldest.done) {
        answers.delete(oldest.value)
      }

      // A failed request must not be handed to the next asker.
      value.catch(() => {
        if (answers.get(key)?.value === value) {
          answers.delete(key)
        }
      })

      return value
    },
    clear: () => answers.clear(),
  }
}

/** Object keys are identifiers, so a line break can't be part of one. */
const SEP = '\n'

const split = (key: string): [string, string] => {
  const at = key.indexOf(SEP)
  return [key.slice(0, at), key.slice(at + 1)]
}

export function createMemory<Session, Found>(source: MemorySource<Session, Found>) {
  const {
    remember,
    usable,
    sessionFreshMs = 60_000,
    titlesFreshMs = 60_000,
    now = Date.now,
  } = source

  let held: { value: Session; at: number } | undefined
  let asking: Promise<Session> | undefined
  /** Goes up each time everything is forgotten, so an answer already on its way isn't kept as current. */
  let era = 0
  const searches = kept((key) => source.search(...split(key)), titlesFreshMs, now)
  const titles = kept((key) => source.title(...split(key)), titlesFreshMs, now)

  function ask(): Promise<Session> {
    if (asking) {
      return asking
    }

    const asked = era

    const request: Promise<Session> = source
      .session()
      .then((value) => {
        // Only a working session is worth keeping: someone signed out is asked again on the next page.
        if (asked === era) {
          held = usable(value) ? { value, at: now() } : undefined
        }

        return value
      })
      .finally(() => {
        if (asking === request) {
          asking = undefined
        }
      })

    asking = request
    return request
  }

  return {
    /**
     * The session for a navigation. One already in hand is returned at once,
     * and checked again in the background when it is getting old.
     */
    session(): Promise<Session> {
      if (!remember) {
        return source.session()
      }

      if (!held) {
        return ask()
      }

      if (now() - held.at > sessionFreshMs) {
        void ask().catch(() => undefined)
      }

      return Promise.resolve(held.value)
    },

    /** Keep a session that arrived another way (with the page), so the first click needn't ask for it. */
    keep(value: Session): void {
      if (remember && !held && usable(value)) {
        held = { value, at: now() }
      }
    },

    /** What a relation picker offers for an object and what has been typed into it. */
    search(objectKey: string, q: string): Promise<Found> {
      if (!remember) {
        return source.search(objectKey, q)
      }

      return searches.get(objectKey + SEP + q)
    },

    /** The title of a record a page knows only the id of. */
    title(objectKey: string, id: string): Promise<string | null> {
      if (!remember) {
        return source.title(objectKey, id)
      }

      return titles.get(objectKey + SEP + id)
    },

    /** Forget everything. Called when data changes, and when a request is refused. */
    forget(): void {
      era++
      held = undefined
      asking = undefined
      searches.clear()
      titles.clear()
    },
  }
}

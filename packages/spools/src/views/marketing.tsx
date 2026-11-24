import { getRouteApi, useRouter } from '@tanstack/react-router'
import { Check, Megaphone, TriangleAlert } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import {
  checkPost,
  clickRate,
  costPer,
  postLength,
  type PostStatus,
  tagReport,
  type TagRow,
  TAGS,
  tagSnippets,
  type TagStatus,
} from '../crm/marketing'
import { Button, cx, inputClass, relativeTime } from '../crm/ui/kit'
import { TopBar } from '../crm/ui/shell'
import {
  deletePostFn,
  draftPostFn,
  type getMarketingFn,
  profileSiteFn,
  publishPostFn,
  releasePostFn,
  scanSiteFn,
  schedulePostFn,
  syncAdsFn,
  unschedulePostFn,
} from '../server/marketing.functions'

const route = getRouteApi('/_crm/marketing')
const layout = getRouteApi('/_crm')

type Data = NonNullable<Awaited<ReturnType<typeof getMarketingFn>>>
type Post = Data['posts'][number]
type Ad = Data['ads'][number]

const TABS = [
  ['website', 'Website'],
  ['posts', 'Posts'],
  ['ads', 'Ads'],
] as const

const card = 'border-c-line bg-c-raised rounded-xl border p-4'

/** Runs one server call for a button: busy while it runs, then the page's data again, and what it said. */
function useAct() {
  const router = useRouter()
  const [busy, setBusy] = useState<string>()
  const [note, setNote] = useState<{ text: string; bad: boolean }>()

  /** `call` answers with what to tell the person, or nothing. */
  async function act(name: string, call: () => Promise<string | void>) {
    setBusy(name)
    setNote(undefined)

    try {
      const said = await call()

      if (said) {
        setNote({ text: said, bad: false })
      }

      await router.invalidate()
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'That did not work', bad: true })
    } finally {
      setBusy(undefined)
    }
  }

  return { busy, note, act }
}

function Note({ note }: { note?: { text: string; bad: boolean } }) {
  if (!note) {
    return null
  }

  return (
    <p
      role="status"
      className={cx(
        'rounded-lg px-3 py-2',
        note.bad ? 'bg-c-hov text-c-danger' : 'bg-c-hov text-c-fg2',
      )}
    >
      {note.text}
    </p>
  )
}

const TAG_WORDS: Record<TagStatus, string> = {
  installed: 'On your site',
  missing: 'Not on your site',
  unseen: 'Not in the page. Tag Manager may add it',
  different: 'Your site has a different one',
  found: 'On your site',
  unset: 'Not used',
}

function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function TagCard({ tag }: { tag: TagRow }) {
  const [open, setOpen] = useState(false)
  const good = tag.status === 'installed'
  const bad = tag.status === 'missing' || tag.status === 'different'
  const snippets = tag.id ? tagSnippets(tag.kind, tag.id) : []

  return (
    <li className={card}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{tag.label}</span>
            {tag.id && <code className="text-c-fg2 text-[12px]">{tag.id}</code>}
          </h3>
          <p className="text-c-fg2 mt-0.5">{tag.purpose}</p>
          <p
            className={cx(
              'mt-2 flex items-center gap-1',
              good && 'text-green-700 dark:text-green-400',
              bad && 'text-c-danger',
              !good && !bad && 'text-c-fg2',
            )}
          >
            {good && <Check className="size-3.5" />}
            {bad && <TriangleAlert className="size-3.5" />}
            {TAG_WORDS[tag.status]}
            {tag.status !== 'installed' && tag.onSite.length > 0 && `: ${tag.onSite.join(', ')}`}
          </p>
          {tag.status === 'found' && (
            <p className="text-c-fg3 mt-1 text-[12px]">
              Add it as <code>marketing.tags.{tag.kind}</code> in <code>crm.config.json</code> and
              the CRM will tell you if it ever goes missing.
            </p>
          )}
          {tag.status === 'unset' && (
            <p className="text-c-fg3 mt-1 text-[12px]">
              To use it, find the id in {TAGS[tag.kind].findIt} and add it as{' '}
              <code>marketing.tags.{tag.kind}</code> in <code>crm.config.json</code>.
            </p>
          )}
        </div>
        {snippets.length > 0 && !good && (
          <Button onClick={() => setOpen((was) => !was)}>
            {open ? 'Hide code' : 'Get the code'}
          </Button>
        )}
      </div>
      {open &&
        snippets.map((snippet) => (
          <div key={snippet.where} className="mt-3">
            <div className="mb-1 flex items-center gap-2">
              <span className="text-c-fg2 flex-1 text-[12px]">{snippet.note}</span>
              <Copy text={snippet.code} />
            </div>
            <pre className="border-c-line2 bg-c-hov overflow-x-auto rounded-lg border p-2 text-[11px] leading-relaxed">
              {snippet.code}
            </pre>
          </div>
        ))}
    </li>
  )
}

function Website({ data, tags }: { data: Data; tags: TagRow[] }) {
  const { busy, note, act } = useAct()
  const { site, engine } = data

  const waiting =
    !!site.profileRequestedAt &&
    (!site.profiledAt || site.profileRequestedAt > site.profiledAt) &&
    Date.now() - Date.parse(site.profileRequestedAt) < 10 * 60_000

  return (
    <div className="space-y-3">
      <div className={cx(card, 'flex flex-wrap items-center gap-3')}>
        <div className="min-w-0 flex-1">
          <a
            href={site.website}
            target="_blank"
            rel="noreferrer"
            className="truncate font-medium hover:underline"
          >
            {site.website}
          </a>
          <p className="text-c-fg3 text-[12px]">
            {site.scannedAt ? `Checked ${relativeTime(site.scannedAt)}` : 'Not checked yet'}
          </p>
        </div>
        <Button
          disabled={!!busy}
          onClick={() => act('scan', async () => void (await scanSiteFn()))}
        >
          {busy === 'scan' ? 'Checking…' : 'Check the site'}
        </Button>
      </div>

      <Note note={note} />

      {site.scanError && (
        <p className="text-c-danger px-1">
          {site.scanError}. What is shown below is from the last check that worked.
        </p>
      )}

      <section>
        <h2 className="text-c-fg2 px-1 pb-1.5 font-medium">Tracking tags</h2>
        <ul className="space-y-2">
          {tags.map((tag) => (
            <TagCard key={tag.kind} tag={tag} />
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-c-fg2 px-1 pb-1.5 font-medium">What the business is</h2>
        <div className={card}>
          {site.profile ? (
            <dl className="space-y-2">
              <div>
                <dt className="text-c-fg3 text-[12px]">In short</dt>
                <dd>{site.profile.summary}</dd>
              </div>
              {site.profile.audience && (
                <div>
                  <dt className="text-c-fg3 text-[12px]">Who it sells to</dt>
                  <dd>{site.profile.audience}</dd>
                </div>
              )}
              {site.profile.voice && (
                <div>
                  <dt className="text-c-fg3 text-[12px]">How it writes</dt>
                  <dd>{site.profile.voice}</dd>
                </div>
              )}
              {site.profile.offers.length > 0 && (
                <div>
                  <dt className="text-c-fg3 text-[12px]">What it sells</dt>
                  <dd>{site.profile.offers.join(', ')}</dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-c-fg2">
              Nothing yet. The assistant reads the website once and keeps what it learns, so the
              posts it drafts sound like the business.
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button
              disabled={!!busy || !engine || waiting}
              onClick={() => act('profile', async () => (await profileSiteFn()).message)}
            >
              {busy === 'profile' || waiting
                ? 'Reading…'
                : site.profile
                  ? 'Read the website again'
                  : 'Read the website'}
            </Button>
            <span className="text-c-fg3 text-[12px]">
              {!engine
                ? 'Needs the agent engine: set SWIRLS_PROJECT_ID'
                : site.profiledAt
                  ? `Read ${relativeTime(site.profiledAt)}`
                  : ''}
            </span>
          </div>
        </div>
      </section>
    </div>
  )
}

const POST_WORDS: Record<PostStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Not sent',
}

/** A moment as a `datetime-local` input writes it, in the browser's own time zone. */
function localInput(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}

type Channel = Data['channels'][number]
type Account = Data['accounts'][number]

function Composer({
  channels,
  editing,
  done,
}: {
  channels: Channel[]
  editing: Post | null
  done: () => void
}) {
  const [channel, setChannel] = useState(editing?.channel ?? channels[0]?.key ?? '')
  const [body, setBody] = useState(editing?.body ?? '')
  const [link, setLink] = useState(editing?.link ?? '')
  const { busy, note, act } = useAct()
  const chosen = channels.find((c) => c.key === channel)

  if (!chosen) {
    return null
  }

  const network = {
    label: chosen.network,
    limit: chosen.limit,
    linkLength: chosen.linkLength ?? undefined,
  }

  const problems = body.trim() ? checkPost(network, body, link || null) : []
  const length = postLength(network, body, link || null)

  return (
    <form
      className={cx(card, 'space-y-2')}
      onSubmit={(event) => {
        event.preventDefault()

        void act('save', async () => {
          await draftPostFn({
            data: { id: editing?.id, channel, body, link: link.trim() || null },
          })

          setBody('')
          setLink('')
          done()
        })
      }}
    >
      <div className="flex items-center gap-2">
        <label className="text-c-fg2 shrink-0 whitespace-nowrap" htmlFor="post-channel">
          {editing ? 'Editing a post for' : 'New post for'}
        </label>
        <select
          id="post-channel"
          className={cx(inputClass, 'w-auto!')}
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
        >
          {channels.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        aria-label="Post"
        className={cx(inputClass, 'min-h-28')}
        placeholder="What do you want to say?"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <input
        aria-label="Link"
        type="url"
        className={inputClass}
        placeholder="https:// a link to add (optional)"
        value={link}
        onChange={(event) => setLink(event.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={!!busy || !body.trim() || problems.length > 0}
        >
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Save draft'}
        </Button>
        {editing && <Button onClick={done}>Cancel</Button>}
        <span className={cx('text-[12px]', problems.length > 0 ? 'text-c-danger' : 'text-c-fg3')}>
          {problems[0] ?? `${length} of ${network.limit}`}
        </span>
      </div>
      <Note note={note} />
    </form>
  )
}

function PostCard({
  post,
  label,
  canSend,
  edit,
}: {
  post: Post
  label: string
  canSend: boolean
  edit: () => void
}) {
  const { busy, note, act } = useAct()
  const [when, setWhen] = useState('')
  const held = post.status === 'draft' || post.status === 'failed' || post.status === 'scheduled'

  return (
    <li className={card}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{label}</span>
        <span
          className={cx(
            'bg-c-hov rounded-md px-1.5 py-0.5 text-[11px]',
            post.status === 'failed' ? 'text-c-danger' : 'text-c-fg2',
          )}
        >
          {POST_WORDS[post.status]}
        </span>
        <span className="text-c-fg3 text-[12px]">
          {post.status === 'scheduled' && post.scheduledAt
            ? `for ${new Date(post.scheduledAt).toLocaleString()}`
            : post.status === 'published' && post.publishedAt
              ? relativeTime(post.publishedAt)
              : `written ${relativeTime(post.createdAt)}${post.createdByName ? ` by ${post.createdByName}` : ''}`}
        </span>
        {post.externalUrl && (
          <a
            href={post.externalUrl}
            target="_blank"
            rel="noreferrer"
            className="text-c-accent text-[12px] hover:underline"
          >
            Open it
          </a>
        )}
      </div>
      <p className="mt-2 whitespace-pre-wrap">{post.body}</p>
      {post.link && <p className="text-c-fg2 mt-1 truncate text-[12px]">{post.link}</p>}
      {post.note && <p className="text-c-danger mt-2 text-[12px]">{post.note}</p>}
      {post.overdue && (
        <p className="text-c-danger mt-2 text-[12px]">
          No answer has come back. Look at the channel: if the post is not there, say so and you can
          send it again.
        </p>
      )}

      {held && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Button
            variant="primary"
            disabled={!!busy || !canSend}
            onClick={() => {
              if (
                window.confirm(`Publish this to ${label} now? It can't be taken back from here.`)
              ) {
                void act(
                  'publish',
                  async () => (await publishPostFn({ data: { id: post.id } })).message,
                )
              }
            }}
          >
            {busy === 'publish' ? 'Publishing…' : 'Publish now'}
          </Button>
          {post.status === 'scheduled' ? (
            <Button
              disabled={!!busy}
              onClick={() =>
                act(
                  'unschedule',
                  async () => void (await unschedulePostFn({ data: { id: post.id } })),
                )
              }
            >
              Unschedule
            </Button>
          ) : (
            <>
              <input
                aria-label="When to publish"
                type="datetime-local"
                className={cx(inputClass, 'h-7 w-auto! py-0!')}
                min={localInput(new Date())}
                value={when}
                onChange={(event) => setWhen(event.target.value)}
              />
              <Button
                disabled={!!busy || !when || !canSend}
                onClick={() =>
                  act(
                    'schedule',
                    async () =>
                      void (await schedulePostFn({
                        data: { id: post.id, at: new Date(when).toISOString() },
                      })),
                  )
                }
              >
                Schedule
              </Button>
            </>
          )}
          <Button variant="ghost" disabled={!!busy} onClick={edit}>
            Edit
          </Button>
          <Button
            variant="danger"
            disabled={!!busy}
            onClick={() => {
              if (window.confirm('Delete this post?')) {
                void act('delete', async () => void (await deletePostFn({ data: { id: post.id } })))
              }
            }}
          >
            Delete
          </Button>
        </div>
      )}
      {post.overdue && (
        <div className="mt-3">
          <Button
            disabled={!!busy}
            onClick={() =>
              act('release', async () => void (await releasePostFn({ data: { id: post.id } })))
            }
          >
            It did not go out
          </Button>
        </div>
      )}
      <div className="mt-2 empty:hidden">
        <Note note={note} />
      </div>
    </li>
  )
}

/** A channel or an ad account that can't be used yet, and what to do about it. */
function Blocked({ label, problem }: { label: string; problem: string }) {
  return (
    <p className="text-c-danger flex items-start gap-1 px-1">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {label}: {problem}
      </span>
    </p>
  )
}

function Posts({ data }: { data: Data }) {
  const [editing, setEditing] = useState<Post | null>(null)
  const { channels } = data
  const throughEngine = channels.some((c) => c.delivery === 'swirls' && !c.problem)

  if (channels.length === 0) {
    return (
      <p className={cx(card, 'text-c-fg2')}>
        No channels yet. Add the pages you post to under <code>marketing.channels</code> in{' '}
        <code>crm.config.json</code>.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {channels.map(
        (c) => c.problem && <Blocked key={c.key} label={c.label} problem={c.problem} />,
      )}
      {throughEngine && !data.unattended && (
        <p className="text-c-fg2 px-1">
          Posts that go through Swirls need SWIRLS_API_KEY to be scheduled, because nobody is signed
          in when they fall due. Publish now works without it.
        </p>
      )}
      <Composer
        key={editing?.id ?? 'new'}
        channels={channels}
        editing={editing}
        done={() => setEditing(null)}
      />
      {data.posts.length === 0 ? (
        <p className="text-c-fg2 px-1">Nothing written yet.</p>
      ) : (
        <ul className="space-y-2">
          {data.posts.map((post) => (
            <PostCard
              key={post.id}
              post={post}
              label={channels.find((c) => c.key === post.channel)?.label ?? post.channel}
              canSend={channels.some((c) => c.key === post.channel && !c.problem)}
              edit={() => setEditing(post)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

const whole = new Intl.NumberFormat()

function money(value: number, currency: string | null): string {
  if (!currency) {
    return value.toFixed(2)
  }

  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value)
  } catch {
    return `${value.toFixed(2)} ${currency}`
  }
}

function AdAccount({ label, network, rows }: { label: string; network: string; rows: Ad[] }) {
  const first = rows[0]
  const currency = first?.currency ?? null
  const spend = rows.reduce((sum, ad) => sum + ad.spend, 0)
  const results = rows.reduce((sum, ad) => sum + ad.conversions, 0)
  const each = costPer(spend, results)

  return (
    <section className={card}>
      <h3 className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{label}</span>
        <span className="text-c-fg3 text-[12px]">{network}</span>
        {first && (
          <span className="text-c-fg3 ml-auto text-[12px]">
            Last {first.periodDays} days, read {relativeTime(first.syncedAt)}
          </span>
        )}
      </h3>
      {rows.length === 0 ? (
        <p className="text-c-fg2 mt-2">Nothing read yet.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-c-fg3 text-[12px]">
              <tr>
                <th className="py-1 pr-3 font-normal">Campaign</th>
                <th className="py-1 pr-3 font-normal">Status</th>
                <th className="py-1 pr-3 text-right font-normal">Spent</th>
                <th className="py-1 pr-3 text-right font-normal">Shown</th>
                <th className="py-1 pr-3 text-right font-normal">Clicks</th>
                <th className="py-1 pr-3 text-right font-normal">Click rate</th>
                <th className="py-1 pr-3 text-right font-normal">Results</th>
                <th className="py-1 text-right font-normal">Cost each</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((ad) => {
                const rate = clickRate(ad.clicks, ad.impressions)
                const cost = costPer(ad.spend, ad.conversions)
                return (
                  <tr key={ad.id} className="border-c-line border-t">
                    <td className="max-w-64 truncate py-1.5 pr-3">{ad.name}</td>
                    <td className="text-c-fg2 py-1.5 pr-3">{ad.status}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {money(ad.spend, ad.currency)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {whole.format(ad.impressions)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {whole.format(ad.clicks)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {rate === null ? '' : `${rate.toFixed(2)}%`}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {whole.format(ad.conversions)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {cost === null ? '' : money(cost, ad.currency)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-c-line border-t font-medium">
                <td className="py-1.5 pr-3" colSpan={2}>
                  Total
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{money(spend, currency)}</td>
                <td colSpan={3} />
                <td className="py-1.5 pr-3 text-right tabular-nums">{whole.format(results)}</td>
                <td className="py-1.5 text-right tabular-nums">
                  {each === null ? '' : money(each, currency)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}

function Ads({ data }: { data: Data }) {
  const { busy, note, act } = useAct()
  const accounts: Account[] = data.accounts

  if (accounts.length === 0) {
    return (
      <p className={cx(card, 'text-c-fg2')}>
        No ad accounts yet. Add them under <code>marketing.ads</code> in{' '}
        <code>crm.config.json</code>.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <p className="text-c-fg2 flex-1">
          What each campaign spent and brought in. Budgets and bids are changed in the ad network.
        </p>
        <Button
          disabled={!!busy || accounts.every((a) => a.problem)}
          onClick={() => act('ads', async () => (await syncAdsFn()).message)}
        >
          {busy === 'ads' ? 'Reading…' : 'Read again'}
        </Button>
      </div>
      <Note note={note} />
      {accounts.map(
        (a) => a.problem && <Blocked key={a.key} label={a.label} problem={a.problem} />,
      )}
      {accounts.map((a) => (
        <AdAccount
          key={a.key}
          label={a.label}
          network={a.network}
          rows={data.ads.filter((ad) => ad.account === a.key)}
        />
      ))}
    </div>
  )
}

export function Marketing(): ReactNode {
  const data = route.useLoaderData()
  const { tab = 'website' } = route.useSearch()
  const navigate = route.useNavigate()
  const marketing = layout.useRouteContext().config?.marketing

  return (
    <>
      <TopBar icon={<Megaphone className="text-c-fg2 size-3.5" />} title="Marketing" />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-3xl space-y-3">
          {!data || !marketing ? (
            <p className={cx(card, 'text-c-fg2')}>
              Marketing is not set up. Add a <code>marketing</code> block with your website to{' '}
              <code>crm.config.json</code>.
            </p>
          ) : (
            <>
              <div role="tablist" className="border-c-line flex gap-1 border-b px-1">
                {TABS.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={tab === key}
                    onClick={() => void navigate({ search: { tab: key } })}
                    className={cx(
                      '-mb-px border-b-2 px-2.5 py-1.5 font-medium',
                      tab === key
                        ? 'border-c-accent text-c-fg'
                        : 'text-c-fg2 hover:text-c-fg border-transparent',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {tab === 'website' && (
                <Website data={data} tags={tagReport(marketing.tags, data.site.tags)} />
              )}
              {tab === 'posts' && <Posts data={data} />}
              {tab === 'ads' && <Ads data={data} />}
            </>
          )}
        </div>
      </div>
    </>
  )
}

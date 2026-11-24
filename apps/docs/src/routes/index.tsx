import { createFileRoute, Link } from '@tanstack/react-router'

import { AskPanel } from '../components/ask-panel'
import { CodeBlock } from '../components/code-block'
import { CopyPrompt } from '../components/copy-prompt'
import { LandingCrm } from '../components/landing-crm'
import { SpoolBuilder } from '../components/spool-builder'
import { Illustration } from '../illustrations/illustration'
import { repositoryUrl, siteUrl } from '../site'

const title = 'Spools: Vibe code your entire CRM on rock-solid engineering'

const description =
  'Spools is an open source CRM framework. It gives your coding agents the sign-in, data layer, security, search, email and tests, so they only write what is specific to your business.'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title },
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      {
        property: 'og:description',
        content: 'The open source CRM framework for coding agents.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:url', content: `${siteUrl}/` },
      { name: 'twitter:card', content: 'summary' },
    ],
    links: [{ rel: 'canonical', href: `${siteUrl}/` }],
  }),
  component: Landing,
})

const parts = [
  {
    file: 'crm.config.json',
    title: 'Your business',
    text: 'Objects, fields, pipelines, automations and email sequences.',
  },
  {
    file: 'src/spool.server.ts',
    title: 'Your services',
    text: 'Sign-in, database, files, email, encryption and agents.',
  },
  {
    file: 'src/app, src/routes',
    title: 'Your code',
    text: 'Hooks, handlers, pages and endpoints of your own.',
  },
] as const

/** What is already engineered. Each line is something the code does: see docs/security.md and docs/architecture.md. */
const foundations = [
  {
    title: 'Access checked on every request',
    text: 'Pages and endpoints check the session and the access list. Lint refuses one your agent writes without the check.',
  },
  {
    title: 'Typed Postgres tables',
    text: 'Each object is a table in your database, with migrations and row-level security.',
  },
  {
    title: 'Each email sent once',
    text: 'Sequences keep their place through a restart, and two servers never send the same email.',
  },
  {
    title: 'Secrets kept on the server',
    text: 'Tokens are sealed before they are stored, and the build fails if server code built on Effect reaches the browser.',
  },
  {
    title: 'Time limits on outside calls',
    text: 'Failures are typed with Effect, and calls are retried where that is safe.',
  },
  {
    title: 'More than 500 tests',
    text: 'The server tests run on all three database adapters.',
  },
] as const

const benefits = [
  {
    illustration: 'adapters',
    title: 'Use the services you already have',
    text: 'Bring Clerk, Supabase, Resend or S3. Each one is a line you can change.',
    link: 'See the adapters →',
    slug: 'adapters',
  },
  {
    illustration: 'store',
    title: 'Own your customer data',
    text: 'Records are ordinary tables in your Postgres, so your other software can read them.',
    link: 'Choose a database →',
    slug: 'database',
  },
  {
    illustration: 'agents',
    title: 'Put agents to work on records',
    text: 'The assistant and your Swirls workflows go through the same checks, hooks and timeline as your team.',
    link: 'Add an assistant →',
    slug: 'swirls',
  },
] as const

function Landing() {
  return (
    <main id="main-content" className="mx-auto max-w-[68rem] px-5 py-14 md:px-8 md:py-20">
      <div className="grid items-center gap-10 lg:grid-cols-2">
        <div className="min-w-0">
          <p className="text-muted mb-5 font-mono text-xs tracking-[0.08em] uppercase">
            Open source CRM framework
          </p>
          <h1 className="text-foreground mb-6 text-[clamp(2rem,3.5vw,2.8rem)] leading-[1.12] font-semibold tracking-[-0.035em]">
            Vibe code your entire CRM on <span className="whitespace-nowrap">rock-solid</span>{' '}
            engineering
          </h1>
          <p className="text-[1.1rem] leading-[1.65]">
            Spools gives your coding agents the sign-in, data layer, security, search, email and
            tests, so they only write what is specific to your business.
          </p>
          <CopyPrompt className="mt-7" />
          <div className="my-7 flex flex-wrap items-center gap-5 text-[0.9rem]">
            <Link to="/docs/$slug" params={{ slug: 'quickstart' }}>
              Start by hand →
            </Link>
            <Link to="/docs/$slug" params={{ slug: 'when-to-use' }}>
              When to use Spools
            </Link>
          </div>
        </div>
        <figure className="hero-spool mx-auto w-full max-w-[34rem]">
          <Illustration name="spool" className="block h-auto w-full" />
          <figcaption className="text-muted -mt-3 text-center font-mono text-xs">
            Your config, services and code in one CRM
          </figcaption>
        </figure>
      </div>

      <section className="mt-28 max-[640px]:mt-18">
        <h2 className="text-foreground mb-4 text-[1.8rem] leading-[1.25] font-medium tracking-[-0.025em]">
          Describe your business and let your agents build the CRM
        </h2>
        <p className="mb-4 max-w-[44rem] leading-[1.75]">
          They work in three places, and Spools handles everything underneath. You can{' '}
          <Link to="/docs/$slug" params={{ slug: 'coding-agents' }} hash="moving-from-another-crm">
            import your records
          </Link>{' '}
          from HubSpot, Salesforce or a spreadsheet.
        </p>
        <div
          className="mt-8 mb-6 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-stretch gap-4 max-[640px]:grid-cols-1"
          aria-label="What your agents write"
        >
          {parts.flatMap((part, index) => [
            ...(index > 0
              ? [
                  <span
                    key={`plus-${part.file}`}
                    className="text-muted self-center max-[640px]:justify-self-center"
                    aria-hidden="true"
                  >
                    +
                  </span>,
                ]
              : []),
            <div key={part.file} className="border-line bg-background-subtle rounded-md border p-5">
              <small className="text-muted mb-[0.6rem] block font-mono">{part.file}</small>
              <strong className="text-foreground block">{part.title}</strong>
              <p className="mt-2 mb-0 text-[0.9rem]">{part.text}</p>
            </div>,
          ])}
        </div>
        <Link to="/docs/$slug" params={{ slug: 'coding-agents' }} className="text-[0.9rem]">
          Build with coding agents →
        </Link>
      </section>

      <section className="mt-28 grid items-start gap-10 max-[640px]:mt-18 md:grid-cols-2">
        <div className="min-w-0">
          <h2 className="text-foreground mb-4 text-[1.8rem] leading-[1.25] font-medium tracking-[-0.025em]">
            Ask for changes in plain English
          </h2>
          <p className="mb-4 max-w-[44rem] leading-[1.75]">
            Open your Spool in Claude Code, Cursor or Codex and say what you need. Most changes are
            a few lines you can read, and one command tells your agent what to fix.
          </p>
          <Link to="/docs/$slug" params={{ slug: 'quickstart' }} className="text-[0.9rem]">
            Make your first change →
          </Link>
        </div>
        <AskPanel />
      </section>

      <section className="mt-28 max-[640px]:mt-18">
        <h2 className="text-foreground mb-4 text-[1.8rem] leading-[1.25] font-medium tracking-[-0.025em]">
          Access, data, security and email come built in
        </h2>
        <p className="mb-8 max-w-[44rem] leading-[1.75]">
          Your agents build on code that is already written and tested.
        </p>
        <dl className="border-line m-0 grid border-t border-l sm:grid-cols-2 lg:grid-cols-3">
          {foundations.map((foundation) => (
            <div key={foundation.title} className="border-line border-r border-b p-5">
              <dt className="text-foreground font-medium">{foundation.title}</dt>
              <dd className="m-0 mt-2 text-[0.9rem] leading-[1.6]">{foundation.text}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-6 flex flex-wrap gap-5 text-[0.9rem]">
          <Link to="/docs/$slug" params={{ slug: 'security' }}>
            Read the security guide →
          </Link>
          <Link to="/docs/$slug" params={{ slug: 'architecture' }}>
            See the architecture →
          </Link>
        </div>
      </section>

      <section className="mt-28 grid gap-10 max-[640px]:mt-18 md:grid-cols-3">
        {benefits.map((benefit) => (
          <div key={benefit.slug} className="min-w-0">
            <Illustration name={benefit.illustration} className="block h-auto w-full" />
            <h2 className="text-foreground mb-4 text-[1.15rem] leading-[1.25] font-medium tracking-[-0.025em]">
              {benefit.title}
            </h2>
            <p className="mb-4">{benefit.text}</p>
            <Link to="/docs/$slug" params={{ slug: benefit.slug }} className="text-[0.9rem]">
              {benefit.link}
            </Link>
          </div>
        ))}
      </section>

      <SpoolBuilder />

      <section className="mt-28 grid items-start gap-10 max-[640px]:mt-18 md:grid-cols-2">
        <div className="min-w-0">
          <h2 className="text-foreground mb-4 text-[1.8rem] leading-[1.25] font-medium tracking-[-0.025em]">
            Get tables, boards and records from one config
          </h2>
          <p className="mb-4 max-w-[44rem] leading-[1.75]">
            A few lines give you inline editing, filters, totals and links your team can share.
          </p>
          <Link
            to="/docs/$slug"
            params={{ slug: 'configuration' }}
            hash="views"
            className="text-[0.9rem]"
          >
            See every view option →
          </Link>
        </div>
        <LandingCrm />
      </section>

      <section className="mt-28 max-[640px]:mt-18">
        <h2 className="text-foreground mb-4 text-[1.8rem] leading-[1.25] font-medium tracking-[-0.025em]">
          Make your first Spool
        </h2>
        <p className="mb-4 max-w-[44rem] leading-[1.75]">
          Give your agent the prompt, or run one command yourself. It runs on your machine with demo
          data and no accounts.
        </p>
        <CopyPrompt className="mt-7" />
        <CodeBlock lang="bash" className="mb-0! max-w-[34rem]">
          {'bun create @swirls/spools my-crm'}
        </CodeBlock>
        <div className="my-7 flex flex-wrap items-center gap-5">
          <Link to="/docs/$slug" params={{ slug: 'quickstart' }} className="text-[0.9rem]">
            Quickstart →
          </Link>
          <Link to="/docs/$slug" params={{ slug: 'deployment' }} className="text-[0.9rem]">
            Deployment guide
          </Link>
          <a href={repositoryUrl} className="text-[0.9rem]">
            Source on GitHub
          </a>
        </div>
        <footer className="text-muted mt-20 flex flex-wrap gap-6 text-[0.85rem]">
          <span className="mr-auto">Spools by ByteSlice</span>
          <Link to="/docs/$slug" params={{ slug: 'api' }}>
            API reference
          </Link>
          <Link to="/docs/$slug" params={{ slug: 'security' }}>
            Security
          </Link>
          <Link to="/docs/$slug" params={{ slug: 'architecture' }}>
            Architecture
          </Link>
        </footer>
      </section>
    </main>
  )
}

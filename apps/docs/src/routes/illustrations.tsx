import { createFileRoute, Link } from '@tanstack/react-router'

import { Illustration } from '../illustrations/illustration'
import { illustrationNames, illustrations } from '../illustrations/scenes'

export const Route = createFileRoute('/illustrations')({ component: IllustrationGallery })

function IllustrationGallery() {
  return (
    <main
      id="main-content"
      className="illustration-gallery mx-auto max-w-[68rem] px-5 py-16 md:px-8 md:py-24"
    >
      <div className="mb-14 max-w-[43rem]">
        <p className="text-muted mb-5 font-mono text-xs tracking-widest uppercase">
          Spools / Illustrations / 001
        </p>
        <h1 className="text-foreground mb-5 text-4xl leading-tight font-medium tracking-tight md:text-5xl">
          See how a Spool fits together
        </h1>
        <p className="text-body max-w-[35rem] text-lg leading-relaxed">
          Drawings of the parts of Spools, in the same style as the ones for Looms. Download any of
          them as an SVG.
        </p>
      </div>
      <div className="border-line grid grid-cols-2 border-t max-[640px]:grid-cols-1">
        {illustrationNames.map((name) => {
          const item = illustrations[name]

          return (
            <article
              key={name}
              className="border-line border-b p-8 pb-10 odd:border-r odd:pl-0 even:pr-0 max-[640px]:border-r-0 max-[640px]:px-0 max-[640px]:pt-6 max-[640px]:pb-8"
            >
              <p className="text-muted m-0 font-mono text-[11px] tracking-widest uppercase">
                FIG. {item.number} / {item.label}
              </p>
              <Illustration name={name} className="my-2 mb-6 block h-auto w-full" />
              <h2 className="text-foreground mt-0 mb-3 text-xl font-medium tracking-tight">
                {item.title}
              </h2>
              <p className="text-muted m-0 max-w-[26rem] text-sm leading-relaxed">
                {item.description}
              </p>
              <div className="mt-5 flex gap-5 font-mono text-[11px]">
                <a href={`/illustrations/${name}-light.svg`} download>
                  SVG / Light ↗
                </a>
                <a href={`/illustrations/${name}-dark.svg`} download>
                  SVG / Dark ↗
                </a>
              </div>
            </article>
          )
        })}
        <aside className="border-line flex flex-col justify-center border-b p-8 pb-10 odd:border-r odd:pl-0 even:pr-0 max-[640px]:border-r-0 max-[640px]:px-0 max-[640px]:pt-6 max-[640px]:pb-8">
          <p className="text-muted mb-5 font-mono text-[11px] tracking-widest uppercase">
            Drawing another
          </p>
          <h2 className="text-foreground mb-4 text-2xl font-medium tracking-tight">
            Draw another one
          </h2>
          <p className="text-muted max-w-[24rem] text-sm leading-relaxed">
            Each drawing is a React component made from a few shared shapes, so a new one matches
            the rest.
          </p>
          <Link to="/docs/$slug" params={{ slug: 'architecture' }} className="mt-6 text-sm">
            Read about the architecture →
          </Link>
        </aside>
      </div>
    </main>
  )
}

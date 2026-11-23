import {
  Anchor,
  Disk,
  Ground,
  Plate,
  Register,
  Rows,
  Spool,
  Stitch,
  Thread,
  trace,
} from './primitives'

const strands = ['spool-thread-config', 'spool-thread-services', 'spool-thread-code'] as const

/** Three threads, one spool: what a CRM built with Spools is made of. */
function Hero() {
  return (
    <>
      <Ground />
      <Spool
        at={[0, 0, -70]}
        radius={98}
        height={168}
        turns={18}
        strand={(turn) => strands[turn % 3]}
        active
      />
      <g strokeWidth="1.8" fill="none">
        <path className={strands[0]} d="M112,12 C52,96 206,64 178,150 S190,186 239.2,214" />
        <path className={strands[1]} d="M320,12 C378,40 268,56 306,92 Q320,104 320,117" />
        <path className={strands[2]} d="M528,12 C588,96 434,64 462,150 S450,186 400.8,214" />
      </g>
      <g className="spool-labels" fill="var(--text-body)" stroke="none" textAnchor="middle">
        <text x="112" y="-8">
          your config
        </text>
        <text x="320" y="-8">
          your services
        </text>
        <text x="528" y="-8">
          your code
        </text>
      </g>
    </>
  )
}

/** One sheet of config rises into a table, a board and a record. */
function Config() {
  return (
    <>
      <Ground />
      <Plate at={[-112, 0, -30]} width={104} depth={150} height={10} active>
        <Register x={-40} y={-62} />
        <path
          d="M-34,-30 H20 M-22,-18 H30 M-22,-6 H14 M-22,6 H26 M-34,18 H8 M-22,30 H30 M-22,42 H18"
          stroke="var(--art-accent)"
          fill="none"
        />
      </Plate>
      {[-104, 0, 104].map((y) => (
        <g key={y}>
          <Thread
            points={[
              [-60, 0, -30],
              [-22, 0, -30],
              [-22, y, -30],
              [70, y, -30],
              [70, y, 22],
            ]}
            accent={y === 0}
          />
          <Anchor at={[-22, y, -30]} active={y === 0} />
        </g>
      ))}
      <Plate at={[122, -108, 34]} width={112} depth={82} height={8}>
        <path
          d="M-38,-24 H38 M-38,-8 H38 M-38,8 H38 M-38,24 H38 M-12,-24 V24 M16,-24 V24"
          stroke="var(--art-detail)"
          fill="none"
        />
      </Plate>
      <Plate at={[122, 0, 34]} width={112} depth={82} height={8} active>
        <path
          d="M-38,-26 H-18 V-6 H-38 Z M-38,0 H-18 V22 H-38 Z M-10,-26 H10 V10 H-10 Z M18,-26 H38 V-10 H18 Z"
          stroke="var(--art-accent)"
          fill="none"
        />
      </Plate>
      <Plate at={[122, 108, 34]} width={112} depth={82} height={8}>
        <path
          d="M-38,-24 H-8 M-38,-10 H-16 M-38,4 H-8 M-38,18 H-20 M6,-24 V24 M16,-18 H38 M16,-2 H32 M16,14 H38"
          stroke="var(--art-detail)"
          fill="none"
        />
      </Plate>
    </>
  )
}

/** Parts fit the same sockets on one base; one is being changed for another. */
function Adapters() {
  return (
    <>
      <Ground />
      <Plate at={[0, 0, -60]} width={280} depth={280} height={14}>
        {[-70, 70].flatMap((x) =>
          [-70, 70].map((y) => (
            <rect
              key={`${x}-${y}`}
              x={x - 50}
              y={y - 50}
              width="100"
              height="100"
              rx="4"
              fill="none"
              stroke="var(--art-detail)"
              strokeDasharray="3 4"
            />
          )),
        )}
      </Plate>
      {[
        [66, -66],
        [-66, 66],
      ].map(([x = 0, y = 0]) => (
        <Thread
          key={`${x}-${y}`}
          points={[
            [x, y, -58],
            [x, y, 96],
          ]}
          dashed
        />
      ))}
      <Plate at={[-70, -70, -20]} width={96} height={36}>
        <Register x={-36} y={-36} />
        <path
          d="M-8,-12 a8,8 0 1 1 16,0 a8,8 0 1 1 -16,0 M-16,22 a16,14 0 0 1 32,0"
          stroke="var(--art-detail)"
          fill="none"
        />
      </Plate>
      <Plate at={[70, -70, 18]} width={96} height={24}>
        <Rows count={4} width={48} />
      </Plate>
      <Plate at={[70, -70, 108]} width={96} height={24} active>
        <Register x={-36} y={-36} />
        <Stitch size={34} />
      </Plate>
      <Plate at={[-70, 70, -20]} width={96} height={36}>
        <Register x={-36} y={-36} />
        <path
          d="M-24,-16 H24 V18 H-24 Z M-24,-16 L0,6 L24,-16"
          stroke="var(--art-detail)"
          fill="none"
        />
      </Plate>
      <Plate at={[70, 70, -20]} width={96} height={36}>
        <Register x={-36} y={-36} />
        <path d="m-17,0 12,12 24,-28" stroke="var(--art-detail)" fill="none" />
      </Plate>
    </>
  )
}

/** Records rest on a database that is yours. */
function Store() {
  return (
    <>
      <Ground />
      {[-58, -26, 6].map((z) => (
        <Disk key={z} at={[0, 0, z]} radius={104} height={26}>
          <circle r="86" fill="none" stroke="var(--art-detail)" strokeDasharray="2 5" />
        </Disk>
      ))}
      {[-34, 34].flatMap((x) =>
        [-34, 34].map((y) => (
          <Thread
            key={`${x}-${y}`}
            points={[
              [x, y, 8],
              [x, y, 92],
            ]}
            dashed
          />
        )),
      )}
      <Plate at={[0, 0, 104]} width={128} depth={96} height={9} active>
        <path
          d="M-48,-32 H48 M-48,-16 H48 M-48,0 H48 M-48,16 H48 M-48,32 H48 M-18,-32 V32 M16,-32 V32"
          stroke="var(--art-accent)"
          fill="none"
        />
      </Plate>
      <Anchor at={[34, 34, 8]} active />
      <Anchor at={[-34, 34, 8]} />
      <Anchor at={[34, -34, 8]} />
    </>
  )
}

/** People and agents reach the same records through the same rules. */
function Agents() {
  return (
    <>
      <Ground />
      {[-52, -30].map((z) => (
        <Plate key={z} at={[95, 0, z]} width={120} depth={176} height={9}>
          <Register x={-46} y={-72} />
          <Rows count={8} width={62} />
        </Plate>
      ))}
      <Plate at={[95, 0, -6]} width={120} depth={176} height={10}>
        <Register x={-46} y={-72} />
        <Rows count={8} width={62} />
      </Plate>
      <Plate at={[-28, 0, 10]} width={58} depth={176} height={14} active>
        <path d="m-14,0 10,10 20,-22" stroke="var(--art-accent)" fill="none" strokeWidth="1.4" />
      </Plate>
      <Thread
        points={[
          [0, 0, 10],
          [36, 0, 10],
        ]}
        accent
      />
      {[-62, 62].map((y) => (
        <Thread
          key={y}
          points={[
            [-112, y, 48],
            [-58, y, 48],
            [-58, y, 12],
          ]}
          accent
        />
      ))}
      <Plate at={[-138, -62, 48]} width={82} height={9}>
        <path
          d="M-9,-10 a9,9 0 1 1 18,0 a9,9 0 1 1 -18,0 M-18,24 a18,15 0 0 1 36,0"
          stroke="var(--art-detail)"
          fill="none"
        />
      </Plate>
      <Plate at={[-138, 62, 48]} width={82} height={9} active>
        <Stitch size={34} />
      </Plate>
      <Anchor at={[-58, -62, 48]} active />
      <Anchor at={[-58, 62, 48]} active />
    </>
  )
}

/** Emails wait their turn along one thread, each place kept in the database. */
function Sequence() {
  return (
    <>
      <Ground />
      <Plate at={[0, 60, -58]} width={300} depth={96} height={10}>
        <path
          d="M-126,-24 H126 M-126,-8 H126 M-126,8 H126 M-126,24 H126 M-60,-34 V34 M20,-34 V34 M86,-34 V34"
          stroke="var(--art-detail)"
          fill="none"
        />
      </Plate>
      <Thread
        points={[
          [-190, -50, 40],
          [190, -50, 40],
        ]}
        accent
      />
      {[-120, 0, 120].map((x, index) => (
        <g key={x}>
          <Thread
            points={[
              [x, -50, 40],
              [x, 60, 40],
              [x, 60, -56],
            ]}
            dashed
            accent={index < 2}
          />
          <Plate at={[x, -50, 58]} width={78} depth={58} height={7} active={index < 2}>
            <path
              d="M-26,-16 H26 V16 H-26 Z M-26,-16 L0,4 L26,-16"
              stroke={index < 2 ? 'var(--art-accent)' : 'var(--art-detail)'}
              fill="none"
            />
          </Plate>
          <Anchor at={[x, 60, -56]} active={index < 2} />
        </g>
      ))}
    </>
  )
}

/** A spool whose thread runs out to an outline with nothing in it. */
function NotFound() {
  return (
    <>
      <Ground />
      <Spool at={[-95, -40, -52]} radius={62} height={112} turns={9} active />
      <Thread
        points={[
          [-38, -10, -30],
          [64, -10, -30],
        ]}
        accent
      />
      <Anchor at={[64, -10, -30]} active />
      <Thread
        points={[
          [78, -10, -30],
          [130, -10, -30],
          [130, 34, -30],
        ]}
        accent
        dashed
      />
      <g fill="none" stroke="var(--art-detail)" strokeWidth="1" strokeDasharray="4 5">
        <path
          d={trace([
            [85, 35, -30],
            [185, 35, -30],
            [185, 135, -30],
            [85, 135, -30],
            [85, 35, -30],
          ])}
        />
        <path
          d={trace([
            [85, 135, -30],
            [85, 135, -42],
            [185, 135, -42],
            [185, 135, -30],
          ])}
        />
        <path
          d={trace([
            [185, 35, -30],
            [185, 35, -42],
            [185, 135, -42],
          ])}
        />
      </g>
      <Anchor at={[135, 85, -30]} />
    </>
  )
}

/** The spool is whole; the thread leaving it has snapped. */
function ServerError() {
  return (
    <>
      <Ground />
      <Spool at={[-95, -20, -52]} radius={66} height={118} turns={10} />
      <Thread
        points={[
          [-32, 12, -26],
          [34, 12, -26],
        ]}
        accent
      />
      <Anchor at={[34, 12, -26]} active />
      <Thread
        points={[
          [64, 12, -26],
          [98, 12, -26],
        ]}
        accent
        dashed
      />
      <Anchor at={[64, 12, -26]} />
      <Plate at={[146, 12, -26]} width={96} height={12} active>
        <path
          d="M-16,-16 L16,16 M16,-16 L-16,16"
          stroke="var(--art-accent)"
          strokeWidth="1.4"
          fill="none"
        />
      </Plate>
    </>
  )
}

export const illustrations = {
  spool: {
    number: '00',
    title: 'Config, services and code in one CRM',
    label: 'Spool',
    description:
      'A Spool is a config that describes your business, the services it runs on, and your own code.',
    alt: 'An isometric spool wound with three colored threads labeled your config, your services, and your code.',
    component: Hero,
  },
  config: {
    number: '01',
    title: 'One config makes every view',
    label: 'Configuration',
    description:
      'Objects and fields are described once. Tables, boards, forms, and record pages are made from them.',
    alt: 'A sheet of config connects to three raised surfaces: a table, a board, and a record page.',
    component: Config,
  },
  adapters: {
    number: '02',
    title: 'Change a service without changing the CRM',
    label: 'Adapters',
    description:
      'Sign-in, database, files, email, encryption, and agents each fit a small contract, so any of them can be replaced.',
    alt: 'Four parts sit in matching sockets on one base. A new part is lifted above the one it replaces.',
    component: Adapters,
  },
  store: {
    number: '03',
    title: 'Keep records in your own Postgres',
    label: 'Store',
    description:
      'Every object is a table with typed columns in a database you run. The same CRM works on any Postgres.',
    alt: 'A table of records rests above a three-layer database, joined by four threads.',
    component: Store,
  },
  agents: {
    number: '04',
    title: 'People and agents follow the same rules',
    label: 'Service layer',
    description:
      'The interface, your workflows, and the assistant change records through one service, which checks access, runs hooks, and keeps the timeline.',
    alt: 'A person and an agent connect to one checkpoint, which leads to a stack of records.',
    component: Agents,
  },
  sequence: {
    number: '05',
    title: 'Every email keeps its place',
    label: 'Email sequences',
    description:
      'Each enrollment is a row in Postgres with the next email and when it is due, so a restart loses nothing.',
    alt: 'Three emails along a thread, each tied by a dashed line to a row in a table.',
    component: Sequence,
  },
  'not-found': {
    number: '06',
    title: 'Page not found',
    label: 'Not found',
    description: 'A thread leaves the spool and reaches a dashed outline with nothing in it.',
    alt: 'A spool with a thread that runs to an empty dashed outline.',
    component: NotFound,
  },
  error: {
    number: '07',
    title: 'Something went wrong',
    label: 'Server error',
    description: 'The spool is whole, and the thread leaving it has snapped.',
    alt: 'A spool with a snapped thread and a plate marked with a cross.',
    component: ServerError,
  },
} as const

export type IllustrationName = keyof typeof illustrations

export const illustrationNames = [
  'config',
  'adapters',
  'store',
  'agents',
  'sequence',
  'not-found',
  'error',
] as const satisfies readonly IllustrationName[]

import { z } from 'zod'

import { fieldSchema, ident, isTextLike } from './field-types'
import { isFolderName } from './files'
import { cleanFilters, cleanSort, resolveTarget, SYSTEM_COLUMNS } from './filters'
import { checkGuides } from './guides'
import { durationPattern } from './sequences'

export { type CrmField, fieldSchema } from './field-types'

/**
 * The contract for crm.config.json. Everything the CRM renders, stores, and
 * automates is derived from a config that satisfies this schema.
 *
 * Run `bun run crm:gen` after editing the config: it validates the file,
 * regenerates prisma/schema.prisma and crm.config.schema.json, and emits the
 * Prisma contract.
 */

/**
 * What an action or automation runs, as "<kind>:<name>". Built-in kinds:
 *   swirls:<workflow>   a deployed Swirls workflow, by name
 *   campaign:<key>      enroll the record in a campaign from `campaigns`
 *   local:<handler>     a handler from src/app/extensions.ts
 * Extensions can register more kinds; `crm:gen` and server start-up verify every
 * target resolves.
 */
const runTarget = z
  .string()
  .regex(
    /^[a-z][a-zA-Z0-9]*:[A-Za-z0-9_.-]+$/,
    'use "<kind>:<name>", e.g. "swirls:<workflow>", "campaign:<key>" or "local:<handler>"',
  )

export { durationPattern } from './sequences'

/** A time of day on a 24-hour clock, "08:00". */
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use a 24-hour time such as "08:00"')

const campaignStepSchema = z.object({
  id: ident,
  /** Delay before this step, relative to the previous one. */
  wait: z.string().regex(durationPattern, 'use a duration like "0m", "2h" or "3d"'),
  subject: z.string().min(1),
  /** Plain text. `{{field}}` placeholders are replaced with the record's values. */
  body: z.string().min(1),
})

const campaignSchema = z.object({
  label: z.string(),
  /** Object whose records can be enrolled. */
  object: ident,
  /** An `email` field on that object holding the recipient address. */
  emailField: ident,
  /** Stop the campaign when any listed select field holds one of these values. */
  stopWhen: z.record(ident, z.array(z.string())).default({}),
  steps: z.array(campaignStepSchema).min(1).max(20),
})

const actionSchema = z.object({
  id: ident,
  label: z.string(),
  run: runTarget,
  /** Ask for confirmation before running, with this message. */
  confirm: z.string().optional(),
})

const filterValue = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])

const filterCondition = z.object({
  /** A field (`stage`), a field of a related record (`client.town`), or the records that point here (`~deals.client`). */
  field: z.string().min(1),
  /** An operator the field's type has: see docs/search-and-filters.md. */
  op: z.string().min(1),
  value: filterValue.optional(),
  /** With `has` and `hasNone`: conditions the related records must meet. */
  where: z
    .array(
      z.object({ field: z.string().min(1), op: z.string().min(1), value: filterValue.optional() }),
    )
    .optional(),
})

/**
 * Which records a view starts out showing. Either the short form, a field and
 * the value it must hold (`{ "pipeline": "sales" }`), or a list of conditions
 * (`[{ "field": "amount", "op": "gt", "value": 5000 }]`), all of which must
 * hold. A list of lists matches when any one of them does. Users can change a
 * view's filters in the app; this is where the view starts.
 */
const viewFilters = z
  .union([
    z.record(ident, z.union([z.string(), z.boolean()])),
    z.array(z.union([filterCondition, z.array(filterCondition)])),
  ])
  .default({})

const viewSort = z.object({ field: ident, dir: z.enum(['asc', 'desc']).default('asc') })

const viewSchema = z.discriminatedUnion('type', [
  z.object({
    id: ident,
    label: z.string(),
    type: z.literal('table'),
    columns: z.array(ident).min(1),
    /** One column, or up to three: records equal on the first are ordered by the next. */
    sort: z.union([viewSort, z.array(viewSort).min(1).max(3)]).optional(),
    filters: viewFilters,
  }),
  z.object({
    id: ident,
    label: z.string(),
    type: z.literal('board'),
    /** A `select` field; each option becomes a column. */
    groupBy: ident,
    cardFields: z.array(ident).default([]),
    /**
     * When `groupBy` depends on a filtered field, only the options that apply are
     * shown as columns: filter by `pipeline` to get one board per pipeline.
     */
    filters: viewFilters,
  }),
])

/** Sections that files are sorted into; they become folders in the file store. */
const fileFolders = z
  .array(
    z
      .string()
      .refine(
        isFolderName,
        'use a plain folder name: at most 60 characters, none of / \\ : * ? " < > |, no leading or trailing dot or space',
      ),
  )
  .max(40)
  .default([])
  .refine(
    (names) => new Set(names.map((n) => n.toLowerCase())).size === names.length,
    'folder names must be different',
  )

const objectSchema = z.object({
  label: z.string(),
  labelPlural: z.string(),
  /** Prisma model name. Defaults to the PascalCase singular of the object key. */
  model: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]*$/)
    .optional(),
  /** Sidebar and header icon. */
  icon: z
    .enum([
      'users',
      'user',
      'building',
      'handshake',
      'briefcase',
      'calendar',
      'checklist',
      'clipboard',
      'check',
      'ticket',
      'home',
      'file',
      'box',
    ])
    .optional(),
  /** Field used as the record's display name. */
  titleField: ident,
  fields: z.record(ident, fieldSchema),
  views: z.array(viewSchema).min(1),
  actions: z.array(actionSchema).default([]),
  /**
   * Let teammates attach files to this object's records: adds a Files tab.
   * `folders` names the sections a record's files are sorted into, in order,
   * e.g. ["Drawings", "Proposal"]. They become folders in the file store.
   */
  files: z
    .object({
      /** Folders created inside each record's folder, e.g. ["Proposals", "Contracts"]. */
      folders: fileFolders,
      /**
       * A relation field on this object. A record's folder is made inside the
       * folder of the record that field points to: a deal's inside its company's.
       */
      under: ident.optional(),
    })
    .optional(),
})

const guideStepSchema = z.object({
  title: z.string().min(1).max(80),
  /** One or two plain sentences. `{record}`, `{records}`, `{Record}`, `{Records}` and `{app}` are filled in. */
  body: z.string().min(1).max(500),
  /**
   * What to point at: an anchor from docs/guides.md, such as "view-menu" or
   * "field:stage". With a list, the first one on the page is used. A step whose
   * anchors are all missing from the page is left out.
   */
  target: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(4)]).optional(),
  /** Show the step without a pointer when its anchor is not on the page, instead of leaving it out. */
  keep: z.boolean().optional(),
})

/**
 * A short tour of one place in the CRM, offered to each person once. `where` is
 * the place: "anywhere", "search", a page ("home", "tasks", "notes", "files",
 * "reports", "workflows", "integrations", "assistant"), or "list", "board" or
 * "record", optionally for one object ("list:deals"). It can be left out when
 * the guide replaces a built-in one of the same id.
 */
const guideSchema = z.object({
  title: z.string().min(1).max(80),
  where: z.string().min(1).optional(),
  steps: z.array(guideStepSchema).min(1).max(8),
})

const automationSchema = z.object({
  on: z.string().regex(/^[a-z][a-zA-Z0-9]*\.(created|updated|deleted)$/, 'e.g. "contacts.created"'),
  run: runTarget,
})

export const crmConfigSchema = z
  .object({
    $schema: z.string().optional(),
    /** Config format version. Bumped only for breaking changes, with a migration note in CHANGELOG.md. */
    version: z.literal(1, {
      error: 'set "version": 1. If this config came from a newer release, see docs/upgrading.md',
    }),
    app: z.object({
      /** Your business name. Shown in the CRM and, as "<name> CRM", in the browser tab. */
      name: z.string().min(1),
      /**
       * Where the business keeps its calendar, as an IANA name such as
       * "America/New_York". Decides when "today" and "this month" begin in filters.
       */
      timezone: z
        .string()
        .refine((zone) => {
          try {
            Intl.DateTimeFormat('en', { timeZone: zone })
            return true
          } catch {
            return false
          }
        }, 'use an IANA time zone name, e.g. "America/New_York"')
        .default('UTC'),
      /**
       * The hours a sequence's later emails may go out in, on the clock of
       * `timezone`: `{ "from": "08:00", "to": "18:00" }`. An email that falls
       * due outside them waits for the next morning (or Monday, unless
       * `weekdaysOnly` is false). Without this, each goes out when it is due.
       * An email with no wait is always sent at once.
       */
      sendingHours: z
        .object({
          from: clock,
          to: clock,
          weekdaysOnly: z.boolean().default(true),
        })
        .refine((h) => h.from < h.to, { message: '"from" must be earlier than "to"' })
        .optional(),
    }),
    /**
     * Who may use the CRM. Single business per repo: anyone who signs in
     * must also match one of these, otherwise they are rejected server-side.
     */
    /**
     * The shared library on the Files page: files that belong to the business
     * rather than to one record (price lists, templates, forms). `folders` are
     * its sections, in order; `label` is what the library is called.
     */
    files: z
      .object({
        label: z
          .string()
          .refine(isFolderName, 'use a plain name, as for a folder')
          .default('Company files'),
        folders: fileFolders,
      })
      .optional(),
    access: z
      .object({
        allowedDomains: z.array(z.string()).default([]),
        allowedEmails: z.array(z.string().email()).default([]),
      })
      .refine((a) => a.allowedDomains.length + a.allowedEmails.length > 0, {
        message: 'access needs at least one allowed domain or email; the CRM is deny-by-default',
      }),
    objects: z.record(ident, objectSchema),
    automations: z.array(automationSchema).default([]),
    /** Email sequences: a few emails with waits between them, sent with Resend. */
    campaigns: z.record(ident, campaignSchema).default({}),
    /**
     * Guides that show people around, by id. Use a built-in guide's id to
     * replace its words, `false` to turn it off, or a new id (with `where`) to
     * add one. The built-in guides are in src/crm/guides.ts; see docs/guides.md.
     */
    guides: z.record(ident, z.union([z.literal(false), guideSchema])).default({}),
    /**
     * How the Ask page presents the assistant. `name` is what it is called
     * there ("Assistant" when unset) and `greeting` the line a new chat opens
     * with. `suggestions` are the prompts offered under the box of a new chat:
     * `label` is the button, `prompt` is what gets asked. Without any, the page
     * writes a few from the first object. What the assistant can do is not set
     * here: that is its tools, in `swirls/assistant.swirls`.
     */
    assistant: z
      .object({
        name: z.string().trim().min(1).max(40).optional(),
        greeting: z.string().trim().min(1).max(80).optional(),
        suggestions: z
          .array(
            z.object({
              label: z.string().trim().min(1).max(40),
              prompt: z.string().trim().min(1).max(2000),
            }),
          )
          .max(6)
          .optional(),
      })
      .optional(),
  })
  .superRefine((cfg, ctx) => {
    const objectKeys = new Set(Object.keys(cfg.objects))

    // The CRM is served from the site root, so an object's key is its first path
    // segment. These are the static routes an object key would shadow.
    for (const key of [
      'assistant',
      'settings',
      'new',
      'tasks',
      'notes',
      'reports',
      'workflows',
      'integrations',
      'files',
      'api',
      'crm',
      'unsubscribe',
    ]) {
      if (objectKeys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['objects', key],
          message: `"${key}" is reserved by a built-in CRM route`,
        })
      }
    }

    const reserved = new Set(['id', ...Object.keys(SYSTEM_COLUMNS)])

    for (const [objKey, obj] of Object.entries(cfg.objects)) {
      const path = ['objects', objKey]
      const fieldKeys = new Set(Object.keys(obj.fields))

      if (!fieldKeys.has(obj.titleField)) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'titleField'],
          message: `unknown field "${obj.titleField}"`,
        })
      }

      const under = obj.files?.under

      if (under !== undefined && obj.fields[under]?.type !== 'relation') {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'files', 'under'],
          message: `"${under}" is not a relation field on this object`,
        })
      }

      for (const [fKey, f] of Object.entries(obj.fields)) {
        const fPath = [...path, 'fields', fKey]

        if (reserved.has(fKey)) {
          ctx.addIssue({
            code: 'custom',
            path: fPath,
            message: `"${fKey}" is a reserved system field`,
          })
        }

        if (f.type === 'relation' && !objectKeys.has(f.to)) {
          ctx.addIssue({
            code: 'custom',
            path: [...fPath, 'to'],
            message: `unknown object "${f.to}"`,
          })
        }

        if (f.encrypted && !isTextLike(f.type)) {
          ctx.addIssue({
            code: 'custom',
            path: [...fPath, 'encrypted'],
            message: 'only text-like fields can be encrypted',
          })
        }

        if (f.searchable && !isTextLike(f.type)) {
          ctx.addIssue({
            code: 'custom',
            path: [...fPath, 'searchable'],
            message: 'only text-like fields can be searchable',
          })
        }

        if (f.type === 'select') {
          const values = new Set(f.options.map((o) => o.value))

          if (f.default !== undefined && !values.has(f.default)) {
            ctx.addIssue({
              code: 'custom',
              path: [...fPath, 'default'],
              message: `"${f.default}" is not an option`,
            })
          }

          const control = f.dependsOn ? obj.fields[f.dependsOn] : undefined

          if (f.dependsOn && (f.dependsOn === fKey || control?.type !== 'select')) {
            ctx.addIssue({
              code: 'custom',
              path: [...fPath, 'dependsOn'],
              message: `"${f.dependsOn}" must be another select field on ${objKey}`,
            })
          } else if (control?.type === 'select' && control.dependsOn) {
            ctx.addIssue({
              code: 'custom',
              path: [...fPath, 'dependsOn'],
              message: `"${f.dependsOn}" depends on "${control.dependsOn}"; a field can't depend on a dependent field`,
            })
          }

          for (const [i, o] of f.options.entries()) {
            if (!o.when) {
              continue
            }

            if (!f.dependsOn) {
              ctx.addIssue({
                code: 'custom',
                path: [...fPath, 'options', i, 'when'],
                message: 'set "dependsOn" on the field to use "when"',
              })
            } else if (control?.type === 'select') {
              for (const v of o.when) {
                if (!control.options.some((c) => c.value === v)) {
                  ctx.addIssue({
                    code: 'custom',
                    path: [...fPath, 'options', i, 'when'],
                    message: `"${v}" is not an option of ${f.dependsOn}`,
                  })
                }
              }
            }
          }
        }

        if (f.searchable && (f.encrypted === 'storage' || f.encrypted === 'eq')) {
          ctx.addIssue({
            code: 'custom',
            path: [...fPath, 'searchable'],
            message: `encrypted: "${f.encrypted}" does not support free-text search; use "match" or "search"`,
          })
        }
      }

      for (const [i, view] of obj.views.entries()) {
        const vPath = [...path, 'views', i]
        const sorts = view.type === 'table' && view.sort ? [view.sort].flat() : []

        const refs =
          view.type === 'table'
            ? [...view.columns, ...sorts.map((s) => s.field)]
            : [view.groupBy, ...view.cardFields]

        for (const ref of refs) {
          if (!fieldKeys.has(ref) && !reserved.has(ref)) {
            ctx.addIssue({ code: 'custom', path: vPath, message: `unknown field "${ref}"` })
          }
        }

        if (cleanSort(cfg.objects, objKey, sorts).length !== sorts.length) {
          ctx.addIssue({
            code: 'custom',
            path: [...vPath, 'sort'],
            message: 'sort by each column once',
          })
        }

        // The same check the app makes on every list: a condition it would drop is a mistake here.
        const groups = Array.isArray(view.filters)
          ? view.filters.map((g) => (Array.isArray(g) ? g : [g]))
          : [Object.entries(view.filters).map(([field, value]) => ({ [field]: value }))]

        for (const [g, group] of groups.entries()) {
          for (const [index, condition] of group.entries()) {
            const single = Array.isArray(view.filters) ? [condition] : condition

            // Cleaning keeps an option that no longer exists (so an old view matches nothing rather than
            // everything); in the config it is a mistake to catch.
            const stale = cleanFilters(cfg.objects, objKey, single)
              .flat()
              .flatMap((c) => [c, ...(c.where ?? []).map((w) => ({ ...w, inside: c.field }))])
              .flatMap((c) => {
                const inside =
                  'inside' in c ? resolveTarget(cfg.objects, objKey, String(c.inside)) : undefined

                const target = resolveTarget(
                  cfg.objects,
                  inside ? inside.objectKey : objKey,
                  c.field,
                )

                const field = target?.kind === 'field' ? target.field : undefined
                const values = Array.isArray(c.value) ? c.value : []
                return field?.type === 'select'
                  ? values
                      .filter((v) => !field.options.some((o) => o.value === v))
                      .map((v) => `"${v}" is not an option of ${c.field}`)
                  : []
              })

            for (const message of stale) {
              ctx.addIssue({ code: 'custom', path: [...vPath, 'filters'], message })
            }

            if (cleanFilters(cfg.objects, objKey, single).length === 0) {
              const name = 'field' in condition ? condition.field : Object.keys(condition)[0]

              ctx.addIssue({
                code: 'custom',
                path: [
                  ...vPath,
                  'filters',
                  ...(Array.isArray(view.filters) ? [g, index] : [String(name)]),
                ],
                message: `can't filter by "${name}" this way: check the field, the operator its type allows, and the value`,
              })
            }
          }
        }

        if (view.type === 'board' && obj.fields[view.groupBy]?.type !== 'select') {
          ctx.addIssue({
            code: 'custom',
            path: [...vPath, 'groupBy'],
            message: 'board views must group by a select field',
          })
        }
      }
    }

    for (const [i, a] of cfg.automations.entries()) {
      const objKey = a.on.split('.')[0]!

      if (!objectKeys.has(objKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['automations', i, 'on'],
          message: `unknown object "${objKey}"`,
        })
      }
    }

    const campaignKeys = new Set(Object.keys(cfg.campaigns))

    const checkTarget = (run: string, path: (string | number)[]) => {
      const [kind, name] = run.split(':')

      if (kind === 'campaign' && !campaignKeys.has(name!)) {
        ctx.addIssue({ code: 'custom', path, message: `unknown campaign "${name}"` })
      }
    }

    for (const [objKey, obj] of Object.entries(cfg.objects)) {
      for (const [i, a] of obj.actions.entries()) {
        checkTarget(a.run, ['objects', objKey, 'actions', i, 'run'])
        const [kind, name] = a.run.split(':')

        if (
          kind === 'campaign' &&
          cfg.campaigns[name!] &&
          cfg.campaigns[name!]!.object !== objKey
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['objects', objKey, 'actions', i, 'run'],
            message: `campaign "${name}" enrolls ${cfg.campaigns[name!]!.object}, not ${objKey}`,
          })
        }
      }
    }

    for (const [i, a] of cfg.automations.entries()) {
      checkTarget(a.run, ['automations', i, 'run'])
    }

    for (const [key, c] of Object.entries(cfg.campaigns)) {
      const path = ['campaigns', key]
      const obj = Object.hasOwn(cfg.objects, c.object) ? cfg.objects[c.object] : undefined

      if (!obj) {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'object'],
          message: `unknown object "${c.object}"`,
        })

        continue
      }

      if (obj.fields[c.emailField]?.type !== 'email') {
        ctx.addIssue({
          code: 'custom',
          path: [...path, 'emailField'],
          message: `"${c.emailField}" must be an email field on ${c.object}`,
        })
      }

      for (const [field, values] of Object.entries(c.stopWhen)) {
        const f = obj.fields[field]

        if (f?.type !== 'select') {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'stopWhen', field],
            message: `"${field}" must be a select field on ${c.object}`,
          })

          continue
        }

        for (const v of values) {
          if (!f.options.some((o) => o.value === v)) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, 'stopWhen', field],
              message: `"${v}" is not an option of ${field}`,
            })
          }
        }
      }

      const ids = new Set<string>()

      for (const [i, step] of c.steps.entries()) {
        if (ids.has(step.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path, 'steps', i, 'id'],
            message: `duplicate step id "${step.id}"`,
          })
        }

        ids.add(step.id)

        for (const m of `${step.subject} ${step.body}`.matchAll(/\{\{\s*([a-zA-Z0-9]+)\s*\}\}/g)) {
          if (!Object.hasOwn(obj.fields, m[1] ?? '') && m[1] !== 'unsubscribeUrl') {
            ctx.addIssue({
              code: 'custom',
              path: [...path, 'steps', i],
              message: `unknown placeholder {{${m[1]}}}`,
            })
          }
        }
      }
    }

    for (const issue of checkGuides(cfg)) {
      ctx.addIssue({ code: 'custom', ...issue })
    }
  })

export type CrmConfig = z.output<typeof crmConfigSchema>
export type CrmObject = CrmConfig['objects'][string]
export type CrmView = CrmObject['views'][number]
export type CrmAction = CrmObject['actions'][number]
export type CrmCampaign = CrmConfig['campaigns'][string]

export { fieldLabel, modelName, SYSTEM_FIELDS } from './naming'

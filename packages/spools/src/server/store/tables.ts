import {
  type AnyTable,
  createdAt,
  date,
  defineTable,
  float,
  id,
  integer,
  optional,
  text,
  timestamp,
  updatedAt,
  withDefault,
} from './table'

/**
 * The system tables: what the CRM keeps besides the objects in the config.
 * Every Spool has them. They aren't CRM objects: no hooks or automations, and
 * their keys can't be used as object keys.
 *
 * To add one: describe it here, list it in `systemTables`, and run
 * `bun run crm:gen` and `bun run db:push`.
 */

export const Activity = defineTable({
  model: 'Activity',
  name: 'activities',
  doc: 'Timeline entries for any record: calls, meetings, notes, emails, form submissions, agent actions.',
  columns: {
    id: id(),
    createdAt: createdAt(),
    objectKey: text(),
    recordId: text(),
    kind: text(),
    summary: text(),
    body: optional(text()),
    actor: optional(text()),
    actorId: optional(
      text({
        doc: "The teammate who did it (the auth provider's user id), for per-person reports. `actor` is their name as shown.",
      }),
    ),
    occurredAt: optional(
      timestamp({
        doc: 'When it happened, if that differs from when it was logged (a call entered the next day).',
      }),
    ),
    outcome: optional(
      text({
        doc: 'How it went: a call or meeting outcome, or sent / received / not_sent for an email.',
      }),
    ),
    externalId: optional(
      text({
        doc: 'Identifies the email or calendar event this came from, so syncing it twice logs it once.',
      }),
    ),
  },
  unique: [['objectKey', 'recordId', 'externalId']],
  indexes: [['objectKey', 'recordId'], ['createdAt']],
  search: { name: 'activities_search', columns: ['summary', 'body'] },
})

export const Task = defineTable({
  model: 'Task',
  name: 'tasks',
  doc: 'To-dos, optionally linked to a record and assigned to a teammate.',
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    title: text(),
    dueDate: optional(date()),
    completedAt: optional(timestamp()),
    completedBy: optional(text()),
    assigneeId: optional(text()),
    objectKey: optional(text()),
    recordId: optional(text()),
    createdBy: optional(text()),
  },
  indexes: [['assigneeId'], ['objectKey', 'recordId']],
})

export const Note = defineTable({
  model: 'Note',
  name: 'notes',
  doc: 'Titled notes, optionally attached to a record.',
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    title: text(),
    body: text(),
    objectKey: optional(text()),
    recordId: optional(text()),
    authorId: optional(text()),
    authorName: optional(text()),
  },
  indexes: [['objectKey', 'recordId']],
  search: { name: 'notes_search', columns: ['title', 'body'] },
})

export const SavedView = defineTable({
  model: 'SavedView',
  name: 'saved_views',
  doc: 'Views created or customised in the app. When key is set, it overrides the config view with that id.',
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    objectKey: text(),
    key: optional(text()),
    label: text(),
    type: text(),
    settings: text({ doc: 'JSON: columns, sort, filters, groupBy, cardFields, calculations' }),
    createdBy: optional(text()),
  },
  indexes: [['objectKey']],
})

export const Favorite = defineTable({
  model: 'Favorite',
  name: 'favorites',
  doc: 'Records a user has starred; shown in their sidebar.',
  columns: {
    id: id(),
    createdAt: createdAt(),
    userId: text(),
    objectKey: text(),
    recordId: text(),
  },
  indexes: [['userId']],
})

export const Suppression = defineTable({
  model: 'Suppression',
  name: 'email_suppressions',
  doc: 'Addresses that must never receive campaign email (unsubscribes, bounces, complaints).',
  primary: 'email',
  columns: { email: text(), reason: text(), createdAt: createdAt() },
})

export const MailboxSync = defineTable({
  model: 'MailboxSync',
  name: 'mailbox_sync',
  doc: `How far the mail and calendar sync has read one of a teammate's mailboxes: the
account they sign in with, or one connected on the Integrations page.
Holds no credentials (see src/server/mailbox.ts).`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    userId: text(),
    provider: text(),
    accountEmail: text(),
    lastSyncedAt: optional(timestamp()),
    lastError: optional(text()),
  },
  unique: [['userId', 'provider', 'accountEmail']],
})

export const Integration = defineTable({
  model: 'Integration',
  name: 'integrations',
  doc: `An account a teammate connected on the Integrations page: another mailbox, or
a service an extension adds. A person can connect several accounts per provider.
Most are that teammate's own. One whose provider is shared belongs to the team or
to one group of it, whoever connected it.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    userId: text({
      doc: `The teammate who connected it. Whose it is, unless \`shared\` says it is the
team's or a group's: then this is who connected it last, and nothing more.`,
    }),
    provider: text(),
    account: text({
      doc: 'Which account at the provider: the email address of a mailbox, lower-cased.',
    }),
    credentials: text({
      doc: `The OAuth access and refresh tokens, encrypted by the vault before they reach
the database. Never plaintext: see src/server/runtime/vault.ts.`,
    }),
    scopes: text(),
    status: text(),
    lastError: optional(text()),
    shared: withDefault(
      text({
        doc: `Whose it is: empty for the teammate in \`userId\`, "team" for everyone, "group"
for the group in \`groupKey\`. The tokens are sealed for this, so changing it here
leaves them unreadable.`,
      }),
      '',
    ),
    groupKey: withDefault(
      text({ doc: 'Which group a "group" connection is for. Empty otherwise.' }),
      '',
    ),
    connectedByName: optional(
      text({
        doc: `The name of whoever connected a shared connection, as it was then: they may
no longer be on the access list when it is shown.`,
      }),
    ),
    connectedAt: optional(
      timestamp({ doc: 'When a shared connection was last connected or connected again.' }),
    ),
    ownerKey: optional(
      text({
        doc: `For a shared connection, what it is: its provider, its account, and the team or
which group, as one value. No two rows may hold the same one, so an account is
connected once for the team (or for a group) whoever connects it. Empty on a
connection of one's own, and on a shared one stored before this column: connecting
the account again fills it in.`,
      }),
    ),
  },
  // The first keeps one row per person for an account of their own. The second keeps one
  // row per shared account: an empty `ownerKey` is no value, so it limits nothing else.
  unique: [['userId', 'provider', 'account', 'shared', 'groupKey'], ['ownerKey']],
})

export const RecordFolder = defineTable({
  model: 'RecordFolder',
  name: 'record_folders',
  doc: `The folder in the file store that holds a record's files. The store is where
folders and files live; this row is how the CRM finds a record's folder again.
Two records may share one folder. See src/server/files.ts.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    objectKey: text(),
    recordId: text(),
    driveId: text(),
    folderId: text(),
    path: text({
      doc: "Where the folder was created, from the drive's top level. It may have been moved since.",
    }),
  },
  unique: [['objectKey', 'recordId']],
  indexes: [['folderId']],
})

export const FileUpload = defineTable({
  model: 'FileUpload',
  name: 'file_uploads',
  doc: `A file on its way into the store: reserved, not yet confirmed. Removed once
the store has the file, and forgotten if the upload is abandoned.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    driveId: text(),
    uploadId: text(),
    folderId: optional(
      text({ doc: "The folder it is going into; null for the drive's top level." }),
    ),
    name: text(),
    sizeBytes: float(),
    transport: text({
      doc: '"direct" when the browser sends the bytes to the store, "relay" when this server passes them on.',
    }),
    objectKey: optional(
      text({ doc: "The record whose Files tab it was added from, for that record's timeline." }),
    ),
    recordId: optional(text()),
    uploadedBy: text(),
    uploadedByName: text(),
  },
})

export const SequenceRun = defineTable({
  model: 'SequenceRun',
  name: 'sequence_runs',
  doc: `One record's way through an email sequence (a campaign in crm.config.json):
which email is next and when it is due. See src/server/campaigns.ts.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    campaignKey: text(),
    objectKey: text(),
    recordId: text(),
    status: text({ doc: '"active", "finished" or "stopped".' }),
    nextStep: optional(
      text({ doc: 'The id of the step to send next; null once the run is over.' }),
    ),
    dueAt: optional(
      timestamp({
        doc: `When that step is due. While a step is being sent this is pushed a few
minutes ahead, so a second sender leaves the run alone.`,
      }),
    ),
    attempts: withDefault(
      integer({ doc: 'How many times in a row sending the next step has failed.' }),
      0,
    ),
    note: optional(
      text({ doc: 'What happened last: why the run stopped, or the error from a failed send.' }),
    ),
    enrolledBy: optional(text()),
  },
  unique: [['campaignKey', 'objectKey', 'recordId']],
  indexes: [['status', 'dueAt']],
})

export const GuideProgress = defineTable({
  model: 'GuideProgress',
  name: 'guide_progress',
  doc: `The guides (src/crm/guides.ts) a teammate has finished or dismissed, so each
is offered to them once, on whatever device they sign in.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    userId: text(),
    guideId: text({
      doc: 'A guide\'s id, or "*" when the person asked not to be offered guides at all.',
    }),
    outcome: text({ doc: '"finished" or "dismissed".' }),
  },
  unique: [['userId', 'guideId']],
})

export const MarketingSite = defineTable({
  model: 'MarketingSite',
  name: 'marketing_sites',
  doc: `What the CRM knows about the business's website (\`marketing.website\` in
crm.config.json): the tracking tags its pages carry, and what the agent engine
learned about the business from it. See src/server/marketing.ts.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    website: text(),
    tags: optional(
      text({ doc: 'JSON: the ids of each tracking tag found in the page, from the last scan.' }),
    ),
    scannedAt: optional(timestamp()),
    scanError: optional(text({ doc: 'Why the last scan could not read the site.' })),
    summary: optional(text({ doc: 'What the business does, in two or three sentences.' })),
    audience: optional(text()),
    voice: optional(text({ doc: 'How the business writes: the tone a post should keep.' })),
    offers: optional(text({ doc: 'JSON: what it sells, as short names.' })),
    profiledAt: optional(timestamp()),
    profileRequestedAt: optional(
      timestamp({ doc: 'When a teammate last asked the agent engine to read the site.' }),
    ),
  },
  unique: [['website']],
})

export const MarketingPost = defineTable({
  model: 'MarketingPost',
  name: 'marketing_posts',
  doc: `A post for one social channel (\`marketing.channels\` in crm.config.json):
a draft, one waiting for its time, or one that went out. See src/server/marketing.ts.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    channel: text({ doc: "The channel's key in the config." }),
    body: text(),
    link: optional(text()),
    status: text({ doc: '"draft", "scheduled", "publishing", "published" or "failed".' }),
    scheduledAt: optional(timestamp()),
    startedAt: optional(timestamp({ doc: 'When it was handed to the agent engine to publish.' })),
    publishedAt: optional(timestamp()),
    executionId: optional(text({ doc: "The agent engine's run that is publishing it." })),
    externalId: optional(text({ doc: "The network's id for the published post." })),
    externalUrl: optional(text()),
    note: optional(text({ doc: 'Why it failed, or what happened last.' })),
    createdBy: optional(text()),
    createdByName: optional(text()),
    approvedBy: optional(
      text({
        doc: 'The teammate who scheduled or published it. A post never goes out without one.',
      }),
    ),
  },
  indexes: [['status', 'scheduledAt'], ['createdAt']],
})

export const MarketingAd = defineTable({
  model: 'MarketingAd',
  name: 'marketing_ads',
  doc: `One ad campaign's results over the last \`periodDays\`, as the agent engine
last read them from the network. A copy to look at: the network is where it is changed.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    account: text({ doc: "The ad account's key in the config (`marketing.ads`)." }),
    externalId: text({ doc: "The network's id for the campaign." }),
    name: text(),
    status: text({ doc: 'As the network names it, lower-cased: "active", "paused" and so on.' }),
    currency: optional(text()),
    spend: withDefault(float(), 0),
    impressions: withDefault(integer(), 0),
    clicks: withDefault(integer(), 0),
    conversions: withDefault(float(), 0),
    dailyBudget: optional(float()),
    periodDays: withDefault(integer(), 30),
    syncedAt: timestamp(),
  },
  unique: [['account', 'externalId']],
})

/** Every system table, in the order they are written to the schema. */
export const systemTables: readonly AnyTable[] = [
  Activity,
  Task,
  Note,
  SavedView,
  Favorite,
  Suppression,
  MailboxSync,
  Integration,
  RecordFolder,
  FileUpload,
  SequenceRun,
  GuideProgress,
  MarketingSite,
  MarketingPost,
  MarketingAd,
]

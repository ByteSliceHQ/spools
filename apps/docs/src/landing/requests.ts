/** What someone might ask a coding agent for, and what it writes. Each change is checked by requests.test.ts. */

export type Request = {
  label: string
  prompt: string
  file: string
  lang: 'json' | 'ts'
  code: string
}

export const requests = [
  {
    label: 'Track renewals',
    prompt: 'Track policy renewals, with a board by status that shows the client and the due date.',
    file: 'crm.config.json',
    lang: 'json',
    code: `"renewals": {
  "label": "Renewal",
  "labelPlural": "Renewals",
  "titleField": "name",
  "fields": {
    "name": { "type": "text", "required": true },
    "client": { "type": "relation", "to": "companies" },
    "due": { "type": "date" },
    "status": { "type": "select", "options": [
      { "value": "open" },
      { "value": "quoted" },
      { "value": "renewed" }
    ] }
  },
  "views": [{
    "id": "board", "label": "By status", "type": "board",
    "groupBy": "status", "cardFields": ["client", "due"]
  }]
}`,
  },
  {
    label: 'Email new leads',
    prompt: 'Email new leads on day 0, day 3 and day 10. Stop when they become a customer.',
    file: 'crm.config.json',
    lang: 'json',
    code: `"campaigns": {
  "welcome": {
    "label": "Welcome",
    "object": "contacts",
    "emailField": "email",
    "stopWhen": { "status": ["customer"] },
    "steps": [
      { "id": "hello", "wait": "0m", "subject": "Hi {{name}}", "body": "..." },
      { "id": "proof", "wait": "3d", "subject": "How others use us", "body": "..." },
      { "id": "last", "wait": "7d", "subject": "Still interested?", "body": "..." }
    ]
  }
},
"automations": [
  { "on": "contacts.created", "run": "campaign:welcome" }
]`,
  },
  {
    label: 'Act on a won deal',
    prompt: 'When a deal is won, give its owner a task to send the welcome pack.',
    file: 'src/app/extensions.ts',
    lang: 'ts',
    code: `import { createTask, defineExtensions } from '@swirls/spools/extensions'

export default defineExtensions({
  hooks: {
    async afterUpdate({ objectKey, record, previous, actor }) {
      const won = record.stage === 'won' && previous.stage !== 'won'
      if (objectKey !== 'deals' || !won) return

      await createTask(
        {
          title: \`Send \${record.title} the welcome pack\`,
          assigneeId: record.owner ? String(record.owner) : null,
          objectKey,
          recordId: record.id,
        },
        actor?.id ?? 'system',
      )
    },
  },
})`,
  },
] as const satisfies readonly Request[]

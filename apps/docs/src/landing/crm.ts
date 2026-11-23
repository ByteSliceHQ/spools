/** The records and config lines behind the CRM shown on the home page. */

export const stages = [
  { value: 'lead', label: 'Lead' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'won', label: 'Won' },
] as const

export type Stage = (typeof stages)[number]['value']

export type Deal = {
  title: string
  company: string
  value: number
  stage: Stage
  closeDate: string
}

export const deals: readonly Deal[] = [
  {
    title: 'Warehouse fit-out',
    company: 'Larkspur Supply',
    value: 48000,
    stage: 'proposal',
    closeDate: 'Dec 4',
  },
  {
    title: 'Fleet renewal',
    company: 'Fairhaven Group',
    value: 91500,
    stage: 'proposal',
    closeDate: 'Dec 18',
  },
  { title: 'Site survey', company: 'Brightwater', value: 6200, stage: 'lead', closeDate: 'Jan 9' },
  {
    title: 'Annual service plan',
    company: 'Copperline',
    value: 18400,
    stage: 'won',
    closeDate: 'Nov 12',
  },
  {
    title: 'Second location',
    company: 'Larkspur Supply',
    value: 27000,
    stage: 'lead',
    closeDate: 'Feb 2',
  },
]

export const timeline = [
  { when: 'Today', what: 'Moved to Proposal', who: 'Priya' },
  { when: 'Yesterday', what: 'Received an email: Re: floor plan', who: 'Larkspur Supply' },
  { when: 'Nov 18', what: 'Logged a call: connected', who: 'Priya' },
  { when: 'Nov 14', what: 'Summary added by the assistant', who: 'Assistant' },
] as const

const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

export function money(value: number) {
  return dollars.format(value)
}

export function total(of: readonly Deal[]) {
  return money(of.reduce((sum, deal) => sum + deal.value, 0))
}

export const views = [
  {
    id: 'board',
    label: 'Board',
    config: `"views": [{ "id": "pipeline", "type": "board",
  "label": "Pipeline", "groupBy": "stage",
  "cardFields": ["value", "company", "closeDate"] }]`,
  },
  {
    id: 'table',
    label: 'Table',
    config: `"views": [{ "id": "all", "type": "table",
  "label": "All deals", "columns": ["title", "value",
    "stage", "company", "closeDate"] }]`,
  },
  {
    id: 'record',
    label: 'Record',
    config: `"actions": [{ "id": "handoff",
  "label": "Hand off to delivery",
  "run": "swirls:deal_handoff" }]`,
  },
] as const

export type ViewId = (typeof views)[number]['id']

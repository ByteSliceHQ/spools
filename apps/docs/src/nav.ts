export type DocsNavLink = {
  to: string
  label: string
}

export type DocsNavGroup = {
  label: string
  children: readonly DocsNavLink[]
}

export type DocsNavItem = DocsNavLink | DocsNavGroup

export function isDocsNavGroup(item: DocsNavItem): item is DocsNavGroup {
  return 'children' in item
}

export const docsNav = [
  {
    label: 'Start here',
    children: [
      { to: '/docs', label: 'Introduction' },
      { to: '/docs/quickstart', label: 'Quickstart' },
      { to: '/docs/coding-agents', label: 'Build with agents' },
      { to: '/docs/when-to-use', label: 'When to use Spools' },
    ],
  },
  {
    label: 'Build',
    children: [
      { to: '/docs/configuration', label: 'Configuration' },
      { to: '/docs/extending', label: 'Extending' },
      { to: '/docs/search-and-filters', label: 'Search & filters' },
      { to: '/docs/campaigns', label: 'Email sequences' },
      { to: '/docs/mailbox', label: 'Mailbox & calendar' },
      { to: '/docs/integrations', label: 'Integrations' },
      { to: '/docs/guides', label: 'In-app guides' },
    ],
  },
  {
    label: 'Choose services',
    children: [
      { to: '/docs/adapters', label: 'Adapters' },
      { to: '/docs/auth', label: 'Signing in' },
      { to: '/docs/database', label: 'Database' },
      { to: '/docs/files', label: 'Files' },
      { to: '/docs/swirls', label: 'Agents & workflows' },
    ],
  },
  {
    label: 'Ship & operate',
    children: [
      { to: '/docs/deployment', label: 'Deployment' },
      { to: '/docs/security', label: 'Security' },
      { to: '/docs/upgrading', label: 'Upgrading' },
    ],
  },
  {
    label: 'Understand',
    children: [
      { to: '/docs/architecture', label: 'Architecture' },
      { to: '/docs/server-code', label: 'Server code' },
    ],
  },
  { to: '/docs/api', label: 'API reference' },
] as const satisfies readonly DocsNavItem[]

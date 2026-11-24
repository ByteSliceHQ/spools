/** Where the site is served and where its source lives. The domain is also in wrangler.json. */
export const siteUrl = 'https://spools.codes'
export const repositoryUrl = 'https://github.com/ByteSliceHQ/spools'

/** The page a coding agent reads to build a Spool. It is `public/prompt.md`; the host is also in wrangler.json. */
export const promptUrl = 'https://md.spools.codes/prompt.md'

/** What a person pastes into their agent. */
export const agentPrompt = `Read ${promptUrl} and follow it to build my CRM with Spools`

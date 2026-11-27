# Swirls: workflows and the assistant

[Swirls](https://swirls.ai) runs everything agentic: the AI that qualifies and
enriches leads, the emails those workflows send, and the CRM assistant. The
`.swirls` files live in [`swirls/`](../apps/starter/swirls).

| File                    | What it declares                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `secrets.swirls`        | Secret slots: vendor keys, the app callback URL and token, email addresses                                  |
| `schemas.swirls`        | `crm_event` (what the app sends) and `tool_result` (what the app returns)                                   |
| `new_contact.swirls`    | Qualify a new contact with AI, alert the team, auto-reply to website leads, write a summary to the timeline |
| `enrich_contact.swirls` | Web search on a contact and summarize the results to the timeline                                           |
| `assistant.swirls`      | The `crm_assistant` agent, its eight tool workflows, and the `crm_web` chat channel                         |
| `marketing.swirls`      | Reads the business's website for the Marketing page. See [Marketing](marketing.md)                          |

## How the app and Swirls talk

```
CRM app ──executeWorkflow({ objectKey, record, actor, trigger })──▶ Swirls workflow
CRM app ◀──POST /api/swirls/tools/<tool>  (Bearer SWIRLS_APP_TOKEN)── Swirls workflow / agent tool
Browser ──/api/assistant (session)──▶ CRM app ──web channel──▶ crm_assistant
```

The app owns every read and write. Swirls never connects to the database; it calls
the [tool API](../packages/spools/src/server/tools.ts) instead (`describe`, `search`, `get`,
`create`, `update`, `add_note`). That keeps validation, hooks and the timeline in one
place, and once field encryption is on, decryption happens only in the app. A record made
through the tool API starts no automations: text the model read could have chosen its
email address, and an automation would write to it. A teammate runs them from the record.

## Set up

1. Install the CLI and sign in:

   ```sh
   curl -fsSL https://swirls.ai/install | bash
   swirls auth login
   swirls project create
   swirls configure
   ```

2. Validate and deploy:

   ```sh
   swirls doctor
   swirls deploy
   ```

3. Set the Swirls secrets. `CRM_APP_TOKEN` must equal `SWIRLS_APP_TOKEN` in the
   app's environment (`bun run init` generates one):

   ```sh
   swirls secret set vendor_keys::OPENROUTER_API_KEY=...
   swirls secret set vendor_keys::RESEND_API_KEY=...
   swirls secret set vendor_keys::FIRECRAWL_API_KEY=...
   swirls secret set crm_app::CRM_APP_URL=https://crm.acme.com
   swirls secret set crm_app::CRM_APP_TOKEN=<same as SWIRLS_APP_TOKEN>
   swirls secret set crm_mail::FROM_EMAIL=hello@acme.com
   swirls secret set crm_mail::TEAM_EMAIL=sales@acme.com
   ```

4. In the app environment, set `SWIRLS_PROJECT_ID`.
5. Give the app a way to authenticate to Swirls. Either:
   - **OIDC federation (no stored key).** In the Swirls dashboard, open the project's
     Auth page and register Clerk as a provider, using your Clerk Frontend API domain
     (`clerk.acme.com` in production). Copy the project audience it shows
     (`swirls:aud:...`). In Clerk, create a JWT template named `swirls` whose claims are
     `{ "aud": "<that audience>" }`. The app then exchanges each signed-in user's Clerk
     JWT for a short-lived Swirls token, and Swirls records who started each run. See
     [OIDC Federation](https://swirls.ai/docs/platform/oidc-federation).
   - **An API key.** Set `SWIRLS_API_KEY` to a project API key. It takes precedence
     when set.

With federation only, a run needs a signed-in person. A workflow triggered where
nobody is signed in (a record created by a script, for example) is
skipped and recorded as "skipped" on the timeline; set `SWIRLS_API_KEY` if those
must run.

Workflow execution and agent chat need a paid Swirls plan. Without
`SWIRLS_PROJECT_ID`, the app skips Swirls runs and records "skipped" on the timeline.

## Local development

Swirls runs in the cloud, and its HTTP nodes can't reach private addresses, so
workflows can't call `http://localhost:3000`. To test write-backs locally, expose
your dev server with a tunnel (for example `cloudflared tunnel --url http://localhost:3000`)
and set `crm_app::CRM_APP_URL` to the tunnel URL. Add the tunnel's hostname to
`DEV_ALLOWED_HOSTS` in `.env`, or the dev server will refuse its requests.

## Adding a workflow

1. Write `swirls/<name>.swirls` with a root `inputSchema: crm_event`.
2. Call back into the app with an `http` node to `/api/swirls/tools/<tool>`
   (copy the headers block from an existing workflow).
3. Run `swirls doctor`, then `swirls deploy`.
4. Reference it from `crm.config.json`: `"run": "swirls:<name>"`.

The app resolves workflow names to ids from the active deployment and caches them
for a minute.

## Record scopes

In a Spool with [record scopes](security.md#record-scopes) the tool API reaches only what a
**grant** says. A grant is a short-lived token the CRM signs; nothing else carries a scope,
and nothing in a tool call's body (which a model writes) can switch one.

- A workflow started for a record gets `grant` in its input, beside `objectKey`, `record`,
  `actor` and `trigger`. Send it back with every call to the tool API:

  ```
  headers: @ts {
    return {
      "Authorization": "Bearer " + context.secrets.crm_app.CRM_APP_TOKEN,
      "X-Spools-Grant": context.nodes.root.input.grant,
      "Content-Type": "application/json"
    }
  }
  ```

  The two record workflows a new Spool comes with (`new_contact`, `enrich_contact`) send
  it, and leave the header out when there is no grant (a Spool without scopes). A Spool
  made before they did has to add it to each `http` node that calls
  `/api/swirls/tools/*`, and deploy the workflows, before turning scopes on, or their
  write-backs are refused. `crm_event` in `swirls/schemas.swirls` lists `grant` too.

- **What a grant is good for.** The scope of the record the workflow was started for, to
  read, and to write only if whoever started the workflow could. It is made for that one
  record: `get`, `update` and `add_note` answer about it and no other record of the scope,
  and `search` and `create`, which reach the rest of the scope, are refused. `describe` and
  the marketing tools reach no scoped record and work as before.
- **Whose it is.** A grant is made for the person whose work started the workflow, and is
  refused once that person is off the access list. Each call is given no more than that
  person holds when it is made: if they have lost the record's scope since, the grant is
  refused, and if they may now only read it, the workflow's writes are. A change a tool makes
  under a grant that starts another workflow hands on a grant for the same person.
- **Who can start one.** Whoever may change the record. An action, an automation or a
  sequence started for someone who only reads the record is refused before it starts.
- **How long it lasts.** Fifteen minutes, or [`scopes.grantMinutes`](configuration.md#scopes).
  A workflow that waits (on a person, on a timer) before it writes back needs that set
  longer than its longest wait. Until a grant runs out, whoever holds it has its reach, so
  keep it as short as your workflows allow.
- **Treat the grant as a secret of the run.** Put it in the header and nowhere else: never
  into a prompt, a message or anything a model reads or writes, or text the model was fed
  could send it somewhere else.
- A grant is signed with `APP_SECRET`. Changing that secret ends every grant in flight.

- **The assistant's record tools are refused in chat.** A chat's tool workflows are started
  by the engine, not the CRM, so there is no input to put a grant in, and a value the model
  could relay would be a scope switch. With scopes on, `crm_search`, `crm_get`, `crm_create`,
  `crm_update` and `crm_add_note` answer that the call reached no record; `crm_describe` and
  the marketing tools still work.
- **Chats must be each person's own.** With `SWIRLS_API_KEY` set, chats belong to the
  project and everyone reads everyone's, so the Ask page is refused and says so. Use
  federation.

## The assistant

`/assistant` (the **Ask** button in the top bar, or the box on Home) streams chat
through the app (`/api/assistant`) to the `crm_web` channel. Each message is
attributed to the signed-in user. The page is laid out like the chat
assistants people already know: past chats in the sidebar grouped by when they
were last used, the conversation in a centred column, and the box pinned to the
bottom. A chat is only made when its first message is sent, and is titled from
that message. While the assistant uses a CRM tool the reply shows a quiet line
("Searched deals"), which opens into the steps it took; the records those tools
returned are listed under the reply as links. Its name, greeting and suggested
prompts are set under [`assistant`](configuration.md#the-assistants-page) in
`crm.config.json`.

**Where chats are kept.** Swirls keeps them; the CRM has no table for them.
Whose chats a person sees depends on the credential. Without `SWIRLS_API_KEY` the
app exchanges each person's session for a Swirls token
([OIDC federation](https://swirls.ai/docs/platform/oidc-federation)), and each
person sees only their own chats. With a project API key, chats belong to the
project, so everyone sees (and can delete) everyone's. That's usually fine for a
single business. The page lists the 30 most recent.

**What the page can and can't do with Swirls today:**

|                              |                                                                                                                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New chat, list, open, delete | Yes. Deleting asks first, and removes the chat and its messages from Swirls                                                                                                                                                                                                |
| Stop                         | Stops the reply on screen. Swirls has no way to cancel a turn, so the assistant finishes in the background, and any change it was making still happens; the whole reply is there when the chat is opened again                                                             |
| Regenerate                   | Off for Swirls (`regenerate: false` in `packages/spools/src/adapters/agents/swirls/server.ts`): Swirls doesn't document that the web channel answers a regenerate request, and if it ignores one the question is stored twice. "Try again" after an error is still offered |
| Rename                       | Not yet: Swirls has no call to change a chat's title                                                                                                                                                                                                                       |

The server side of the page is the `Agents` port
(`packages/spools/src/server/runtime/agents.ts`), the Swirls adapter behind it
(`packages/spools/src/adapters/agents/swirls/server.ts`),
`packages/spools/src/server/assistant.functions.ts` and the two `/api/assistant` routes. What the page works out (groups, titles, tool steps, linked records) is
`packages/spools/src/crm/assistant.ts`; its parts are `packages/spools/src/crm/ui/assistant.tsx`.

**Trying the page without Swirls.** In a clone of the repository, in the stubbed-sign-in harness, set
`E2E_ASSISTANT=stub` (`E2E_ASSISTANT=stub bun run dev:e2e`). The page then talks
to canned replies (`e2e/assistant-stub.ts`) instead of Swirls: they stream a word
at a time, run a real search against the local database so their links work, and
never change a record. Type _table_, _long_, _note_ or _error_ for the other
kinds of reply. Chats live in the dev server's memory until it restarts. The
stub is only ever swapped in by `vite.config.e2e.ts` and refuses to run in a
production build.

To change what the assistant can do, edit its `tools` list and tool workflows in
`assistant.swirls`, or add a tool to `packages/spools/src/server/tools.ts`.

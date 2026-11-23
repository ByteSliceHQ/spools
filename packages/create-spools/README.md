# @swirls/create-spools

Makes a new [Spool](https://spools.codes): a CRM you own, built on `@swirls/spools`.

```bash
bun create @swirls/spools my-crm
cd my-crm
bun run db:seed
bun run dev
```

| Option              | What it does                                       |
| ------------------- | -------------------------------------------------- |
| `--name <text>`     | Your business, as the CRM shows it                 |
| `--domain <domain>` | Who may use the CRM: everyone with an address here |
| `--email <address>` | Or one person                                      |
| `--yes`             | Take the defaults instead of asking                |
| `--no-install`      | Don't install packages or run the first-time setup |

Licensed under [Apache-2.0](./LICENSE).

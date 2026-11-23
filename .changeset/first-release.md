---
'@swirls/spools': minor
'@swirls/create-spools': minor
---

First release of Spools. `defineSpool` puts a CRM together from a config,
your own code and the services it runs on: auth (Clerk, Better Auth, a development
sign-in), database (any Postgres, PGlite, Prisma 8), files (your database with local
disk or S3, FlashDrive), email (Resend), vault (CipherStash, AES-256-GCM) and agents
(Swirls). `bun create @swirls/spools` makes a new one.

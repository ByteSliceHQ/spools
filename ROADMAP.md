# Roadmap

What's planned, roughly in order. Open an issue to discuss any of it.

## Next

- **Run every adapter against live accounts.** Most are tested against stand-ins; a
  pass with real Clerk, Google, Microsoft, Resend, CipherStash, FlashDrive, S3 and
  Swirls accounts is the first thing to do before 0.2.
- **SQLite and libSQL.** The store port asks for little that isn't Postgres: text
  search and a few casts.
- **More email adapters**: SMTP, Postmark, SES.
- **Field-level encryption with CipherStash.** Fields can already be marked
  `encrypted` in `crm.config.json`; they're stored as plaintext until
  `@cipherstash/stack-prisma` supports Prisma 8. When it does, the generator will
  emit encrypted column types and existing configs will work unchanged. Existing
  plaintext data will need a one-time migration, which we'll document.
- **Files over 1 GB.** The store takes them as a multipart transfer, which the
  browser upload does not do yet.
- **Automatic call logging** from a phone system.

## Later

- Roles and per-object permissions inside the CRM
- More view types (calendar, list), column resizing and drag-to-reorder
- Comments and mentions, notifications
- Settings pages for the data model, so objects and fields can be edited in the app
- An agent engine other than Swirls behind the same port

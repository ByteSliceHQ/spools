/**
 * End-to-end harness: the real app with the development sign-in in place of
 * its auth adapter (e2e/spool.server.ts). `bun run dev:e2e` serves it on
 * http://localhost:3100. Never use this config for a deployment: everyone is
 * signed in as DEV_AUTH_EMAIL.
 *
 * `E2E_ASSISTANT=stub` also replaces the assistant's Swirls chat with canned
 * replies (e2e/assistant-stub.ts), so the Ask page can be tried without a
 * Swirls project. Without it the page talks to Swirls as usual, or says the
 * assistant isn't connected.
 */
import { fileURLToPath } from 'node:url'

import { defineConfig, mergeConfig } from 'vite'

import base from './vite.config'

const stub = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default mergeConfig(
  base,
  defineConfig({
    server: { port: 3100 },
    resolve: {
      alias: [
        { find: /^\.{1,2}\/(?:.*\/)?spool\.server$/, replacement: stub('./e2e/spool.server.ts') },
        { find: /^\.{1,2}\/(?:.*\/)?spool\.ui$/, replacement: stub('./e2e/spool.ui.ts') },
      ],
    },
  }),
)

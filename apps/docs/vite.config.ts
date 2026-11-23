import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

import { markdownPages } from './scripts/markdown'

// Nitro/Vite honor PORT over server.port; pin docs so a shared PORT cannot collide.
const port = Number(process.env.DOCS_PORT ?? 8788)
process.env.PORT = String(port)
process.env.NITRO_PORT = String(port)

/**
 * What every answer of the site says to the browser: stay on HTTPS, don't sit in
 * anyone's frame, take each file as the type it is sent as, and load nothing
 * from anywhere but the site and the fonts it names. The pages are static, and
 * carry their own small scripts and styles inline to start up.
 */
const securityHeaders = {
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; '),
}

export default defineConfig(({ command, mode }) => {
  const isPrerenderBuild = mode === 'prerender'

  return {
    server: {
      port,
      strictPort: true,
      host: process.env.HOST ?? '127.0.0.1',
    },
    plugins: [
      markdownPages(),
      tanstackStart({
        srcDirectory: 'src',
        prerender: isPrerenderBuild
          ? {
              enabled: true,
              crawlLinks: true,
              failOnError: true,
              filter: ({ path }) => !/[.#]/.test(path),
            }
          : undefined,
      }),
      nitro(
        isPrerenderBuild
          ? {
              preset: 'bun',
              output: {
                dir: '.prerender',
              },
            }
          : command === 'serve'
            ? {
                preset: 'bun',
              }
            : {
                preset: 'cloudflare_module',
                cloudflare: {
                  deployConfig: true,
                },
                // For the worker's own answers, and written to `_headers` for the static files.
                routeRules: { '/**': { headers: securityHeaders } },
              },
      ),
      viteReact(),
      tailwindcss(),
    ],
  }
})

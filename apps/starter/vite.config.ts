import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Extra hostnames the dev server answers to, for sharing it through a tunnel.
// Comma-separated; a leading dot allows every subdomain (".datumproxy.net").
const allowedHosts = (process.env['DEV_ALLOWED_HOSTS'] ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean)

// The CipherStash SDK ships a native module and WebAssembly. It only ever runs on
// the server (the vault adapter), so keep Vite from pre-bundling or bundling it.
const serverOnly = ['@cipherstash/stack']

export default defineConfig({
  server: { port: 3000, allowedHosts },
  optimizeDeps: { exclude: serverOnly },
  ssr: { external: serverOnly, optimizeDeps: { exclude: serverOnly } },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})

/// <reference types="vite/client" />

declare module '*.css?url' {
  const href: string
  export default href
}

declare module '*.md' {
  import type { Page } from './docs'

  const page: Page
  export default page
}

import { existsSync } from 'node:fs'
import { cp, readFile, rm } from 'node:fs/promises'

const prerenderedPublicDir = new URL('../.prerender/public/', import.meta.url)
const workerPublicDir = new URL('../.output/public/', import.meta.url)

await cp(prerenderedPublicDir, workerPublicDir, {
  recursive: true,
  force: true,
})

await rm(new URL('../.prerender/', import.meta.url), {
  recursive: true,
  force: true,
})

// A page and the worker name the same assets, or the page is shown without its styles.
const home = await readFile(new URL('index.html', workerPublicDir), 'utf8')

for (const [, path = ''] of home.matchAll(/(?:href|src)="\/(assets\/[^"]+)"/g)) {
  if (!existsSync(new URL(path, workerPublicDir))) {
    throw new Error(`The prerendered pages ask for /${path}, which was not built`)
  }
}

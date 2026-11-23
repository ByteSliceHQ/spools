import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'

import type { Page } from '../docs'

/** A rendered page of documentation. Its links move within the app and its code can be copied. */
export function DocsPage({ page }: { page: Page }) {
  const router = useRouter()
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = root.current

    if (!element) {
      return undefined
    }

    function onClick(event: MouseEvent) {
      const { target } = event

      if (!(target instanceof Element)) {
        return
      }

      const button = target.closest<HTMLButtonElement>('button[data-code]')

      if (button) {
        navigator.clipboard
          .writeText(button.dataset.code ?? '')
          .then(() => (button.textContent = 'Copied'))
          .catch(() => (button.textContent = 'Select code to copy'))

        return
      }

      const link = target.closest('a')
      const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey

      if (
        !link ||
        modified ||
        event.button !== 0 ||
        !link.getAttribute('href')?.startsWith('/docs')
      ) {
        return
      }

      event.preventDefault()
      router.history.push(`${link.pathname}${link.hash}`)
    }

    element.addEventListener('click', onClick)
    return () => element.removeEventListener('click', onClick)
  }, [router])

  return <div ref={root} key={page.title} dangerouslySetInnerHTML={{ __html: page.html }} />
}

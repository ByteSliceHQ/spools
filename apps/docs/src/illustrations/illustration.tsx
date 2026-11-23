import { useId } from 'react'

import { illustrations } from './scenes'
import type { IllustrationName } from './scenes'

export const artPalettes = {
  light: {
    face: '#ffffff',
    side: '#f4f5f7',
    front: '#fafbfc',
    edge: '#929ba9',
    detail: '#a3adbb',
    accent: '#627b9b',
    grid: '#edf0f4',
  },
  dark: {
    face: '#12141a',
    side: '#151820',
    front: '#101218',
    edge: '#626b7b',
    detail: '#485263',
    accent: '#a3bad5',
    grid: '#1d222c',
  },
} as const

function declarations(theme: 'light' | 'dark') {
  return Object.entries(artPalettes[theme])
    .map(([key, value]) => `--art-${key}: ${value};`)
    .join(' ')
}

const illustrationStyles = `
.spools-art { ${declarations('light')} }
@media (prefers-color-scheme: dark) {
  .spools-art:not([data-theme="light"]) { ${declarations('dark')} }
}
html.dark .spools-art:not([data-theme="light"]), .spools-art[data-theme="dark"] { ${declarations('dark')} }
html.light .spools-art:not([data-theme="dark"]), .spools-art[data-theme="light"] { ${declarations('light')} }
`

export function Illustration({
  name,
  theme,
  className = '',
  decorative = false,
}: {
  name: IllustrationName
  theme?: 'light' | 'dark'
  className?: string
  decorative?: boolean
}) {
  const id = useId()
  const item = illustrations[name]
  const Scene = item.component

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -40 640 500"
      width="640"
      height="500"
      className={`spools-art ${className}`}
      data-theme={theme}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-labelledby={decorative ? undefined : `${id}-title ${id}-desc`}
      fill="none"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <title id={`${id}-title`}>{item.label}</title>
      <desc id={`${id}-desc`}>
        {item.alt} {item.description}
      </desc>
      <style>{illustrationStyles}</style>
      <Scene />
    </svg>
  )
}

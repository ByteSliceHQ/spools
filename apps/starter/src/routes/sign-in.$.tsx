import { createFileRoute } from '@tanstack/react-router'

import { signInPage } from '@swirls/spools/pages/sign-in'

export const Route = createFileRoute('/sign-in/$')(signInPage)

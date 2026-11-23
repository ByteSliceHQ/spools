import { getRouteApi } from '@tanstack/react-router'
import { FolderOpen } from 'lucide-react'
import type { ReactNode } from 'react'

import { FileBrowser } from '../crm/ui/files'
import { TopBar } from '../crm/ui/shell'

const route = getRouteApi('/_crm/files')

export function FilesPage(): ReactNode {
  const { folder } = route.useSearch()
  const navigate = route.useNavigate()
  return (
    <>
      <TopBar icon={<FolderOpen className="text-c-fg2 size-3.5" />} title="Files" />
      <div className="min-h-0 flex-1">
        <FileBrowser
          rootId={null}
          rootLabel="All files"
          folderId={folder ?? null}
          onNavigate={(id) => navigate({ search: { folder: id ?? undefined } })}
        />
      </div>
    </>
  )
}

import {
  boolean,
  createdAt,
  defineTable,
  float,
  id,
  optional,
  text,
  updatedAt,
  withDefault,
} from '../../../server/store/table'

/** The drive's folders and files. Their bytes are kept elsewhere (blobs.ts), under `blobKey`. */
export const FileNode = defineTable({
  model: 'FileNode',
  name: 'file_nodes',
  doc: `The folders and files of the drive file store: what each is called and where it
is. A file's bytes are in the drive's blob store. See src/adapters/files/drive.`,
  columns: {
    id: id(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    kind: text({ doc: '"folder" or "file".' }),
    name: text(),
    parentId: optional(text({ doc: 'The folder it is in; null at the top level.' })),
    sizeBytes: optional(float()),
    blobKey: optional(text({ doc: "Where a file's bytes are: a UUID the server made." })),
    sha256: optional(text()),
    pending: withDefault(
      boolean({ doc: "A file whose bytes haven't been confirmed. Nobody is shown it." }),
      false,
    ),
    addedBy: optional(text()),
  },
  indexes: [['parentId']],
})

export type FileNodeRow = NonNullable<(typeof FileNode)['row']>

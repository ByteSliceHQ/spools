import { describe, expect, test } from 'bun:test'

import { Effect } from 'effect'

import { filesProblems } from '../../src/adapters/files/flashdrive/client'
import { generatePrisma } from '../../src/crm/codegen'
import { crmConfigSchema } from '../../src/crm/config-schema'
import {
  formatBytes,
  isFolderName,
  MAX_UPLOAD_BYTES,
  safeName,
  storeFormat,
  uploadProblem,
} from '../../src/crm/files'
import { filesConfigured } from '../../src/server/extension-api'
import { FileStore } from '../../src/server/runtime/files'
import { installLiveServices, installStandIns, run } from '../../src/testing/run'

const config = (files: unknown) => ({
  version: 1,
  app: { name: 'Test' },
  access: { allowedDomains: ['example.com'] },
  objects: {
    jobs: {
      label: 'Job',
      labelPlural: 'Jobs',
      titleField: 'name',
      fields: { name: { type: 'text', required: true } },
      views: [{ id: 'all', label: 'All', type: 'table', columns: ['name'] }],
      ...(files === undefined ? {} : { files }),
    },
  },
})

const issues = (cfg: unknown) => {
  const r = crmConfigSchema.safeParse(cfg)
  return r.success ? [] : r.error.issues.map((i) => i.message)
}

describe('file and folder names', () => {
  test('a name becomes one safe path segment', () => {
    expect(safeName('Kitchen: plan v2 / final?.pdf')).toBe('Kitchen- plan v2 - final-.pdf')
    expect(safeName('  drawings\t\n  rev 3  ')).toBe('drawings rev 3')
    // Hidden and agent-instruction names lose their leading dots; Windows refuses trailing ones.
    expect(safeName('.claude')).toBe('claude')
    expect(safeName('..')).toBe('Untitled')
    expect(safeName('report. ')).toBe('report')
    expect(safeName('', 'File')).toBe('File')
    expect(safeName('a\u0000b\u007fc')).toBe('abc')
  })

  test('a long file name keeps its extension', () => {
    const long = `${'x'.repeat(200)}.pdf`
    const short = safeName(long)
    expect(short.length).toBe(120)
    expect(short.endsWith('.pdf')).toBe(true)
  })

  test('folder names in the config must already be safe', () => {
    expect(isFolderName('Purchase Orders')).toBe(true)
    expect(isFolderName('Drawings/Old')).toBe(false)
    expect(isFolderName('.hidden')).toBe(false)
    expect(isFolderName(' padded')).toBe(false)
    expect(isFolderName('x'.repeat(61))).toBe(false)
    expect(isFolderName('')).toBe(false)
  })

  test('only the formats the store reads are sent as such', () => {
    expect(storeFormat('Proposal.PDF')).toBe('pdf')
    expect(storeFormat('scope.docx')).toBe('docx')
    expect(storeFormat('notes.md')).toBe('md')
    expect(storeFormat('photo.jpeg')).toBe('file')
    expect(storeFormat('archive.tar.gz')).toBe('file')
    expect(storeFormat('README')).toBe('file')
  })

  test('sizes read naturally', () => {
    expect(formatBytes(1)).toBe('1 byte')
    expect(formatBytes(999)).toBe('999 bytes')
    expect(formatBytes(1500)).toBe('1.5 KB')
    expect(formatBytes(2_340_000)).toBe('2.3 MB')
    expect(formatBytes(MAX_UPLOAD_BYTES)).toBe('1.0 GB')
  })

  test('empty and oversized files are refused before anything is sent', () => {
    expect(uploadProblem({ name: 'plan.pdf', size: 10 })).toBeNull()
    expect(uploadProblem({ name: 'plan.pdf', size: 0 })).toBe('plan.pdf is empty')

    expect(uploadProblem({ name: 'video.mov', size: MAX_UPLOAD_BYTES + 1 })).toContain(
      'the largest file you can add here is 1.0 GB',
    )
  })
})

describe('files in the config', () => {
  test('an object opts in, with or without folders', () => {
    expect(issues(config(undefined))).toEqual([])
    expect(issues(config({}))).toEqual([])
    expect(issues(config({ folders: ['Drawings', 'Purchase Orders'] }))).toEqual([])
    expect(crmConfigSchema.parse(config({})).objects['jobs']?.files).toEqual({ folders: [] })
    expect(crmConfigSchema.parse(config(undefined)).objects['jobs']?.files).toBeUndefined()
  })

  test('folder names that could not be folders are refused', () => {
    expect(issues(config({ folders: ['Drawings/Old'] }))[0]).toContain('use a plain folder name')

    expect(issues(config({ folders: ['Photos', 'photos'] }))).toEqual([
      'folder names must be different',
    ])
  })

  test('the shared library is named and given folders at the top level', () => {
    expect(issues({ ...config(undefined), files: { folders: ['Templates'] } })).toEqual([])

    expect(crmConfigSchema.parse({ ...config(undefined), files: {} }).files).toEqual({
      label: 'Company files',
      folders: [],
    })

    expect(issues({ ...config(undefined), files: { label: 'Shared/All' } })[0]).toContain(
      'use a plain name',
    )

    // An object can't be called `files`: that is the Files page's address.
    const taken = config(undefined)

    expect(issues({ ...taken, objects: { files: taken.objects.jobs } })).toContain(
      '"files" is reserved by a built-in CRM route',
    )
  })

  test("a record's folder can be nested under a related record's, by a relation field", () => {
    const nested = config({ folders: [], under: 'client' })
    expect(issues(nested)).toEqual(['"client" is not a relation field on this object'])

    const withRelation = {
      ...nested,
      objects: {
        ...nested.objects,
        jobs: {
          ...nested.objects.jobs,
          fields: { ...nested.objects.jobs.fields, client: { type: 'relation', to: 'jobs' } },
        },
      },
    }

    expect(issues(withRelation)).toEqual([])
  })

  test('the folder and upload tables are generated whatever the objects are', () => {
    const { schema } = generatePrisma(crmConfigSchema.parse(config(undefined)))
    expect(schema).toContain('model RecordFolder {')
    expect(schema).toContain('@@map("record_folders")')
    expect(schema).toContain('@@unique([objectKey, recordId])')
    expect(schema).toContain('model FileUpload {')
    expect(schema).not.toContain('model RecordFile {')
  })
})

describe('file store setup', () => {
  test('names what is missing', () => {
    expect(filesProblems({})).toEqual([
      'FLASHDRIVE_API_KEY is not set',
      'FLASHDRIVE_DRIVE_ID is not set',
    ])

    expect(filesProblems({ FLASHDRIVE_API_KEY: 'k', FLASHDRIVE_DRIVE_ID: 'my drive' })).toEqual([
      'FLASHDRIVE_DRIVE_ID is not a drive id',
    ])

    expect(
      filesProblems({
        FLASHDRIVE_API_KEY: 'k',
        FLASHDRIVE_DRIVE_ID: '6eb2d950-7a37-4e6d-a637-765600c2da62',
      }),
    ).toEqual([])
  })

  test("an app's hooks are told at once whether files are set up, as things are now", async () => {
    const names = ['FLASHDRIVE_API_KEY', 'FLASHDRIVE_DRIVE_ID']
    const saved = names.map((name) => process.env[name])
    process.env['FLASHDRIVE_API_KEY'] = 'k'

    const asThingsAre = () => {
      process.env['FLASHDRIVE_DRIVE_ID'] = '6eb2d950-7a37-4e6d-a637-765600c2da62'
      expect(filesConfigured()).toBe(true)
      delete process.env['FLASHDRIVE_DRIVE_ID']
      expect(filesConfigured()).toBe(false)
    }

    // Before the services are up (an app's own tests), and while they are (its hooks).
    await installLiveServices()
    asThingsAre()
    await run(Effect.void)
    asThingsAre()

    for (const [i, name] of names.entries()) {
      if (saved[i] === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = saved[i]
      }
    }

    // A Spool with no file store.
    await installStandIns({ files: FileStore.none })
    await run(Effect.void)
    expect(filesConfigured()).toBe(false)
    await installLiveServices()
  })
})

# Files

The CRM has a file browser: folders, drag-and-drop upload, rename, move and search. What
it keeps files in is an adapter you choose in `src/spool.server.ts`:

| Adapter                          | Files are kept in                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `drive({ blobs: s3Blobs() })`    | Any S3-compatible bucket, with the folders in the CRM's own database                             |
| `drive({ blobs: localBlobs() })` | A disk on the server, with the folders in the CRM's own database                                 |
| `flashdrive()`                   | A [FlashDrive](https://flashdrive.space) drive, which also mounts as a folder on macOS and Linux |

Without one, the Files pages say that files aren't set up.

- **The Files page** (in the sidebar, under Notes) browses the whole drive.
- **A record's Files tab** browses that record's own folder. Give an object a
  `files` section in `crm.config.json` and each of its records gets a folder.

> **Status:** tested against stand-ins for FlashDrive and S3, and against a real disk. None
> of them has been run against a live account yet.

## What you can do

In either place:

- Open a folder, and climb back with the breadcrumbs or "Up one folder".
- **Right-click** an empty spot to add a folder or upload files. Right-click a
  folder or a file to open, rename, move up or delete it; a file's menu also
  copies its link. Every row also has a ⋯ button for the same menu and a delete
  button, shown when you point at it or select it.
- See **who added each file** and when. A file put in a FlashDrive drive some other
  way shows no name.
- **Drag files in** from your computer to upload them, onto the open folder or
  onto a folder in the list. Drag a file or folder onto another folder, or onto
  a breadcrumb, to move it.
- Switch between a list and a grid. The choice is remembered in the browser.
- With an item selected: Enter opens it, F2 renames it, Delete removes it.
- On the Files page, search file names across everything.

The folder being shown on the Files page is in the address, so a folder can be
linked to. A folder that is a record's own is marked "Record" and links to it.

## A folder per record

```json
"companies": { "files": { "folders": [] } },
"deals":     { "files": { "folders": ["Proposals", "Contracts"], "under": "company" } }
```

- A record's folder is made the first time its page is opened (or its folder is
  first asked for), at `<object's plural label>/<record title>`: `Companies/Acme`.
- `folders` are made inside each record's folder when it is created. Use plain
  names: at most 60 characters, none of `/ \ : * ? " < > |`, no leading or
  trailing dot or space.
- `under` names a relation field. The record's folder is made inside the folder
  of the record that field points to: `Companies/Acme/Website redesign`. A
  record with that field empty gets a folder under its own object's name.
- Two records with the same name each get a folder; the second carries the first
  eight characters of its id.
- An object without `files` has no Files tab and no folders.

The CRM remembers which folder is a record's by the store's id for it, not its
path. So a record's folder can be renamed or moved in the drive and still opens
from its record; renaming the record does not rename the folder. Deleting a
record leaves its folder in the drive. Deleting a record's folder, in the CRM or
in the drive, is allowed: the record gets a new, empty one the next time its page
is opened.

To lay the drive out differently, give your app a `files.location` in
`src/app/extensions.ts`. It is asked once per record, when its folder is made:

```ts
export default defineExtensions({
  files: {
    // A path from the drive's top level. Return "" to keep the default for this record.
    location: ({ objectKey, record }) =>
      objectKey === 'jobs'
        ? `Jobs/${new Date(String(record.createdAt)).getFullYear()}/${record.name}`
        : '',
  },
})
```

When one record hands over to another (a won deal becoming a job), give the new
record the old one's folder with `shareRecordFolder(from, to)` from
`@swirls/spools/extensions`: both then open the same folder.

## The library

A folder at the top of the drive holds files that belong to the business rather
than to one record: price lists, templates, forms. It is made the first time the
Files page is opened, as "Company files". To rename it or give it folders, add
`files` at the top level of `crm.config.json`:

```json
{
  "files": { "label": "Company files", "folders": ["Templates", "Price lists", "Forms"] }
}
```

It is an ordinary folder: anything can be added to it, and more folders can be
made beside it. `files` can't be used as an object key: it is the page's address.

## Setup: a drive of your own

```ts
import { drive, s3Blobs } from "@swirls/spools/files/drive";

files: drive({ blobs: s3Blobs() }),
```

The folders, and the name and place of each file, are rows in the CRM's database
(`file_nodes`). The bytes are in the blob store. After choosing `drive`, run
`bun run crm:gen` and, with `DATABASE_URL` set, `bun run db:push` so the table is there. Back up the database and the
blob store together: either is little use without the other.

### A bucket: `s3Blobs()`

Amazon S3, Cloudflare R2, Supabase Storage, MinIO, or anything else with the S3 API.

```sh
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_ENDPOINT=   # e.g. https://<account>.r2.cloudflarestorage.com. Not needed for Amazon S3
S3_REGION=     # needed for Amazon S3 and Supabase
```

- Keep the bucket private. Files are opened by links the server signs, which last five
  minutes.
- The bucket's CORS rules must allow `PUT` with a `content-type` header from the CRM's
  address, because browsers send files straight to it.
- Upload links last fifteen minutes. A signed link can't hold the browser to a hash, so an
  upload is checked by its size.
- Settings can be passed as options, or read from variables with other names:
  `s3Blobs({ env: { bucket: "R2_BUCKET" } })`.
- Bun signs with `AWS_SESSION_TOKEN` when it is set, whatever key it is given. Where that
  belongs to another key, unset it.

### A disk: `localBlobs()`

```ts
files: drive({ blobs: localBlobs({ dir: "/data/files" }) }),
```

Files go in `.data/files` unless you name a folder. It suits one server with a disk that
lasts: in Docker, mount a volume. It is refused on a serverless host, which has no such disk.

Uploads pass through the server, so its limit on the size of a request applies: 128 MB, which
is Bun's own default (`maxRequestBodySize` in `server.prod.ts` changes it). Size and SHA-256 are checked as the file
is written, and a file appears only once all of it is there.

## Setup: FlashDrive

```ts
import { flashdrive } from "@swirls/spools/files/flashdrive";

files: flashdrive(),
```

The folders and files in the CRM are the drive's own, so the team can open the same ones in
Finder, and whatever is put in the drive there shows up in the CRM.

1. In the [FlashDrive Console](https://app.flashdrive.space), create a drive for
   the CRM. Use a separate drive for development and for production.
2. In **Settings → API keys**, create a **Read-write** key for the workspace that
   holds the drive. It is shown once.
3. Set these where the server runs (never in browser code or a repository):

```sh
FLASHDRIVE_API_KEY=
FLASHDRIVE_DRIVE_ID=
# Only if FlashDrive gave you another API address with the key.
# FLASHDRIVE_BASE_URL=https://api.flashdrive.space
```

Until both are set, the file browser says what is missing. The server logs
whether the feature is on at start-up.

A key belongs to a workspace, not to one drive. The CRM only ever uses the drive
named in `FLASHDRIVE_DRIVE_ID`, but anyone holding the key can reach every drive
in that workspace, so keep the CRM's drives in a workspace of their own if that
matters to you.

To try it without a key, in a clone of the repository, run the stand-in store and point the app at it:

```sh
bun packages/spools/tests/support/fake-file-store.ts 3998
FLASHDRIVE_BASE_URL=http://localhost:3998 FLASHDRIVE_API_KEY=local-fake-key \
  FLASHDRIVE_DRIVE_ID=00000000-0000-4000-8000-000000000000 bun run dev
```

Every request tells the store about its caller, as FlashDrive's own SDK does:
`Flashdrive-Client: swirls-crm/1.1.2` and `Flashdrive-Write-Protocol: server-v1`.
The version is the FlashDrive client contract this code was written against, not
the CRM's own version. The store refuses a request from a client older than its
minimum, and a write that doesn't name the write protocol, with "This client
version is no longer supported". If it refuses this client under its own name,
the request is sent again exactly as the SDK would send it, and the server log
says so.

## How an upload works

1. The browser reads the file and computes its SHA-256.
2. `startUpload` (server) checks the session, reserves the upload with the store
   in the chosen folder, and returns where to send that one file.
3. With a bucket or FlashDrive, the browser sends the bytes **straight to the store** with a
   link signed for it. They do not pass through the CRM server, so a host's request-size
   limit does not apply. With a disk, or when FlashDrive asks for it, the
   browser sends them to `/api/files/uploads/<id>`, which checks the session and passes them
   on.
4. `finishUpload` (server) asks the store to confirm. Until then nobody is shown the file. A
   file added from a record's Files tab is noted on that record's timeline.

The store's key never reaches the browser, only a link that is good for one upload and
expires in minutes. An upload that is started and never finished is removed after a day.

## How a file is opened

Through `/api/files/<id>`, which checks the CRM session. A bucket and FlashDrive get a
redirect to a link for that one file. A disk gets the bytes.

Anyone on the team can upload anything, and a page opened from the CRM's own address could
act as whoever opened it. So only PNG, JPEG, GIF, WebP and PDF are shown in the browser, told
by the file's extension. Everything else is downloaded, HTML and SVG included, and what the
uploader's browser said a file was is never repeated.

## What the database holds

| Table            | What it is                                                           |
| ---------------- | -------------------------------------------------------------------- |
| `record_folders` | Which folder is a record's own, so its Files tab opens there         |
| `file_uploads`   | A file on its way in, until the store confirms it                    |
| `file_nodes`     | With `drive`: the folders and files, and where each file's bytes are |

## Limits

|                                |                                                                |
| ------------------------------ | -------------------------------------------------------------- |
| One file added through the CRM | 1 GB, or the server's request limit with a disk                |
| Files per drop or pick         | 50                                                             |
| Shown in one folder            | The first 1,000 folders and 1,000 files                        |
| Search results                 | The first 200 files                                            |
| A FlashDrive drive             | 500,000 files, 1 TB, folders 64 levels deep, 10 GB in one file |

With FlashDrive, a deleted file stays in the store's trash for an hour. With `drive`,
deleting is for good. Deleting a folder deletes everything in it.

Two servers adding files with the same name to the same folder at the same moment can end up
with two of that name. Folders, and moves, are settled between them.

## Who can see what

Anyone who may use the CRM can see, add, rename, move and delete every file, as they can
notes and tasks. Folders give no separate permissions. Whoever can open a FlashDrive drive,
or holds a key to the bucket, can read every file in it.

## Troubleshooting

| What you see                                                   | What it means                                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Files aren't set up yet"                                      | The list under it names what is missing                                                                                                                                                                                       |
| "The file store refused this CRM's key"                        | The key is wrong, was revoked, may not write, or doesn't reach this drive or bucket                                                                                                                                           |
| "AWS_SESSION_TOKEN is set, for another key than this bucket's" | Bun would sign with it. Unset it, or use the key it belongs to                                                                                                                                                                |
| "The file store could not use its disk"                        | The server can't write to the folder files are kept in. The log has the reason                                                                                                                                                |
| "The file changed while it was being added"                    | What arrived isn't what the browser described. Add the file again                                                                                                                                                             |
| "A folder can't be moved into itself"                          | The destination is the folder, or is inside it                                                                                                                                                                                |
| "The file store needs a newer client than this CRM speaks"     | FlashDrive has raised its minimum client version past the one this code states (`STORE_CONTRACT` in `packages/spools/src/adapters/files/flashdrive/client.ts`). Update the CRM; the server log names the minimum it asked for |
| "Something with that name is already there"                    | A folder or file in that place already has the name                                                                                                                                                                           |
| "That changed while you were looking at it"                    | Someone else renamed, moved or replaced it. Try again                                                                                                                                                                         |
| "That is no longer in the file store"                          | It was deleted or moved out of reach in the drive. Reload the folder                                                                                                                                                          |
| "The file store is full"                                       | The disk is full, or the FlashDrive plan is used up                                                                                                                                                                           |
| "The upload was interrupted"                                   | The connection dropped while the bytes were going. Add the file again                                                                                                                                                         |
| "The file store is still working on this file"                 | The store took longer than usual to confirm. Reload the folder in a moment                                                                                                                                                    |

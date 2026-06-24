# Paper HTML Reader Hermes Handoff

Last updated: 2026-06-23

This document is the full handoff note for Hermes or another agent taking over `F:\wiki\code\paper_html_reader`.

## 1. Project Purpose

`paper_html_reader` is a local HTML paper reader for the self-made paper HTML library.

The protected source library is:

```text
F:\wiki\paper\pro
```

The app does not directly modify that source folder. On scan, it mirrors missing HTML files into the reader workspace:

```text
F:\wiki\code\paper_html_reader\library\papers
```

All read/write features operate on the workspace copy under `library\papers`. This includes block ids, edits, title renames, backups, Doctor fixes, and history files.

## 2. Current Tech Stack

- Runtime: Node.js/npm
- App: React + TypeScript + Vite
- Local API: Vite dev-server middleware in `vite.config.ts`
- HTML parser/editor: `jsdom`
- Icons: `lucide-react`
- Tauri: not implemented yet. The current project is a web/dev-server shell that can later be wrapped by Tauri once Rust/Cargo is available.

## 3. Run Instructions

Preferred one-click start:

```text
F:\wiki\code\paper_html_reader\run-paper-html-reader.bat
```

Manual start:

```powershell
cd F:\wiki\code\paper_html_reader
npm install
npm run dev -- --port 5177 --host 127.0.0.1
```

Open:

```text
http://127.0.0.1:5177
```

Build check:

```powershell
cd F:\wiki\code\paper_html_reader
npm run build
```

The latest verified build passed on 2026-06-23.

## 4. Directory Map

```text
F:\wiki\code\paper_html_reader
├── server\
│   ├── doctor.ts          # HTML Doctor checks, Auto Fix, backups, atomic write helpers
│   ├── htmlEditing.ts     # block edit, selection edit, insert/delete, undo
│   └── titleRename.ts     # left-list title rename saved into HTML metadata
├── src\
│   ├── App.tsx            # main UI
│   ├── api.ts             # frontend API client
│   ├── documentTools.ts   # iframe HTML wrapping, display modes, outline parsing
│   ├── main.tsx           # React entry
│   ├── styles.css         # app styles
│   └── types.ts           # shared frontend types
├── data\                  # runtime state and histories, gitignored except .gitkeep
├── library\papers\         # editable mirrored HTML working copies, gitignored
├── dist\                  # production build output, gitignored
├── vite.config.ts         # Vite config and local API routes
├── README.md              # short project README
├── HERMES_HANDOFF.md      # this handoff document
└── run-paper-html-reader.bat
```

## 5. Safety Boundary

Protected source:

```text
F:\wiki\paper\pro
```

Writable working library:

```text
F:\wiki\code\paper_html_reader\library\papers
```

Important invariants:

- Do not write generated `data-block-id`, backups, reader-title metadata, or edit histories into `F:\wiki\paper\pro`.
- The app may copy missing source HTML into `library\papers`, but existing working-copy files are not overwritten by scan.
- All destructive or mutating operations must create a backup beside the working-copy HTML first:

```text
filename.html.bak-YYYYMMDD-HHMMSS
```

- Runtime files are gitignored:
  - `data/state.json`
  - `data/edit-history.json`
  - `data/doctor-report.json`
  - `data/doctor-fix-history.json`
  - `data/rename-history.json`
  - `data/annotations/*.json`
  - `library/papers/*.html`
  - `library/papers/*.bak-*`

## 6. Implemented Features

### 6.1 Library Scan

Source scan:

```text
F:\wiki\paper\pro\*.html
```

Working copy:

```text
F:\wiki\code\paper_html_reader\library\papers
```

Each paper summary includes:

- `id`
- `title`
- `fileName`
- `path`
- `sourcePath`
- `hash`
- `year`
- `size`
- `lastModified`
- `lastReadAt`
- `progress`
- `annotationCount`
- `health`

The title extraction priority is:

1. `<meta name="reader-title" content="...">`
2. `<title>...</title>`
3. first `<h1>`
4. filename

### 6.2 Reader

The reader opens HTML in a sandboxed iframe.

Supported display modes:

- bilingual
- original only
- translation only
- softened translation

The iframe wrapper strips scripts before rendering. This is intentional to avoid giving paper HTML app-level power.

Outline extraction:

- Prefer existing `#outline`
- Fall back to scanning `h1` through `h4`

Reading state is saved to:

```text
data/state.json
```

### 6.3 Annotation Skeleton

Sidecar annotations are stored in:

```text
data/annotations/<docId>.json
```

Annotation fields include selected text, prefix/suffix, text position, css path, type, color, note, tags, and timestamps.

This is a data skeleton and right-panel list. Complex highlight restoration is not implemented yet.

### 6.4 Safe Block Editing

Supported editable blocks:

- `h1`
- `h2`
- `h3`
- `h4`
- `p`
- `p.translation`
- `li`
- `figcaption`
- `td`
- `th`
- `blockquote`
- `div.reader-note`

Each editable block receives a stable `data-block-id` in the working-copy HTML. Missing ids are added by `ensureBlockIds`.

Supported operations:

- edit one block as plaintext
- delete one block with confirmation
- insert paragraph before
- insert paragraph after
- insert translation paragraph after
- insert note after
- insert `h3` after
- copy block text
- delete selected text inside one block
- replace selected text inside one block
- insert text after selected text inside one block
- undo latest edit

Protected structures are not edited:

- `script`
- `style`
- `nav#outline`
- `img`
- `math`

Edit history:

```text
data/edit-history.json
```

### 6.5 Structured Insertions

Generated structures:

```html
<p data-block-id="...">...</p>
<p class="translation" data-block-id="...">...</p>
<div class="reader-note" data-block-id="...">...</div>
<h3 data-block-id="...">...</h3>
```

Inserted content is treated as plaintext.

After inserting headings, the outline is regenerated.

### 6.6 Left-List Rename

The left paper list has a small edit button on each row.

Renaming writes into the working-copy HTML metadata:

```html
<meta name="reader-title" content="New title">
<title>New title</title>
```

It does not alter body content, `h1`, paragraphs, figures, tables, or math.

Rename history:

```text
data/rename-history.json
```

Each rename creates a backup first.

### 6.7 HTML Doctor

Doctor scan is non-destructive. Results are stored in:

```text
data/doctor-report.json
```

Health shape:

```ts
{
  status: "ok" | "warning" | "error" | "readonly";
  score: number;
  issues: Issue[];
}
```

Issue shape:

```ts
{
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  suggestion: string;
  autoFixable: boolean;
}
```

Implemented checks include:

- suspicious or empty title such as `full`, `untitled`, `document`, `index`
- missing `html`, `head`, `body`
- missing meta charset
- external scripts and MathJax CDN scripts
- missing `#outline`
- `#outline` mismatch with `h1` through `h4`
- missing headings
- missing `.translation`
- isolated or consecutive `.translation`
- duplicate `id`
- missing `data-block-id`
- duplicate `data-block-id`
- broken local image `src`
- likely front matter mixed into body start
- empty paragraphs
- many very short paragraphs
- repeated paragraph text

The library panel shows health badges. The right panel has a Doctor tab with health score, issue list, fix preview, fix apply, and backup folder open.

The Doctor report uses hash caching, so unchanged documents reuse previous health results.

### 6.8 Doctor Auto Fix

Auto Fix supports dry-run.

Dry-run returns diff and planned fixes without writing:

```http
POST /api/docs/:id/doctor/fix?dryRun=true
```

Apply writes after backup:

```http
POST /api/docs/:id/doctor/fix?dryRun=false
```

Fix history:

```text
data/doctor-fix-history.json
```

Low-risk fixes implemented:

- add `<meta charset="utf-8">`
- remove external scripts
- remove MathJax CDN script
- add missing `data-block-id`
- repair duplicate `data-block-id`
- rebuild `#outline` from headings
- replace suspicious title with inferred title
- remove empty `p`
- normalize translation-like class names to include `translation`

Medium-risk fixes are intentionally not auto-applied yet:

- wrap author/email/affiliation front matter as `section.front-matter`
- wrap obvious TOC page as `section.toc-page`
- merge incorrectly split short paragraphs

High-risk fixes are not implemented:

- delete large content
- reorder body
- guess original/translation pairs
- modify formulas
- modify table structure

### 6.9 Edit Preflight

Before write operations, the app checks:

- target path is inside `library\papers`
- source mapping is inside `F:\wiki\paper\pro`
- file exists
- current file hash matches open-time hash when supplied
- HTML can be parsed
- body exists
- block id exists exactly once for block operations
- block is not inside protected structures
- `p.translation` shape remains safe
- Doctor status is not `error` or `readonly`

Write flow:

1. create backup
2. apply mutation to DOM
3. serialize HTML
4. write to temporary file
5. rename temporary file over target
6. re-parse written HTML
7. validate `html/head/body`
8. validate no duplicate `data-block-id`
9. restore from backup on failure

## 7. Local API Routes

Implemented in `vite.config.ts`.

```http
GET /api/library
GET /api/doctor/report
GET /api/state
PUT /api/state
GET /api/document?path=<working-copy-html-path>
POST /api/edit/block
POST /api/edit/undo
GET /api/annotations?docId=<docId>
PUT /api/annotations?docId=<docId>
POST /api/docs/:id/doctor/fix?dryRun=true
POST /api/docs/:id/doctor/fix?dryRun=false
POST /api/doctor/open-backup-folder
POST /api/docs/:id/rename
```

Important route behavior:

- `/api/document` may add missing block ids to the working-copy HTML and returns the current file hash in `X-Document-Hash`.
- `/api/edit/block` uses the hash supplied by the frontend to detect external edits.
- `/api/docs/:id/rename` writes reader title metadata only.

## 8. Data and History Files

Runtime files:

```text
data/state.json
data/edit-history.json
data/rename-history.json
data/doctor-report.json
data/doctor-fix-history.json
data/annotations/*.json
```

Working-copy HTML and backups:

```text
library/papers/*.html
library/papers/*.html.bak-*
```

These are intentionally not committed.

## 9. Verified State

Latest verification performed by Codex:

- `npm run build` passed.
- Local Vite app runs on `http://127.0.0.1:5177`.
- `/api/library` returned successfully.
- Doctor report generation worked and wrote `data/doctor-report.json`.
- Doctor Auto Fix dry-run returned a diff and did not mutate the file.
- Left-list rename smoke test changed one working-copy HTML title and changed it back.
- Rename created backups.
- `F:\wiki\paper\pro` had no `.bak-*` files created by this app.
- `F:\wiki\paper\pro` had no `reader-title` metadata written by this app.

Observed library size during verification:

- `F:\wiki\paper\pro`: 185 HTML files
- `library\papers`: 185 HTML files

## 10. Known Limitations

- This is not a Tauri app yet. It is a Vite local app with a local dev-server API.
- MathJax CDN scripts are not executed in the reader. Local MathJax bundling is still a follow-up task.
- Annotation highlight restoration is not implemented.
- Full-text search is not implemented.
- Markdown export is not implemented.
- Medium-risk Doctor fixes are not implemented.
- High-risk Doctor fixes are intentionally blocked.
- Undo is for edit history, not yet a full unified history across Doctor fixes and rename.
- The current reader writes working-copy HTML, not protected `paper/pro` source HTML.

## 11. Recommended Next Tasks

1. Wrap the app in Tauri v2 after Rust/Cargo is available.
2. Add a user-visible setting that explicitly labels the active library as "working copy".
3. Add a controlled "promote working copy back to source" workflow, if the user later wants real `paper/pro` synchronization.
4. Implement local MathJax bundling.
5. Add richer Doctor report filters and issue code search.
6. Add a unified history panel for block edits, rename, Doctor fixes, and undo/restore.
7. Implement annotation highlight restoration.
8. Add full-text index/search.
9. Add optional filename rename workflow, separate from title metadata rename.
10. Add tests around `doctor.ts`, `htmlEditing.ts`, and `titleRename.ts`.

## 12. Important Design Decision

The user's latest safety preference was:

```text
不要直接污染我的 pro 文件夹，自己在 code 里找地方建好子文件夹
```

Therefore the current design treats `F:\wiki\paper\pro` as read-only source and uses:

```text
F:\wiki\code\paper_html_reader\library\papers
```

as the writable "original HTML" for the reader workflow.

If Hermes changes this boundary, update this document, README, UI labels, and all preflight checks at the same time.

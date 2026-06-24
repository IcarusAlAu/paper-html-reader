# Paper HTML Reader

Local reader for the self-made HTML papers under `F:\wiki\paper\pro`.

The app treats `F:\wiki\paper\pro` as a read-only source. On scan, it copies missing HTML files into:

```text
F:\wiki\code\paper_html_reader\library\papers
```

All editing, `data-block-id` insertion, backups, and edit history happen inside the reader workspace, not in `paper/pro`.

## V0 Scope

- Scans `F:\wiki\paper\pro\*.html` as the source and mirrors missing files to `library\papers`.
- Opens papers in a sandboxed iframe and keeps the source HTML read-only.
- Extracts outline from `#outline`, falling back to `h1`-`h4`.
- Supports bilingual, original-only, translation-only, and softened translation modes.
- Saves local reading state to `data/state.json`.
- Saves annotation sidecar JSON files to `data/annotations/`.
- Supports safe block-level HTML edits with backups and `data/edit-history.json`.
- Supports left-list title renaming saved into each working-copy HTML as `<meta name="reader-title">` plus `<title>`, with backups and `data/rename-history.json`.
- Runs HTML Doctor checks for every mirrored paper and writes `data/doctor-report.json`.
- Shows health badges in the library list and a Doctor panel for the current paper.
- Supports dry-run Auto Fix previews and confirmed low-risk fixes with `data/doctor-fix-history.json`.
- Runs edit preflight before every write: path boundary, file existence, open-time hash, parsable HTML, unique block id, protected-region checks, and Doctor status.

The current implementation is a React/Vite local app with a Vite dev-server API. It is ready for a Tauri shell once Rust/Cargo is available on this machine.

## Run

Double-click:

```text
run-paper-html-reader.bat
```

Or run manually:

```powershell
npm install
npm run dev -- --port 5177
```

Open:

```text
http://127.0.0.1:5177
```

## Build Check

```powershell
npm run build
```

## Notes

- V0 strips scripts from the source HTML before iframe rendering. This intentionally avoids letting paper HTML execute arbitrary scripts.
- MathJax local bundling is a follow-up task. Existing already-rendered math-like markup remains visible, but CDN script execution is disabled in V0.
- Runtime state and annotation JSON are gitignored so the reader can keep personal reading traces without dirtying the wiki code history.
- Editing writes back to the original HTML only for the selected block. Before each write, the app creates `*.html.bak-YYYYMMDD-HHMMSS` beside the source file.
- "Original HTML" here means the reader's working copy under `library\papers`, not the protected source under `F:\wiki\paper\pro`.
- Undo restores the latest edit from `data/edit-history.json`.
- Left-list renaming changes only HTML metadata in the working copy; it does not rewrite the protected `F:\wiki\paper\pro` source or alter body content.
- Doctor scanning is non-destructive. Auto Fix only writes after `Apply Fix`, creates a backup first, then refreshes health.
- Low-risk Doctor fixes include meta charset, external script removal, block id repair, outline rebuild, suspicious title replacement, empty paragraph removal, and translation class normalization.

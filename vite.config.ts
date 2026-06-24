import react from "@vitejs/plugin-react";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { batchEditBlocks, editBlock, ensureBlockIds, undoLastEdit } from "./server/htmlEditing";
import { buildDoctorReport, fixDocument, readDoctorReport, sha256File } from "./server/doctor";
import { renameDocumentTitle } from "./server/titleRename";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wikiRoot = path.resolve(__dirname, "..", "..");
const sourceLibraryDir = path.resolve(wikiRoot, "paper", "pro");
const defaultLibraryDir = sourceLibraryDir; // READ/WRITE directly in pro
const backupDir = path.resolve(wikiRoot, "paper", ".backups");
const dataDir = path.resolve(__dirname, "data");
const stateFile = path.join(dataDir, "state.json");
const annotationDir = path.join(dataDir, "annotations");
const editHistoryFile = path.join(dataDir, "edit-history.json");
const doctorReportFile = path.join(dataDir, "doctor-report.json");
const doctorFixHistoryFile = path.join(dataDir, "doctor-fix-history.json");
const renameHistoryFile = path.join(dataDir, "rename-history.json");
const tagsDir = path.join(dataDir, "tags");
const highlightsDir = path.join(dataDir, "highlights");
const editQueues = new Map<string, Promise<unknown>>();

type ReaderState = {
  currentDocId?: string;
  recentDocIds: string[];
  scrollByDocId: Record<string, number>;
  lastReadByDocId: Record<string, string>;
  settings: {
    displayMode: "bilingual" | "original" | "translation" | "soft";
    fontSize: number;
    lineHeight: number;
    contentWidth: number;
  };
};

const defaultState: ReaderState = {
  recentDocIds: [],
  scrollByDocId: {},
  lastReadByDocId: {},
  settings: {
    displayMode: "bilingual",
    fontSize: 16,
    lineHeight: 1.65,
    contentWidth: 900
  }
};

function docIdFor(filePath: string) {
  const hash = createHash("sha1").update(path.resolve(filePath).toLowerCase()).digest("hex").slice(0, 12);
  const base = path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
  return `${hash}-${base}`;
}

function sourcePathForWorkFile(filePath: string) {
  return path.join(sourceLibraryDir, path.basename(filePath));
}

function sendJson(res: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void }, data: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function sendText(res: { statusCode: number; setHeader(name: string, value: string): void; end(body?: string): void }, data: string, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(data);
}

async function ensureDataDirs() {
  await fs.mkdir(annotationDir, { recursive: true });
  await fs.mkdir(tagsDir, { recursive: true });
  await fs.mkdir(highlightsDir, { recursive: true });
  await fs.mkdir(defaultLibraryDir, { recursive: true });
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function readRequestBody(req: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function enqueueFileEdit<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath).toLowerCase();
  const previous = editQueues.get(key) || Promise.resolve();
  const next = previous.then(task, task);
  editQueues.set(
    key,
    next.finally(() => {
      if (editQueues.get(key) === next) {
        editQueues.delete(key);
      }
    })
  );
  return next;
}

function titleFromFilename(fileName: string): string {
  const stem = fileName.replace(/\.html?$/i, "");
  const m = stem.match(/^((?:19|20)\d{2})-(.+)$/);
  const raw = m ? m[2] : stem;
  return raw.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
}

function extractTitle(html: string, fileName: string) {
  // Prefer reader-title meta tag (set by our pipeline)
  const readerTitleMatch = html.match(/<meta\s+[^>]*name=["']reader-title["'][^>]*>/i);
  const readerTitle = readerTitleMatch?.[0].match(/\scontent=["']([^"']+)["']/i)?.[1];
  if (readerTitle) return readerTitle.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // Then <title> tag (now set from filename)
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) {
    const t = titleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (t && t.length > 2) return t;
  }
  // Fallback: derive from filename
  return titleFromFilename(fileName);
}

async function ensureLocalLibrary() {
  // No-op: reader works directly on pro folder
  return 0;
}

async function scanLibrary() {
  await ensureLocalLibrary();
  const entries = await fs.readdir(defaultLibraryDir, { withFileTypes: true });
  const htmlFiles = entries
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .map((entry) => path.join(defaultLibraryDir, entry.name))
    .sort((a, b) => path.basename(b).localeCompare(path.basename(a), "zh-CN"));
  const state = await readJson<ReaderState>(stateFile, defaultState);

  const papers = await Promise.all(
    htmlFiles.map(async (filePath) => {
      const stat = await fs.stat(filePath);
      // Only read first 4KB for title extraction (avoid reading 30MB files)
      const handle = await fs.open(filePath, "r");
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buf, 0, 4096, 0);
      await handle.close();
      const html = buf.slice(0, bytesRead).toString("utf8");
      const id = docIdFor(filePath);
      const year = path.basename(filePath).match(/(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/)?.[1] || "";
      const annotationFile = path.join(annotationDir, `${id}.json`);
      const annotations = await readJson<{ items: unknown[] }>(annotationFile, { items: [] });
      const tagsFile = path.join(tagsDir, `${id}.json`);
      const tags = await readJson<string[]>(tagsFile, []);
      return {
        id,
        title: extractTitle(html, path.basename(filePath)),
        fileName: path.basename(filePath),
        path: filePath,
        sourcePath: sourcePathForWorkFile(filePath),
        hash: await sha256File(filePath),
        year,
        size: stat.size,
        lastModified: stat.mtime.toISOString(),
        lastReadAt: state.lastReadByDocId[id] || "",
        progress: Math.round((state.scrollByDocId[id] || 0) * 100),
        annotationCount: annotations.items.length,
        tags
      };
    })
  );
  // Use cached doctor report; do NOT re-analyze all files on every scan
  const report = await readDoctorReport(doctorReportFile);
  // Update hashes from scan (already computed via streaming)
  const hashById = new Map(papers.map((p) => [p.id, p.hash]));
  for (const entry of report.entries) {
    const h = hashById.get(entry.id);
    if (h) entry.hash = h;
  }
  const healthById = new Map(report.entries.map((entry) => [entry.id, entry.health]));
  return papers.map((paper) => ({ ...paper, health: healthById.get(paper.id) || { status: "unknown", score: 0, issues: [] } }));
}

async function findPaperById(id: string) {
  // Fast path: scan just the library dir for matching file without full scanLibrary
  await ensureLocalLibrary();
  const entries = await fs.readdir(defaultLibraryDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/\.html?$/i.test(entry.name)) continue;
    const filePath = path.join(defaultLibraryDir, entry.name);
    if (docIdFor(filePath) === id) {
      const stat = await fs.stat(filePath);
      const html = await fs.readFile(filePath, "utf8");
      const year = entry.name.match(/(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/)?.[1] || "";
      return {
        id,
        title: extractTitle(html, entry.name),
        fileName: entry.name,
        path: filePath,
        sourcePath: sourcePathForWorkFile(filePath),
        hash: await sha256File(filePath),
        year,
        size: stat.size,
        lastModified: stat.mtime.toISOString(),
      };
    }
  }
  throw new Error("Document not found");
}

function apiPlugin(): Plugin {
  return {
    name: "paper-html-reader-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) {
          next();
          return;
        }

        try {
          await ensureDataDirs();
          const url = new URL(req.url, "http://localhost");

          if (req.method === "GET" && url.pathname === "/api/library") {
            sendJson(res, { root: defaultLibraryDir, sourceRoot: sourceLibraryDir, papers: await scanLibrary() });
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/doctor/report") {
            sendJson(res, await readDoctorReport(doctorReportFile));
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/state") {
            sendJson(res, await readJson<ReaderState>(stateFile, defaultState));
            return;
          }

          if (req.method === "PUT" && url.pathname === "/api/state") {
            const incoming = JSON.parse(await readRequestBody(req)) as ReaderState;
            const state = { ...defaultState, ...incoming, settings: { ...defaultState.settings, ...incoming.settings } };
            await fs.mkdir(dataDir, { recursive: true });
            await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
            sendJson(res, state);
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/document") {
            const filePath = url.searchParams.get("path");
            if (!filePath) {
              sendJson(res, { error: "Missing path" }, 400);
              return;
            }
            const resolved = path.resolve(filePath);
            const relative = path.relative(defaultLibraryDir, resolved);
            if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.html?$/i.test(resolved)) {
              sendJson(res, { error: "Document path is outside the configured library" }, 403);
              return;
            }
            const ensured = await enqueueFileEdit(resolved, () => ensureBlockIds(resolved, defaultLibraryDir, editHistoryFile));
            res.setHeader("X-Document-Hash", await sha256File(resolved));
            sendText(res, ensured.html);
            return;
          }

          if (req.method === "POST" && url.pathname === "/api/edit/block") {
            const payload = JSON.parse(await readRequestBody(req));
            sendJson(res, await enqueueFileEdit(payload.filePath, () => editBlock(payload, defaultLibraryDir, sourceLibraryDir, editHistoryFile)));
            return;
          }

          const renameMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/rename$/);
          if (req.method === "POST" && renameMatch) {
            const paper = await findPaperById(decodeURIComponent(renameMatch[1]));
            const payload = JSON.parse(await readRequestBody(req)) as { title?: string; expectedHash?: string };
            sendJson(
              res,
              await enqueueFileEdit(paper.path, () =>
                renameDocumentTitle(paper, {
                  title: payload.title || "",
                  expectedHash: payload.expectedHash,
                  libraryRoot: defaultLibraryDir,
                  sourceRoot: sourceLibraryDir,
                  historyFile: renameHistoryFile
                })
              )
            );
            return;
          }

          const fixMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/doctor\/fix$/);
          if (req.method === "POST" && fixMatch) {
            const paper = await findPaperById(decodeURIComponent(fixMatch[1]));
            const dryRun = url.searchParams.get("dryRun") !== "false";
            sendJson(
              res,
              await enqueueFileEdit(paper.path, () =>
                fixDocument(paper, {
                  dryRun,
                  reportFile: doctorReportFile,
                  historyFile: doctorFixHistoryFile
                })
              )
            );
            return;
          }

          if (req.method === "POST" && url.pathname === "/api/doctor/open-backup-folder") {
            await fs.mkdir(backupDir, { recursive: true });
            execFile("explorer.exe", [backupDir]);
            sendJson(res, { opened: backupDir });
            return;
          }

          if (req.method === "POST" && url.pathname === "/api/edit/undo") {
            sendJson(res, await undoLastEdit(defaultLibraryDir, editHistoryFile));
            return;
          }

          if (req.method === "POST" && url.pathname === "/api/edit/batch") {
            const payload = JSON.parse(await readRequestBody(req));
            if (!payload.filePath || !Array.isArray(payload.operations)) {
              sendJson(res, { error: "Missing filePath or operations" }, 400);
              return;
            }
            sendJson(res, await enqueueFileEdit(payload.filePath, () =>
              batchEditBlocks(payload.filePath, payload.operations, defaultLibraryDir, sourceLibraryDir, editHistoryFile)
            ));
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/annotations") {
            const docId = url.searchParams.get("docId");
            if (!docId) {
              sendJson(res, { error: "Missing docId" }, 400);
              return;
            }
            sendJson(res, await readJson(path.join(annotationDir, `${docId}.json`), { docId, items: [] }));
            return;
          }

          if (req.method === "PUT" && url.pathname === "/api/annotations") {
            const docId = url.searchParams.get("docId");
            if (!docId) {
              sendJson(res, { error: "Missing docId" }, 400);
              return;
            }
            const payload = JSON.parse(await readRequestBody(req));
            await fs.writeFile(path.join(annotationDir, `${docId}.json`), JSON.stringify(payload, null, 2), "utf8");
            sendJson(res, payload);
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/highlights") {
            const docId = url.searchParams.get("docId");
            if (!docId) {
              sendJson(res, { error: "Missing docId" }, 400);
              return;
            }
            sendJson(res, await readJson(path.join(highlightsDir, `${docId}.json`), { docId, items: [] }));
            return;
          }

          if (req.method === "PUT" && url.pathname === "/api/highlights") {
            const docId = url.searchParams.get("docId");
            if (!docId) {
              sendJson(res, { error: "Missing docId" }, 400);
              return;
            }
            const payload = JSON.parse(await readRequestBody(req));
            await fs.writeFile(path.join(highlightsDir, `${docId}.json`), JSON.stringify(payload, null, 2), "utf8");
            sendJson(res, payload);
            return;
          }

          if (req.method === "GET" && url.pathname === "/api/tags") {
            const docId = url.searchParams.get("docId");
            if (!docId) {
              // Return all unique tags across all documents
              const tagFiles = await fs.readdir(tagsDir).catch(() => []);
              const allTags = new Set<string>();
              for (const f of tagFiles) {
                if (!f.endsWith(".json")) continue;
                const t = await readJson<string[]>(path.join(tagsDir, f), []);
                t.forEach((tag) => allTags.add(tag));
              }
              sendJson(res, { tags: [...allTags].sort() });
              return;
            }
            sendJson(res, await readJson<string[]>(path.join(tagsDir, `${docId}.json`), []));
            return;
          }

          if (req.method === "PUT" && url.pathname === "/api/tags") {
            const docId = url.searchParams.get("docId");
            if (!docId) {
              sendJson(res, { error: "Missing docId" }, 400);
              return;
            }
            const tags = JSON.parse(await readRequestBody(req)) as string[];
            const unique = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();
            await fs.writeFile(path.join(tagsDir, `${docId}.json`), JSON.stringify(unique, null, 2), "utf8");
            sendJson(res, unique);
            return;
          }

          const deleteDocMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/delete$/);
          if (req.method === "POST" && deleteDocMatch) {
            const paper = await findPaperById(decodeURIComponent(deleteDocMatch[1]));
            const dir = path.dirname(paper.path);
            const baseName = path.basename(paper.path, path.extname(paper.path));
            const ext = path.extname(paper.path);
            // Delete the main file
            try { await fs.unlink(paper.path); } catch {}
            // Delete source file if different
            if (paper.sourcePath && paper.sourcePath !== paper.path) {
              try { await fs.unlink(paper.sourcePath); } catch {}
            }
            // Delete all backup files (.bak, .bak.1, .bak.2, etc.)
            const dirEntries = await fs.readdir(dir).catch(() => []);
            for (const entry of dirEntries) {
              if (entry.startsWith(baseName + ext + ".bak")) {
                try { await fs.unlink(path.join(dir, entry)); } catch {}
              }
            }
            // Also check backupDir for backups
            const backupEntries = await fs.readdir(backupDir).catch(() => []);
            for (const entry of backupEntries) {
              if (entry.includes(baseName)) {
                try { await fs.unlink(path.join(backupDir, entry)); } catch {}
              }
            }
            sendJson(res, { deleted: paper.path, backupsCleaned: true });
            return;
          }

          const openFolderMatch = url.pathname.match(/^\/api\/docs\/([^/]+)\/open-folder$/);
          if (req.method === "POST" && openFolderMatch) {
            const paper = await findPaperById(decodeURIComponent(openFolderMatch[1]));
            const dir = path.dirname(paper.path);
            execFile("explorer.exe", [dir]);
            sendJson(res, { opened: dir });
            return;
          }

          sendJson(res, { error: "Not found" }, 404);
        } catch (error) {
          sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: {
    port: 5177
  }
});

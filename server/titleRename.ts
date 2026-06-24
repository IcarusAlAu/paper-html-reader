import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { analyzeHtml, atomicWrite, backupFile, sha256File } from "./doctor";

type RenameHistory = {
  entries: Array<{
    id: string;
    filePath: string;
    sourcePath: string;
    oldTitle: string;
    newTitle: string;
    backupPath: string;
    timestamp: string;
  }>;
};

export async function renameDocumentTitle(
  paper: { path: string; sourcePath: string },
  options: {
    title: string;
    expectedHash?: string;
    libraryRoot: string;
    sourceRoot: string;
    historyFile: string;
  }
) {
  const title = options.title.replace(/\s+/g, " ").trim();
  if (!title) {
    throw new Error("Rename failed: title cannot be empty.");
  }
  if (title.length > 300) {
    throw new Error("Rename failed: title is too long.");
  }

  const filePath = safeInside(paper.path, options.libraryRoot, "Rename target is outside reader working library.");
  safeInside(paper.sourcePath, options.sourceRoot, "Source path is not under paper/pro.");
  await fs.access(filePath);

  const currentHash = await sha256File(filePath);
  if (options.expectedHash && currentHash !== options.expectedHash) {
    throw new Error("Rename failed: file was modified after opening. Reload the document before renaming.");
  }

  const original = await fs.readFile(filePath, "utf8");
  const dom = new JSDOM(original);
  const { document } = dom.window;
  if (!document.documentElement || !document.head || !document.body) {
    throw new Error("Rename failed: html/head/body structure is incomplete.");
  }

  const health = analyzeHtml(original, filePath, paper.sourcePath);
  if (health.status === "readonly") {
    throw new Error("Rename failed: Doctor marked this document readonly.");
  }

  const oldTitle = extractReaderTitle(document, filePath);
  upsertReaderTitle(document, title);
  const nextHtml = dom.serialize();
  if (nextHtml === original) {
    return {
      title,
      oldTitle,
      hash: currentHash,
      backupPath: "",
      changed: false
    };
  }

  const backupPath = await backupFile(filePath);
  try {
    await atomicWrite(filePath, nextHtml);
    const verified = new JSDOM(await fs.readFile(filePath, "utf8"));
    if (!verified.window.document.documentElement || !verified.window.document.head || !verified.window.document.body) {
      throw new Error("Post-rename validation failed: html/head/body missing.");
    }
  } catch (error) {
    await fs.copyFile(backupPath, filePath);
    throw error;
  }

  await appendRenameHistory(options.historyFile, {
    id: randomUUID(),
    filePath,
    sourcePath: paper.sourcePath,
    oldTitle,
    newTitle: title,
    backupPath,
    timestamp: new Date().toISOString()
  });

  return {
    title,
    oldTitle,
    hash: await sha256File(filePath),
    backupPath,
    changed: true
  };
}

function upsertReaderTitle(document: Document, title: string) {
  const titleElement = document.querySelector("title") || document.head.appendChild(document.createElement("title"));
  titleElement.textContent = title;

  let meta = document.querySelector<HTMLMetaElement>('meta[name="reader-title"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "reader-title");
    document.head.append(meta);
  }
  meta.setAttribute("content", title);
}

function extractReaderTitle(document: Document, filePath: string) {
  return (
    document.querySelector<HTMLMetaElement>('meta[name="reader-title"]')?.content?.replace(/\s+/g, " ").trim() ||
    document.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim() ||
    document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ||
    path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ")
  );
}

async function appendRenameHistory(historyFile: string, entry: RenameHistory["entries"][number]) {
  let history: RenameHistory = { entries: [] };
  try {
    history = JSON.parse(await fs.readFile(historyFile, "utf8")) as RenameHistory;
  } catch {
    // keep empty history
  }
  history.entries.push(entry);
  await fs.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.writeFile(historyFile, JSON.stringify(history, null, 2), "utf8");
}

function safeInside(filePath: string, root: string, message: string) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(message);
  }
  return resolved;
}

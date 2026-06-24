import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";
import { analyzeHtml, atomicWrite, backupFile, sha256File, validateEditPreflight } from "./doctor";

export type EditOperation =
  | "update"
  | "delete"
  | "insertBefore"
  | "insertAfter"
  | "selectionDelete"
  | "selectionReplace"
  | "selectionInsertAfter";

export type InsertKind = "paragraph" | "translation" | "note" | "heading";

export type EditHistoryEntry = {
  id: string;
  filePath: string;
  blockId: string;
  operation: EditOperation;
  oldHtml: string;
  newHtml: string;
  timestamp: string;
  beforeBlockId?: string;
  afterBlockId?: string;
  insertedBlockId?: string;
  backupPath?: string;
};

type EditHistory = {
  entries: EditHistoryEntry[];
};

type BlockEditRequest =
  | {
      filePath: string;
      sourcePath?: string;
      expectedHash?: string;
      blockId: string;
      operation: "update";
      text: string;
    }
  | {
      filePath: string;
      sourcePath?: string;
      expectedHash?: string;
      blockId: string;
      operation: "delete";
    }
  | {
      filePath: string;
      sourcePath?: string;
      expectedHash?: string;
      blockId: string;
      operation: "insertBefore" | "insertAfter";
      insertKind: InsertKind;
      text: string;
    }
  | {
      filePath: string;
      sourcePath?: string;
      expectedHash?: string;
      blockId: string;
      operation: "selectionDelete" | "selectionReplace" | "selectionInsertAfter";
      start: number;
      end: number;
      text?: string;
    };

const editableSelector = [
  "h1",
  "h2",
  "h3",
  "h4",
  "p",
  "li",
  "figcaption",
  "td",
  "th",
  "blockquote",
  "div.reader-note"
].join(",");

function textSlug(text: string) {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function generateBlockId(element: Element, index: number, used: Set<string>) {
  const tag = element.tagName.toLowerCase();
  const seed = `${tag}-${index}-${textSlug(element.textContent || randomUUID())}`;
  let candidate = `blk-${seed}`;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = `blk-${seed}-${suffix++}`;
  }
  used.add(candidate);
  return candidate;
}

function generateNewBlockId(used: Set<string>) {
  let candidate = `blk-new-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  while (used.has(candidate)) {
    candidate = `blk-new-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  }
  used.add(candidate);
  return candidate;
}

function isProtected(element: Element) {
  return Boolean(element.closest("script,style,nav#outline,math"));
}

function allEditableBlocks(document: Document) {
  return Array.from(document.querySelectorAll<HTMLElement>(editableSelector)).filter((element) => !isProtected(element));
}

function serialize(document: Document) {
  return domForDocument(document).serialize();
}

function domForDocument(document: Document) {
  return document.defaultView as unknown as JSDOM;
}

function parseHtml(html: string) {
  return new JSDOM(html);
}

function safeResolveInLibrary(filePath: string, libraryRoot: string) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(libraryRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !/\.html?$/i.test(resolved)) {
    throw new Error("Document path is outside the configured library");
  }
  return resolved;
}

export async function ensureBlockIds(filePath: string, libraryRoot: string, historyFile: string) {
  const resolved = safeResolveInLibrary(filePath, libraryRoot);
  const html = await fs.readFile(resolved, "utf8");
  const dom = parseHtml(html);
  const { document } = dom.window;
  const used = new Set<string>();
  let changed = false;

  allEditableBlocks(document).forEach((element, index) => {
    const existing = element.getAttribute("data-block-id");
    if (existing && !used.has(existing)) {
      used.add(existing);
      return;
    }
    element.setAttribute("data-block-id", generateBlockId(element, index, used));
    changed = true;
  });

  if (!changed) {
    return { changed: false, html };
  }

  updateOutline(document);
  const nextHtml = dom.serialize();
  const backupPath = await backupFile(resolved);
  await atomicWrite(resolved, nextHtml);
  await appendHistory(historyFile, {
    id: randomUUID(),
    filePath: resolved,
    blockId: "__document__",
    operation: "update",
    oldHtml: html,
    newHtml: nextHtml,
    timestamp: new Date().toISOString(),
    backupPath
  });
  return { changed: true, html: nextHtml };
}

export async function editBlock(request: BlockEditRequest, libraryRoot: string, sourceRoot: string, historyFile: string) {
  const resolved = safeResolveInLibrary(request.filePath, libraryRoot);
  const hashBeforeBlockIdRepair = await sha256File(resolved);
  const openHash = request.expectedHash || hashBeforeBlockIdRepair;
  await validateEditPreflight({
    filePath: resolved,
    sourcePath: request.sourcePath,
    sourceRoot,
    libraryRoot,
    blockId: request.blockId,
    expectedHash: openHash,
    operation: request.operation
  });
  await ensureBlockIds(resolved, libraryRoot, historyFile);
  await validateEditPreflight({
    filePath: resolved,
    sourcePath: request.sourcePath,
    sourceRoot,
    libraryRoot,
    blockId: request.blockId,
    operation: request.operation
  });

  const html = await fs.readFile(resolved, "utf8");
  const dom = parseHtml(html);
  const { document } = dom.window;
  const block = document.querySelector<HTMLElement>(`[data-block-id="${cssEscape(request.blockId)}"]`);
  if (!block || isProtected(block)) {
    throw new Error("Editable block not found");
  }

  const beforeBlockId = previousEditableBlockId(block);
  const afterBlockId = nextEditableBlockId(block);
  const oldHtml = block.outerHTML;
  let newHtml = "";
  let insertedBlockId: string | undefined;

  if (request.operation === "update") {
    block.textContent = request.text;
    newHtml = block.outerHTML;
  } else if (request.operation === "delete") {
    block.remove();
    newHtml = "";
  } else if (request.operation === "insertBefore" || request.operation === "insertAfter") {
    const used = new Set(allEditableBlocks(document).map((item) => item.getAttribute("data-block-id") || ""));
    const inserted = createInsertedBlock(document, request.insertKind, request.text, generateNewBlockId(used));
    insertedBlockId = inserted.getAttribute("data-block-id") || undefined;
    if (request.operation === "insertBefore") {
      block.before(inserted);
    } else {
      block.after(inserted);
    }
    newHtml = inserted.outerHTML;
  } else if (
    request.operation === "selectionDelete" ||
    request.operation === "selectionReplace" ||
    request.operation === "selectionInsertAfter"
  ) {
    applySelectionEdit(block, request);
    newHtml = block.outerHTML;
  } else {
    throw new Error("Unsupported edit operation");
  }

  updateOutline(document);
  const nextHtml = dom.serialize();
  const backupPath = await backupFile(resolved);
  try {
    await atomicWrite(resolved, nextHtml);
    const verified = parseHtml(await fs.readFile(resolved, "utf8"));
    if (!verified.window.document.documentElement || !verified.window.document.head || !verified.window.document.body) {
      throw new Error("Post-write validation failed: html/head/body missing.");
    }
    const health = analyzeHtml(await fs.readFile(resolved, "utf8"), resolved, request.sourcePath || resolved);
    const duplicateBlockIssue = health.issues.find((issue) => issue.code === "DUPLICATE_BLOCK_ID");
    if (duplicateBlockIssue) {
      throw new Error("Post-write validation failed: duplicate data-block-id.");
    }
  } catch (writeError) {
    await fs.copyFile(backupPath, resolved);
    throw writeError;
  }

  const entry: EditHistoryEntry = {
    id: randomUUID(),
    filePath: resolved,
    blockId: request.blockId,
    operation: request.operation,
    oldHtml,
    newHtml,
    timestamp: new Date().toISOString(),
    beforeBlockId,
    afterBlockId,
    insertedBlockId,
    backupPath
  };
  await appendHistory(historyFile, entry);
  return entry;
}

export async function undoLastEdit(libraryRoot: string, historyFile: string) {
  const history = await readHistory(historyFile);
  const entry = history.entries.pop();
  if (!entry) {
    throw new Error("No edit history to undo");
  }

  const resolved = safeResolveInLibrary(entry.filePath, libraryRoot);
  const html = await fs.readFile(resolved, "utf8");
  const dom = parseHtml(html);
  const { document } = dom.window;

  if (entry.blockId === "__document__") {
    const backupPath = await backupFile(resolved);
    await fs.writeFile(resolved, entry.oldHtml, "utf8");
    await writeHistory(historyFile, history);
    return { undone: entry, backupPath };
  }

  if (entry.operation === "insertBefore" || entry.operation === "insertAfter") {
    const inserted = entry.insertedBlockId
      ? document.querySelector<HTMLElement>(`[data-block-id="${cssEscape(entry.insertedBlockId)}"]`)
      : null;
    inserted?.remove();
  } else if (entry.operation === "delete") {
    restoreDeletedBlock(document, entry);
  } else {
    const block = document.querySelector<HTMLElement>(`[data-block-id="${cssEscape(entry.blockId)}"]`);
    if (!block) {
      restoreDeletedBlock(document, entry);
    } else {
      replaceElementWithHtml(document, block, entry.oldHtml);
    }
  }

  updateOutline(document);
  const backupPath = await backupFile(resolved);
  await fs.writeFile(resolved, dom.serialize(), "utf8");
  await writeHistory(historyFile, history);
  return { undone: entry, backupPath };
}

function createInsertedBlock(document: Document, kind: InsertKind, text: string, blockId: string) {
  const element =
    kind === "heading"
      ? document.createElement("h3")
      : kind === "note"
        ? document.createElement("div")
        : document.createElement("p");
  if (kind === "translation") {
    element.className = "translation";
  }
  if (kind === "note") {
    element.className = "reader-note";
  }
  element.setAttribute("data-block-id", blockId);
  element.textContent = text;
  return element;
}

function applySelectionEdit(
  block: HTMLElement,
  request: Extract<BlockEditRequest, { operation: "selectionDelete" | "selectionReplace" | "selectionInsertAfter" }>
) {
  const source = block.textContent || "";
  const start = Math.max(0, Math.min(request.start, source.length));
  const end = Math.max(start, Math.min(request.end, source.length));
  const replacement = request.text || "";
  if (request.operation === "selectionDelete") {
    block.textContent = `${source.slice(0, start)}${source.slice(end)}`;
  } else if (request.operation === "selectionReplace") {
    block.textContent = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
  } else {
    block.textContent = `${source.slice(0, end)}${replacement}${source.slice(end)}`;
  }
}

function previousEditableBlockId(block: Element) {
  const blocks = allEditableBlocks(block.ownerDocument);
  const index = blocks.indexOf(block as HTMLElement);
  return index > 0 ? blocks[index - 1].getAttribute("data-block-id") || undefined : undefined;
}

function nextEditableBlockId(block: Element) {
  const blocks = allEditableBlocks(block.ownerDocument);
  const index = blocks.indexOf(block as HTMLElement);
  return index >= 0 && index < blocks.length - 1 ? blocks[index + 1].getAttribute("data-block-id") || undefined : undefined;
}

function restoreDeletedBlock(document: Document, entry: EditHistoryEntry) {
  const template = document.createElement("template");
  template.innerHTML = entry.oldHtml;
  const restored = template.content.firstElementChild;
  if (!restored) {
    throw new Error("Cannot restore deleted block");
  }
  const before = entry.afterBlockId
    ? document.querySelector<HTMLElement>(`[data-block-id="${cssEscape(entry.afterBlockId)}"]`)
    : null;
  if (before) {
    before.before(restored);
    return;
  }
  const after = entry.beforeBlockId
    ? document.querySelector<HTMLElement>(`[data-block-id="${cssEscape(entry.beforeBlockId)}"]`)
    : null;
  if (after) {
    after.after(restored);
    return;
  }
  document.body.append(restored);
}

function replaceElementWithHtml(document: Document, element: Element, html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const replacement = template.content.firstElementChild;
  if (!replacement) {
    throw new Error("Cannot restore block HTML");
  }
  element.replaceWith(replacement);
}

function updateOutline(document: Document) {
  const headings = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,h4")).filter((heading) => !heading.closest("nav#outline"));
  headings.forEach((heading, index) => {
    if (!heading.id) {
      heading.id = headingIdFor(heading.textContent || "section", index);
    }
  });

  let outline = document.querySelector("nav#outline");
  if (!outline) {
    outline = document.createElement("nav");
    outline.id = "outline";
    document.body.prepend(outline);
  }
  outline.innerHTML = '<div class="title">Outline</div>';
  headings.forEach((heading) => {
    const anchor = document.createElement("a");
    anchor.className = `lv${heading.tagName.slice(1)}`;
    anchor.setAttribute("href", `#${heading.id}`);
    anchor.textContent = heading.textContent?.replace(/\s+/g, " ").trim() || "Untitled";
    outline.append(anchor);
  });
}

function headingIdFor(text: string, index: number) {
  const base = text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "section"}-${index + 1}`;
}

async function readHistory(historyFile: string): Promise<EditHistory> {
  try {
    return JSON.parse(await fs.readFile(historyFile, "utf8")) as EditHistory;
  } catch {
    return { entries: [] };
  }
}

async function writeHistory(historyFile: string, history: EditHistory) {
  await fs.mkdir(path.dirname(historyFile), { recursive: true });
  await fs.writeFile(historyFile, JSON.stringify(history, null, 2), "utf8");
}

async function appendHistory(historyFile: string, entry: EditHistoryEntry) {
  const history = await readHistory(historyFile);
  history.entries.push(entry);
  await writeHistory(historyFile, history);
}

function cssEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export type BatchEditResult = {
  applied: number;
  failed: number;
  errors: string[];
  hash: string;
};

export async function batchEditBlocks(
  filePath: string,
  operations: BlockEditRequest[],
  libraryRoot: string,
  sourceRoot: string,
  historyFile: string
): Promise<BatchEditResult> {
  const resolved = safeResolveInLibrary(filePath, libraryRoot);
  await ensureBlockIds(resolved, libraryRoot, historyFile);

  const html = await fs.readFile(resolved, "utf8");
  const dom = parseHtml(html);
  const { document } = dom.window;

  let applied = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const request of operations) {
    try {
      const block = document.querySelector<HTMLElement>(`[data-block-id="${cssEscape(request.blockId)}"]`);
      if (!block || isProtected(block)) {
        failed++;
        errors.push(`Block ${request.blockId}: not found or protected`);
        continue;
      }

      if (request.operation === "delete") {
        block.remove();
      } else if (request.operation === "update") {
        block.textContent = (request as { text: string }).text;
      } else if (request.operation === "insertBefore" || request.operation === "insertAfter") {
        const used = new Set(allEditableBlocks(document).map((item) => item.getAttribute("data-block-id") || ""));
        const inserted = createInsertedBlock(document, (request as { insertKind: InsertKind }).insertKind, (request as { text: string }).text, generateNewBlockId(used));
        if (request.operation === "insertBefore") {
          block.before(inserted);
        } else {
          block.after(inserted);
        }
      } else if (request.operation === "selectionDelete" || request.operation === "selectionReplace" || request.operation === "selectionInsertAfter") {
        applySelectionEdit(block, request as Extract<BlockEditRequest, { operation: "selectionDelete" | "selectionReplace" | "selectionInsertAfter" }>);
      } else {
        failed++;
        errors.push(`Block ${request.blockId}: unknown operation ${request.operation}`);
        continue;
      }
      applied++;
    } catch (err) {
      failed++;
      errors.push(`Block ${request.blockId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  updateOutline(document);
  const nextHtml = dom.serialize();
  const backupPath = await backupFile(resolved);
  try {
    await atomicWrite(resolved, nextHtml);
    const verified = parseHtml(await fs.readFile(resolved, "utf8"));
    if (!verified.window.document.documentElement || !verified.window.document.head || !verified.window.document.body) {
      throw new Error("Post-write validation failed: html/head/body missing.");
    }
  } catch (writeError) {
    await fs.copyFile(backupPath, resolved);
    throw writeError;
  }

  // Append history
  const entry: EditHistoryEntry = {
    id: randomUUID(),
    filePath: resolved,
    blockId: "__batch__",
    operation: "update",
    oldHtml: "",
    newHtml: `[batch: ${applied} applied, ${failed} failed]`,
    timestamp: new Date().toISOString(),
    backupPath
  };
  await appendHistory(historyFile, entry);

  return { applied, failed, errors, hash: await sha256File(resolved) };
}

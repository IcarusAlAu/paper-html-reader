import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { JSDOM } from "jsdom";

export type HealthStatus = "ok" | "warning" | "error" | "readonly";
export type IssueSeverity = "info" | "warning" | "error";

export type DoctorIssue = {
  code: string;
  severity: IssueSeverity;
  message: string;
  suggestion: string;
  autoFixable: boolean;
};

export type DoctorHealth = {
  status: HealthStatus;
  score: number;
  issues: DoctorIssue[];
};

export type DoctorReportEntry = {
  id: string;
  fileName: string;
  filePath: string;
  sourcePath: string;
  hash: string;
  checkedAt: string;
  health: DoctorHealth;
};

type DoctorReport = {
  generatedAt: string;
  entries: DoctorReportEntry[];
};

type DoctorFixHistory = {
  entries: Array<{
    id: string;
    filePath: string;
    sourcePath: string;
    dryRun: boolean;
    appliedFixes: string[];
    diff: string;
    backupPath?: string;
    timestamp: string;
  }>;
};

const editableSelector = "h1,h2,h3,h4,p,li,figcaption,td,th,blockquote,div.reader-note";
const badTitles = new Set(["", "full", "untitled", "document", "index"]);

export async function sha256File(filePath: string) {
  const { createReadStream } = await import("fs");
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export function analyzeHtml(html: string, filePath: string, sourcePath = filePath): DoctorHealth {
  const issues: DoctorIssue[] = [];
  let dom: JSDOM;
  try {
    dom = new JSDOM(html);
  } catch (error) {
    return {
      status: "error",
      score: 0,
      issues: [
        issue(
          "PARSE_FAILED",
          "error",
          `HTML parse failed: ${error instanceof Error ? error.message : String(error)}`,
          "Open the file manually or regenerate the HTML.",
          false
        )
      ]
    };
  }
  const { document } = dom.window;

  if (!sourcePath.toLowerCase().includes(`${path.sep}paper${path.sep}pro${path.sep}`.toLowerCase())) {
    issues.push(issue("SOURCE_NOT_PRO", "warning", "Source path is not under paper/pro.", "Check reader source mapping.", false));
  }
  if (!document.documentElement) {
    issues.push(issue("MISSING_HTML", "error", "Missing html element.", "Regenerate or repair the document shell.", false));
  }
  if (!document.head) {
    issues.push(issue("MISSING_HEAD", "error", "Missing head element.", "Regenerate or repair the document shell.", false));
  }
  if (!document.body) {
    issues.push(issue("MISSING_BODY", "error", "Missing body element.", "Regenerate or repair the document shell.", false));
  }
  if (!document.querySelector("meta[charset]")) {
    issues.push(issue("MISSING_META_CHARSET", "warning", "Missing meta charset.", 'Add <meta charset="utf-8"> to head.', true));
  }

  const title = (document.querySelector("title")?.textContent || "").replace(/\s+/g, " ").trim();
  if (badTitles.has(title.toLowerCase())) {
    issues.push(issue("BAD_TITLE", "warning", `Suspicious title: "${title || "(empty)"}".`, "Infer a better title from the first heading or filename.", true));
  }

  const externalScripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"));
  externalScripts.forEach((script) => {
    const src = script.getAttribute("src") || "";
    issues.push(
      issue(
        /mathjax/i.test(src) ? "EXTERNAL_MATHJAX_CDN" : "EXTERNAL_SCRIPT",
        "warning",
        `External script found: ${src}`,
        "Remove it for offline-safe reading, or replace with a local bundled script.",
        true
      )
    );
  });

  const outline = document.querySelector("nav#outline,#outline");
  const headings = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,h4")).filter((heading) => !heading.closest("#outline"));
  if (!outline) {
    issues.push(issue("MISSING_OUTLINE", "warning", "Missing #outline.", "Rebuild outline from h1-h4.", true));
  }
  if (!headings.length) {
    issues.push(issue("MISSING_HEADINGS", "warning", "No h1-h4 headings found.", "Check whether this HTML is a true paper body.", false));
  }
  if (outline && headings.length) {
    const outlineTargets = new Set(
      Array.from(outline.querySelectorAll<HTMLAnchorElement>("a[href^='#']")).map((anchor) => decodeURIComponent(anchor.hash.slice(1)))
    );
    const headingIds = new Set(headings.map((heading) => heading.id).filter(Boolean));
    const mismatch = [...headingIds].filter((id) => !outlineTargets.has(id)).length + [...outlineTargets].filter((id) => !headingIds.has(id)).length;
    if (mismatch) {
      issues.push(issue("OUTLINE_MISMATCH", "warning", `Outline differs from headings in ${mismatch} places.`, "Rebuild outline from h1-h4.", true));
    }
  }

  const translations = Array.from(document.querySelectorAll<HTMLElement>(".translation"));
  if (!translations.length) {
    issues.push(issue("NO_TRANSLATION", "warning", "No .translation paragraphs found.", "Confirm whether this is expected for the document.", false));
  }
  const translationClassFixes = Array.from(document.querySelectorAll<HTMLElement>("p[class]")).filter((element) =>
    (element.getAttribute("class") || "").split(/\s+/).some((name) => /^translat/i.test(name) && name !== "translation")
  );
  if (translationClassFixes.length) {
    issues.push(issue("TRANSLATION_CLASS_VARIANT", "warning", "Found translation-like class names.", "Normalize translation paragraphs to class=\"translation\".", true));
  }
  let consecutiveTranslations = 0;
  let orphanTranslations = 0;
  translations.forEach((translation) => {
    const previous = previousElement(translation);
    if (previous?.classList.contains("translation")) consecutiveTranslations += 1;
    if (!previous || ["SCRIPT", "STYLE", "NAV"].includes(previous.tagName)) orphanTranslations += 1;
  });
  if (consecutiveTranslations) {
    issues.push(issue("CONSECUTIVE_TRANSLATIONS", "warning", `${consecutiveTranslations} consecutive translation blocks found.`, "Review paragraph pairing manually.", false));
  }
  if (orphanTranslations) {
    issues.push(issue("ORPHAN_TRANSLATION", "warning", `${orphanTranslations} translation blocks appear isolated.`, "Review paragraph pairing manually.", false));
  }

  const ids = new Map<string, number>();
  document.querySelectorAll<HTMLElement>("[id]").forEach((element) => ids.set(element.id, (ids.get(element.id) || 0) + 1));
  const duplicateIds = [...ids].filter(([, count]) => count > 1);
  if (duplicateIds.length) {
    issues.push(issue("DUPLICATE_ID", "error", `${duplicateIds.length} duplicated id values found.`, "Repair duplicate ids before editing.", false));
  }

  const editableBlocks = Array.from(document.querySelectorAll<HTMLElement>(editableSelector)).filter((element) => !element.closest("script,style,nav#outline,math"));
  const missingBlockIds = editableBlocks.filter((element) => !element.getAttribute("data-block-id")).length;
  if (missingBlockIds) {
    issues.push(issue("MISSING_BLOCK_ID", "warning", `${missingBlockIds} editable blocks lack data-block-id.`, "Add stable data-block-id values.", true));
  }
  const blockIds = new Map<string, number>();
  editableBlocks.forEach((element) => {
    const id = element.getAttribute("data-block-id");
    if (id) blockIds.set(id, (blockIds.get(id) || 0) + 1);
  });
  const duplicateBlockIds = [...blockIds].filter(([, count]) => count > 1);
  if (duplicateBlockIds.length) {
    issues.push(issue("DUPLICATE_BLOCK_ID", "error", `${duplicateBlockIds.length} duplicated data-block-id values found.`, "Regenerate duplicate block ids.", true));
  }

  const missingImages = Array.from(document.querySelectorAll<HTMLImageElement>("img[src]")).filter((img) => {
    const src = img.getAttribute("src") || "";
    if (/^(https?:|data:|blob:)/i.test(src)) return false;
    return src && !fileExistsSyncLike(path.resolve(path.dirname(filePath), src));
  });
  if (missingImages.length) {
    issues.push(issue("BROKEN_IMAGE_SRC", "warning", `${missingImages.length} local image references appear missing.`, "Check relative asset folders.", false));
  }

  const bodyBlocks = Array.from(document.body?.querySelectorAll<HTMLElement>("p,li,blockquote") || []);
  const emptyParagraphs = bodyBlocks.filter((element) => element.tagName === "P" && !(element.textContent || "").trim()).length;
  if (emptyParagraphs) {
    issues.push(issue("EMPTY_PARAGRAPHS", "info", `${emptyParagraphs} empty paragraphs found.`, "Delete empty p elements.", true));
  }
  const shortParagraphs = bodyBlocks.filter((element) => {
    const text = (element.textContent || "").trim();
    return text.length > 0 && text.length <= 3;
  }).length;
  if (shortParagraphs > 20) {
    issues.push(issue("MANY_SHORT_PARAGRAPHS", "warning", `${shortParagraphs} very short paragraphs found.`, "Review extraction quality.", false));
  }
  const paragraphTexts = new Map<string, number>();
  bodyBlocks.forEach((element) => {
    const text = (element.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length > 20) paragraphTexts.set(text, (paragraphTexts.get(text) || 0) + 1);
  });
  const repeated = [...paragraphTexts].filter(([, count]) => count > 1).length;
  if (repeated) {
    issues.push(issue("DUPLICATE_PARAGRAPHS", "warning", `${repeated} repeated paragraph texts found.`, "Review duplicated extraction output.", false));
  }

  const frontText = bodyBlocks
    .slice(0, 12)
    .map((element) => element.textContent || "")
    .join("\n");
  const frontMatterHits = (frontText.match(/@|email|university|institute|department|author|affiliation|corresponding/gi) || []).length;
  if (frontMatterHits >= 4) {
    issues.push(
      issue("FRONT_MATTER_MIXED_IN_BODY", "warning", "Author/email/affiliation-like front matter appears in body start.", "Wrap as section.front-matter after review.", false)
    );
  }

  const score = Math.max(
    0,
    100 -
      issues.reduce((total, item) => total + (item.severity === "error" ? 30 : item.severity === "warning" ? 10 : 2), 0)
  );
  const status: HealthStatus = issues.some((item) => item.severity === "error")
    ? "error"
    : issues.some((item) => item.severity === "warning")
      ? "warning"
      : "ok";

  return { status, score, issues };
}

export async function buildDoctorReport(
  papers: Array<{ id: string; fileName: string; path: string; sourcePath: string; hash?: string }>,
  reportFile: string
) {
  const existing = await readDoctorReport(reportFile);
  const cachedById = new Map(existing.entries.map((entry) => [entry.id, entry]));
  const entries: DoctorReportEntry[] = [];
  for (const paper of papers) {
    const hash = paper.hash || (await sha256File(paper.path));
    const cached = cachedById.get(paper.id);
    if (cached?.hash === hash) {
      entries.push({
        ...cached,
        fileName: paper.fileName,
        filePath: paper.path,
        sourcePath: paper.sourcePath
      });
      continue;
    }
    const html = await fs.readFile(paper.path, "utf8");
    entries.push({
      id: paper.id,
      fileName: paper.fileName,
      filePath: paper.path,
      sourcePath: paper.sourcePath,
      hash,
      checkedAt: new Date().toISOString(),
      health: analyzeHtml(html, paper.path, paper.sourcePath)
    });
  }
  const report = { generatedAt: new Date().toISOString(), entries };
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2), "utf8");
  return report;
}

export async function readDoctorReport(reportFile: string): Promise<DoctorReport> {
  try {
    return JSON.parse(await fs.readFile(reportFile, "utf8")) as DoctorReport;
  } catch {
    return { generatedAt: "", entries: [] };
  }
}

export async function fixDocument(
  paper: { id: string; fileName: string; path: string; sourcePath: string },
  options: { dryRun: boolean; reportFile: string; historyFile: string }
) {
  const original = await fs.readFile(paper.path, "utf8");
  const { html, fixes } = applyLowRiskFixes(original, paper.path);
  const diff = createDiff(original, html);
  if (!options.dryRun && fixes.length && html !== original) {
    const backupPath = await backupFile(paper.path);
    await atomicWrite(paper.path, html);
    await appendFixHistory(options.historyFile, {
      id: randomUUID(),
      filePath: paper.path,
      sourcePath: paper.sourcePath,
      dryRun: false,
      appliedFixes: fixes,
      diff,
      backupPath,
      timestamp: new Date().toISOString()
    });
  }
  return {
    dryRun: options.dryRun,
    fixes,
    diff,
    health: analyzeHtml(html, paper.path, paper.sourcePath)
  };
}

export function applyLowRiskFixes(html: string, filePath: string) {
  const dom = new JSDOM(html);
  const { document } = dom.window;
  const fixes: string[] = [];

  if (!document.querySelector("meta[charset]")) {
    const meta = document.createElement("meta");
    meta.setAttribute("charset", "utf-8");
    document.head.prepend(meta);
    fixes.push("MISSING_META_CHARSET");
  }

  document.querySelectorAll<HTMLScriptElement>("script[src]").forEach((script) => {
    fixes.push(/mathjax/i.test(script.src) ? "EXTERNAL_MATHJAX_CDN" : "EXTERNAL_SCRIPT");
    script.remove();
  });

  const title = document.querySelector("title") || document.head.appendChild(document.createElement("title"));
  const currentTitle = (title.textContent || "").replace(/\s+/g, " ").trim();
  if (badTitles.has(currentTitle.toLowerCase())) {
    title.textContent = inferTitle(document, filePath);
    fixes.push("BAD_TITLE");
  }

  const usedBlockIds = new Set<string>();
  let blockIndex = 0;
  document.querySelectorAll<HTMLElement>(editableSelector).forEach((element) => {
    if (element.closest("script,style,nav#outline,math")) return;
    const existing = element.getAttribute("data-block-id");
    if (!existing || usedBlockIds.has(existing)) {
      element.setAttribute("data-block-id", blockIdFor(element, blockIndex, usedBlockIds));
      fixes.push(existing ? "DUPLICATE_BLOCK_ID" : "MISSING_BLOCK_ID");
    } else {
      usedBlockIds.add(existing);
    }
    blockIndex += 1;
  });

  document.querySelectorAll<HTMLElement>("p[class]").forEach((element) => {
    const classes = (element.getAttribute("class") || "").split(/\s+/);
    if (classes.some((name) => /^translat/i.test(name)) && !classes.includes("translation")) {
      element.classList.add("translation");
      fixes.push("TRANSLATION_CLASS_VARIANT");
    }
  });

  document.querySelectorAll("p").forEach((p) => {
    if (!(p.textContent || "").trim() && !p.querySelector("img,math,table")) {
      p.remove();
      fixes.push("EMPTY_PARAGRAPHS");
    }
  });

  rebuildOutline(document);
  fixes.push("OUTLINE_REBUILT");

  return { html: dom.serialize(), fixes: [...new Set(fixes)] };
}

export async function validateEditPreflight(args: {
  filePath: string;
  sourcePath?: string;
  sourceRoot: string;
  libraryRoot: string;
  blockId: string;
  expectedHash?: string;
  operation?: string;
}) {
  const filePath = safeInside(args.filePath, args.libraryRoot, "Edit target is outside reader working library.");
  if (args.sourcePath) safeInside(args.sourcePath, args.sourceRoot, "Source path is not under paper/pro.");
  await fs.access(filePath);
  const currentHash = await sha256File(filePath);
  if (args.expectedHash && currentHash !== args.expectedHash) {
    throw new Error("File was modified after opening. Reload the document before editing.");
  }
  const html = await fs.readFile(filePath, "utf8");
  const dom = new JSDOM(html);
  const { document } = dom.window;
  if (!document.body) throw new Error("Preflight failed: missing body.");
  const health = analyzeHtml(html, filePath, args.sourcePath || filePath);
  if (health.status === "error" || health.status === "readonly") {
    throw new Error(`Preflight failed: Doctor status is ${health.status}. Run Doctor fix first.`);
  }
  const blocks = Array.from(document.querySelectorAll<HTMLElement>(`[data-block-id="${cssEscape(args.blockId)}"]`));
  if (blocks.length !== 1) throw new Error(`Preflight failed: blockId must exist exactly once, found ${blocks.length}.`);
  const block = blocks[0];
  if (block.closest("script,style,nav#outline,math,img")) throw new Error("Preflight failed: block is inside protected content.");
  if (block.classList.contains("translation") && args.operation === "update" && block.tagName !== "P") {
    throw new Error("Preflight failed: translation block shape is unexpected.");
  }
  return { filePath, currentHash, health };
}

export async function atomicWrite(filePath: string, html: string) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, html, "utf8");
  await fs.rename(tmp, filePath);
}

export async function backupFile(filePath: string) {
  // Backup to centralized .backups/ directory, not next to source files
  const backupRoot = path.resolve(path.dirname(filePath), "..", ".backups");
  await fs.mkdir(backupRoot, { recursive: true });
  const base = path.basename(filePath);
  const bak1 = path.join(backupRoot, `${base}.bak.1`);
  const bak2 = path.join(backupRoot, `${base}.bak.2`);
  // Rotate: if .bak.1 exists, move it to .bak.2
  try {
    await fs.access(bak1);
    await fs.copyFile(bak1, bak2);
  } catch {
    // .bak.1 doesn't exist yet, that's fine
  }
  // Write new backup as .bak.1
  await fs.copyFile(filePath, bak1);
  return bak1;
}

export function rebuildOutline(document: Document) {
  const headings = Array.from(document.querySelectorAll<HTMLElement>("h1,h2,h3,h4")).filter((heading) => !heading.closest("nav#outline,#outline"));
  headings.forEach((heading, index) => {
    if (!heading.id) heading.id = headingIdFor(heading.textContent || "section", index);
  });
  let outline = document.querySelector("nav#outline") as HTMLElement | null;
  if (!outline) {
    outline = document.createElement("nav");
    outline.id = "outline";
    document.body.prepend(outline);
  }
  outline.innerHTML = '<div class="title">Outline</div>';
  headings.forEach((heading) => {
    const anchor = document.createElement("a");
    anchor.className = `lv${heading.tagName.slice(1)}`;
    anchor.href = `#${heading.id}`;
    anchor.textContent = (heading.textContent || "Untitled").replace(/\s+/g, " ").trim();
    outline.append(anchor);
  });
}

function issue(code: string, severity: IssueSeverity, message: string, suggestion: string, autoFixable: boolean): DoctorIssue {
  return { code, severity, message, suggestion, autoFixable };
}

function previousElement(element: Element) {
  let previous = element.previousElementSibling;
  while (previous && ["SCRIPT", "STYLE"].includes(previous.tagName)) previous = previous.previousElementSibling;
  return previous;
}

function fileExistsSyncLike(filePath: string) {
  return existsSync(filePath);
}

function inferTitle(document: Document, filePath: string) {
  return (
    document.querySelector("h1,h2,h3,h4")?.textContent?.replace(/\s+/g, " ").trim() ||
    path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ")
  );
}

function blockIdFor(element: Element, index: number, used: Set<string>) {
  const base = createHash("sha1")
    .update(`${element.tagName}-${index}-${element.textContent || randomUUID()}`)
    .digest("hex")
    .slice(0, 10);
  let id = `blk-${element.tagName.toLowerCase()}-${index}-${base}`;
  let suffix = 1;
  while (used.has(id)) id = `blk-${element.tagName.toLowerCase()}-${index}-${base}-${suffix++}`;
  used.add(id);
  return id;
}

function headingIdFor(text: string, index: number) {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "section"}-${index + 1}`;
}

function timestampForFile(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function createDiff(before: string, after: string) {
  if (before === after) return "";
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const output = ["--- before", "+++ after"];
  for (let index = 0; index < max; index += 1) {
    if (beforeLines[index] !== afterLines[index]) {
      if (beforeLines[index] !== undefined) output.push(`- ${beforeLines[index]}`);
      if (afterLines[index] !== undefined) output.push(`+ ${afterLines[index]}`);
    }
    if (output.length > 300) {
      output.push("... diff truncated ...");
      break;
    }
  }
  return output.join("\n");
}

async function appendFixHistory(historyFile: string, entry: DoctorFixHistory["entries"][number]) {
  let history: DoctorFixHistory = { entries: [] };
  try {
    history = JSON.parse(await fs.readFile(historyFile, "utf8")) as DoctorFixHistory;
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
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(message);
  return resolved;
}

function cssEscape(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

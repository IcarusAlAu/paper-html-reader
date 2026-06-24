import type { DisplayMode, OutlineItem, ReaderSettings } from "./types";

export function parseOutline(doc: Document): OutlineItem[] {
  const outline = doc.querySelector("#outline");
  if (outline) {
    const items = Array.from(outline.querySelectorAll<HTMLAnchorElement>("a[href^='#']")).map((anchor) => {
      const levelMatch = anchor.className.match(/lv(\d+)/);
      return {
        id: decodeURIComponent(anchor.hash.slice(1)),
        text: anchor.textContent?.replace(/\s+/g, " ").trim() || "Untitled",
        level: Number(levelMatch?.[1] || 1)
      };
    });
    if (items.length) {
      return items;
    }
  }

  return Array.from(doc.querySelectorAll<HTMLElement>("h1,h2,h3,h4")).map((heading, index) => {
    if (!heading.id) {
      heading.id = `reader-heading-${index + 1}`;
    }
    return {
      id: heading.id,
      text: heading.textContent?.replace(/\s+/g, " ").trim() || "Untitled",
      level: Number(heading.tagName.slice(1))
    };
  });
}

export function buildReaderHtml(source: string) {
  return source.replace(/<script\b[\s\S]*?<\/script>/gi, "<!-- Paper HTML Reader removed an inline script for V0 sandboxed reading. -->");
}

export function applyReaderSettings(doc: Document, settings: ReaderSettings) {
  doc.documentElement.dataset.readerMode = settings.displayMode;
  let style = doc.getElementById("paper-html-reader-style") as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = "paper-html-reader-style";
    doc.head.appendChild(style);
  }

  style.textContent = `
    :root {
      --reader-font-size: ${settings.fontSize}px;
      --reader-line-height: ${settings.lineHeight};
      --reader-content-width: ${settings.contentWidth}px;
      --reader-translation-bg: #f1faf5;
      --reader-translation-color: #355f43;
    }
    body {
      max-width: var(--reader-content-width) !important;
      margin: 0 auto !important;
      padding: 48px 44px 84px !important;
      color: #172026 !important;
      background: #ffffff !important;
      font-size: var(--reader-font-size) !important;
      line-height: var(--reader-line-height) !important;
    }
    body * {
      line-height: inherit;
    }
    #outline {
      display: none !important;
    }
    p.translation,
    .translation {
      background: var(--reader-translation-bg) !important;
      color: var(--reader-translation-color) !important;
      border-left: 3px solid #63a975 !important;
      padding: 0.58rem 0.82rem !important;
      border-radius: 0 6px 6px 0 !important;
    }
    html[data-reader-mode="original"] .translation {
      display: none !important;
    }
    html[data-reader-mode="translation"] body > :not(.translation):not(script):not(style) {
      display: none !important;
    }
    html[data-reader-mode="soft"] .translation {
      opacity: 0.72;
      font-size: 0.94em;
    }
    img {
      max-width: 100% !important;
      height: auto !important;
      cursor: zoom-in;
    }
    table {
      display: block;
      max-width: 100%;
      overflow-x: auto;
      border-collapse: collapse;
    }
    ::selection {
      background: rgba(245, 186, 66, 0.35);
    }
    [data-block-id] {
      border-radius: 5px;
      outline: 2px solid transparent;
      outline-offset: 3px;
      transition: outline-color 120ms ease, background-color 120ms ease;
    }
    [data-block-id]:hover {
      outline-color: rgba(11, 124, 130, 0.28);
    }
    [data-block-id][data-reader-selected="true"] {
      outline-color: rgba(11, 124, 130, 0.75);
      background-color: rgba(11, 124, 130, 0.055);
    }
    [data-block-id][contenteditable="plaintext-only"] {
      outline-color: #d99922;
      background-color: #fff8e8;
      caret-color: #0b7c82;
    }
    .reader-note {
      margin: 1rem 0;
      padding: 0.72rem 0.88rem;
      color: #334047;
      background: #fff7e5;
      border-left: 4px solid #d99b27;
      border-radius: 0 7px 7px 0;
      font-weight: 560;
    }
  `;
}

export function scrollToProgress(win: Window, progress: number) {
  requestAnimationFrame(() => {
    const doc = win.document.documentElement;
    const max = Math.max(0, doc.scrollHeight - win.innerHeight);
    win.scrollTo({ top: max * progress, behavior: "instant" });
  });
}

export function getScrollProgress(win: Window) {
  const doc = win.document.documentElement;
  const max = Math.max(1, doc.scrollHeight - win.innerHeight);
  return Math.max(0, Math.min(1, win.scrollY / max));
}

export function labelForDisplayMode(mode: DisplayMode) {
  return {
    bilingual: "Bilingual",
    original: "Original",
    translation: "Translation",
    soft: "Soft"
  }[mode];
}

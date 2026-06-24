import {
  AlertTriangle,
  ArrowDownAZ,
  ArrowUpAZ,
  Bold,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Edit3,
  FileText,
  Filter,
  FolderOpen,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  ListTree,
  MessageSquarePlus,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  StickyNote,
  Tag,
  Trash2,
  Type,
  Undo2,
  Wrench,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  applyDoctorFix,
  batchEdit,
  deleteBlock,
  deleteDocument,
  editSelection,
  fetchAnnotations,
  fetchDocument,
  fetchHighlights,
  fetchLibrary,
  fetchNote,
  fetchState,
  fetchTags,
  insertBlock,
  openDocumentFolder,
  openDoctorBackupFolder,
  previewDoctorFix,
  renameDocument,
  saveAnnotations,
  saveHighlights,
  saveNote,
  saveState,
  saveTags,
  undoLastEdit,
  updateBlock
} from "./api";
import {
  applyReaderSettings,
  buildReaderHtml,
  getScrollProgress,
  labelForDisplayMode,
  parseOutline,
  scrollToProgress
} from "./documentTools";
import type {
  Annotation,
  AnnotationStore,
  DisplayMode,
  DoctorFixResult,
  Highlight,
  HighlightColor,
  HighlightStore,
  InsertKind,
  OutlineItem,
  PaperSummary,
  ReaderState
} from "./types";
import { HIGHLIGHT_COLORS } from "./types";

/* ─── constants ───────────────────────────────────────────── */

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

const displayModes: DisplayMode[] = ["bilingual", "original", "translation", "soft"];
const editableBlockSelector = "h1,h2,h3,h4,p,li,figcaption,td,th,blockquote,div.reader-note";

type EditorMode = "browse" | "read" | "edit";

type PendingEdit = {
  blockId: string;
  operation: "delete" | "update" | "insertBefore" | "insertAfter";
  text?: string;
  filePath: string;
  sourcePath?: string;
  expectedHash?: string;
  insertKind?: InsertKind;
};

type SelectedBlock = {
  id: string;
  tagName: string;
  text: string;
  isTranslation: boolean;
  rect: {
    top: number;
    left: number;
    width: number;
  };
};

/* ─── helpers ─────────────────────────────────────────────── */

function formatBytes(bytes: number) {
  if (bytes > 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

function formatDate(value: string) {
  if (!value) {
    return "Never";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function healthBadge(status: PaperSummary["health"]["status"]) {
  if (status === "ok") {
    return "OK";
  }
  if (status === "error") {
    return "Error";
  }
  if (status === "readonly") {
    return "Readonly";
  }
  return "Warning";
}

function editContextFor(paper: PaperSummary) {
  return {
    filePath: paper.path,
    sourcePath: paper.sourcePath,
    expectedHash: paper.hash
  };
}

function buildSelectionAnnotation(docId: string, frameDoc: Document): Annotation {
  const selection = frameDoc.getSelection();
  const selectedText = selection?.toString().replace(/\s+/g, " ").trim() || "";
  const bodyText = frameDoc.body?.innerText || "";
  const start = selectedText ? bodyText.indexOf(selectedText) : -1;
  const safeStart = Math.max(0, start);
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const container = range?.startContainer.parentElement || frameDoc.body;

  return {
    id: `anno_${Date.now()}`,
    docId,
    selectedText: selectedText || "Untitled selection",
    prefix: bodyText.slice(Math.max(0, safeStart - 40), safeStart),
    suffix: bodyText.slice(safeStart + selectedText.length, safeStart + selectedText.length + 40),
    textPosition: {
      start: safeStart,
      end: safeStart + selectedText.length
    },
    cssPath: cssPathFor(container),
    type: "note",
    color: "amber",
    note: "",
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function cssPathFor(element: Element | null) {
  if (!element) {
    return "body";
  }
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current.tagName.toLowerCase() !== "html") {
    const tag = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`${tag}#${current.id}`);
      break;
    }
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter((item) => item.tagName === current?.tagName)
      : [];
    const index = siblings.indexOf(current) + 1;
    parts.unshift(index > 1 ? `${tag}:nth-of-type(${index})` : tag);
    current = current.parentElement;
  }
  return parts.join(" > ") || "body";
}

function nearestEditableBlock(target: EventTarget | null) {
  if (!target) {
    return null;
  }
  const node = target as Node;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>("[data-block-id]") || null;
}

function blockFromSelection(doc: Document) {
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return { error: "请先在同一段落内选择文字。" };
  }
  const anchorBlock = nearestEditableBlock(selection.anchorNode);
  const focusBlock = nearestEditableBlock(selection.focusNode);
  if (!anchorBlock || !focusBlock || anchorBlock.dataset.blockId !== focusBlock.dataset.blockId) {
    return { error: "暂不支持跨段落编辑，请进入段落编辑模式。" };
  }
  if (anchorBlock.closest("script,style,nav#outline,img,math")) {
    return { error: "该区域不可编辑。" };
  }
  const range = selection.getRangeAt(0);
  const preRange = doc.createRange();
  preRange.selectNodeContents(anchorBlock);
  preRange.setEnd(range.startContainer, range.startOffset);
  const start = preRange.toString().length;
  const selectedText = range.toString();
  return {
    blockId: anchorBlock.dataset.blockId || "",
    start,
    end: start + selectedText.length,
    selectedText
  };
}

/* ─── display mode dropdown ──────────────────────────────── */

const displayModeLabels: Record<DisplayMode, string> = {
  bilingual: "双语",
  original: "原文",
  translation: "译文",
  soft: "柔和"
};

function DisplayModeDropdown({
  value,
  onChange
}: {
  value: DisplayMode;
  onChange: (m: DisplayMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div className="mode-dropdown" ref={ref}>
      <button className="mode-dropdown-trigger" onClick={() => setOpen(!open)}>
        {displayModeLabels[value]}
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="mode-dropdown-menu">
          {displayModes.map((m) => (
            <button
              key={m}
              className={m === value ? "active" : ""}
              onClick={() => {
                onChange(m);
                setOpen(false);
              }}
            >
              {displayModeLabels[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── main component ─────────────────────────────────────── */

export function App() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const modeRef = useRef<EditorMode>("browse");
  const lastClickedBlockIdRef = useRef<string | null>(null);
  const [libraryRoot, setLibraryRoot] = useState("");
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [state, setState] = useState<ReaderState>(defaultState);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationStore>({ docId: "", items: [] });
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"outline" | "annotations" | "highlights" | "tags" | "doctor">("outline");
  const [status, setStatus] = useState("Loading");
  const [error, setError] = useState("");
  const [selectedBlock, setSelectedBlock] = useState<SelectedBlock | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [doctorFixPreview, setDoctorFixPreview] = useState<DoctorFixResult | null>(null);
  const [openedDocumentHash, setOpenedDocumentHash] = useState("");

  /* ── sort / filter state ── */
  type SortKey = "title-asc" | "title-desc" | "year-asc" | "year-desc";
  const [sortKey, setSortKey] = useState<SortKey>("year-desc");
  const [filterYear, setFilterYear] = useState("");
  const [filterTag, setFilterTag] = useState("");
  const [showFilterPanel, setShowFilterPanel] = useState(false);

  /* ── tags state ── */
  const [allTags, setAllTags] = useState<string[]>([]);
  const [docTags, setDocTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  /* ── highlight state ── */
  const [highlights, setHighlights] = useState<HighlightStore>({ docId: "", items: [] });
  const [highlightColor, setHighlightColor] = useState<HighlightColor>("yellow");

  /* ── new mode / deferred-edit state ── */
  const [mode, setMode] = useState<EditorMode>("browse");
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const [pendingEdits, setPendingEdits] = useState<PendingEdit[]>([]);

  /* ── multi-select state (edit mode) ── */
  const [selectedBlockIds, setSelectedBlockIds] = useState<Set<string>>(new Set());
  const [lastClickedBlockId, setLastClickedBlockId] = useState<string | null>(null);

  /* ── context menu state ── */
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; paper: PaperSummary } | null>(null);

  /* ── highlight popup state (read mode) ── */
  const [highlightPopup, setHighlightPopup] = useState<{ x: number; y: number; blockId: string; text: string } | null>(null);

  /* ── notes state ── */
  const [notesMode, setNotesMode] = useState(state.notesMode ?? false);
  const [noteContent, setNoteContent] = useState("");
  const noteEditorRef = useRef<HTMLDivElement>(null);
  const noteSaveTimer = useRef<number | undefined>(undefined);

  /* ── collapsed panels state ── */
  const [leftCollapsed, setLeftCollapsed] = useState(state.collapsedPanels?.left ?? false);
  const [rightCollapsed, setRightCollapsed] = useState(state.collapsedPanels?.right ?? false);

  /* ── iframe context menu state (copy to notes) ── */
  const [iframeContextMenu, setIframeContextMenu] = useState<{ x: number; y: number; blockId: string; docId: string; blockHtml: string; blockTag: string } | null>(null);

  /* ── column divider drag state ── */
  const [isDraggingDivider, setIsDraggingDivider] = useState<null | "left" | "right">(null);
  const dragStartRef = useRef<{ startX: number; startLeft: number; startRight: number }>({ startX: 0, startLeft: 300, startRight: 330 });

  const isDirty = pendingEdits.length > 0;

  const selectedPaper = useMemo(
    () => papers.find((paper) => paper.id === state.currentDocId) || papers[0],
    [papers, state.currentDocId]
  );
  const canEditSelectedPaper = selectedPaper?.health.status !== "error" && selectedPaper?.health.status !== "readonly";

  const filteredPapers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let result = papers;

    // text search
    if (needle) {
      result = result.filter((paper) => `${paper.title} ${paper.fileName} ${paper.year}`.toLowerCase().includes(needle));
    }

    // year filter
    if (filterYear) {
      result = result.filter((paper) => paper.year === filterYear);
    }

    // tag filter
    if (filterTag) {
      result = result.filter((paper) => paper.tags?.includes(filterTag));
    }

    // sort
    const sorted = [...result];
    switch (sortKey) {
      case "title-asc":
        sorted.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
        break;
      case "title-desc":
        sorted.sort((a, b) => b.title.localeCompare(a.title, "zh-CN"));
        break;
      case "year-asc":
        sorted.sort((a, b) => (a.year || "0000").localeCompare(b.year || "0000"));
        break;
      case "year-desc":
        sorted.sort((a, b) => (b.year || "0000").localeCompare(a.year || "0000"));
        break;
    }
    return sorted;
  }, [papers, query, sortKey, filterYear, filterTag]);

  // unique years for filter dropdown
  const uniqueYears = useMemo(() => {
    const years = new Set(papers.map((p) => p.year).filter(Boolean));
    return [...years].sort((a, b) => b.localeCompare(a));
  }, [papers]);

  /* ── persist / load helpers ─────────────────────────────── */

  const persistState = useCallback((next: ReaderState, quiet = false) => {
    setState(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try {
        await saveState(next);
        if (!quiet) {
          setStatus("Saved");
        }
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      }
    }, 250);
  }, []);

  const refreshLibrary = useCallback(async () => {
    setStatus("Scanning");
    const [library, savedState, allTagsResult] = await Promise.all([
      fetchLibrary(),
      fetchState(),
      fetchTags() as Promise<{ tags: string[] }>
    ]);
    setLibraryRoot(library.root);
    setPapers(library.papers);
    setState({ ...defaultState, ...savedState, settings: { ...defaultState.settings, ...savedState.settings } });
    if (allTagsResult && "tags" in allTagsResult) {
      setAllTags(allTagsResult.tags);
    }
    setStatus("Saved");
  }, []);

  const reloadCurrentDocument = useCallback(
    async (progress?: number) => {
      if (!selectedPaper) {
        return;
      }
      if (typeof progress === "number") {
        setState((current) => ({
          ...current,
          scrollByDocId: { ...current.scrollByDocId, [selectedPaper.id]: progress }
        }));
      }
      setStatus("Opening");
      const [documentResult, annotationStore] = await Promise.all([fetchDocument(selectedPaper.path), fetchAnnotations(selectedPaper.id)]);
      setAnnotations(annotationStore);
      setOpenedDocumentHash(documentResult.hash);
      const iframe = iframeRef.current;
      if (iframe) {
        iframe.srcdoc = buildReaderHtml(documentResult.html);
      }
      setSelectedBlock(null);
      setEditingBlockId(null);
    },
    [selectedPaper]
  );

  /* ── library init ───────────────────────────────────────── */

  useEffect(() => {
    refreshLibrary().catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, [refreshLibrary]);

  /* ── load paper on selection change ─────────────────────── */

  useEffect(() => {
    const paper = selectedPaper;
    if (!paper) {
      return;
    }

    let cancelled = false;
    async function loadPaper() {
      setStatus("Opening");
      setError("");
      const [documentResult, annotationStore, tags, highlightStore] = await Promise.all([
        fetchDocument(paper.path),
        fetchAnnotations(paper.id),
        fetchTags(paper.id) as Promise<string[]>,
        fetchHighlights(paper.id)
      ]);
      if (cancelled) {
        return;
      }
      setAnnotations(annotationStore);
      setDocTags(Array.isArray(tags) ? tags : []);
      setHighlights(highlightStore);
      setOpenedDocumentHash(documentResult.hash);
      const iframe = iframeRef.current;
      if (!iframe) {
        return;
      }
      iframe.srcdoc = buildReaderHtml(documentResult.html);
    }
    loadPaper().catch((loadError) => setError(loadError instanceof Error ? loadError.message : String(loadError)));
    return () => {
      cancelled = true;
    };
  }, [selectedPaper]);

  /* ── iframe load: settings, outline, scroll, click ──────── */

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !selectedPaper) {
      return;
    }

    const onLoad = () => {
      const frameWin = iframe.contentWindow;
      const frameDoc = iframe.contentDocument;
      if (!frameWin || !frameDoc) {
        return;
      }
      applyReaderSettings(frameDoc, state.settings);
      setOutline(parseOutline(frameDoc));
      scrollToProgress(frameWin, state.scrollByDocId[selectedPaper.id] || 0);
      setStatus("Saved");

      /* re-apply pending visual markers after reload */
      applyPendingVisuals(frameDoc);

      /* apply highlights */
      applyHighlightsToDoc(frameDoc, highlights.items);

      const onScroll = () => {
        const progress = getScrollProgress(frameWin);
        const next: ReaderState = {
          ...state,
          currentDocId: selectedPaper.id,
          recentDocIds: [selectedPaper.id, ...state.recentDocIds.filter((id) => id !== selectedPaper.id)].slice(0, 12),
          scrollByDocId: { ...state.scrollByDocId, [selectedPaper.id]: progress },
          lastReadByDocId: { ...state.lastReadByDocId, [selectedPaper.id]: new Date().toISOString() }
        };
        persistState(next, true);
      };
      frameWin.addEventListener("scroll", onScroll, { passive: true });

      const onClick = (event: MouseEvent) => {
        const block = nearestEditableBlock(event.target);
        frameDoc.querySelectorAll('[data-reader-selected="true"]').forEach((item) => item.removeAttribute("data-reader-selected"));
        if (!block || block.closest("script,style,nav#outline,img,math")) {
          setSelectedBlock(null);
          setHighlightPopup(null);
          return;
        }

        const blockId = block.dataset.blockId || "";

        // Edit mode: multi-select with Shift/Ctrl
        if (modeRef.current === "edit") {
          if (event.shiftKey && lastClickedBlockIdRef.current) {
            // Range select
            const allBlocks = Array.from(frameDoc.querySelectorAll<HTMLElement>(editableBlockSelector + '[data-block-id]'));
            const startIdx = allBlocks.findIndex((b) => b.dataset.blockId === lastClickedBlockIdRef.current);
            const endIdx = allBlocks.findIndex((b) => b.dataset.blockId === blockId);
            if (startIdx >= 0 && endIdx >= 0) {
              const lo = Math.min(startIdx, endIdx);
              const hi = Math.max(startIdx, endIdx);
              const rangeIds = allBlocks.slice(lo, hi + 1).map((b) => b.dataset.blockId || "");
              setSelectedBlockIds((prev) => new Set([...prev, ...rangeIds]));
            }
          } else if (event.ctrlKey || event.metaKey) {
            // Toggle individual
            setSelectedBlockIds((prev) => {
              const next = new Set(prev);
              if (next.has(blockId)) next.delete(blockId);
              else next.add(blockId);
              return next;
            });
          } else {
            // Normal click: select this block only for multi-select
            setSelectedBlockIds(new Set([blockId]));
          }
          setLastClickedBlockId(blockId);
          lastClickedBlockIdRef.current = blockId;
        }

        block.setAttribute("data-reader-selected", "true");
        const frameRect = iframe.getBoundingClientRect();
        const rect = block.getBoundingClientRect();
        setSelectedBlock({
          id: blockId,
          tagName: block.tagName.toLowerCase(),
          text: block.textContent || "",
          isTranslation: block.classList.contains("translation"),
          rect: {
            top: Math.max(76, frameRect.top + rect.top - 46),
            left: Math.min(window.innerWidth - 560, Math.max(304, frameRect.left + rect.left)),
            width: rect.width
          }
        });

        // Read mode: hide highlight popup on click (will show on selectionchange)
        if (modeRef.current === "read") {
          setHighlightPopup(null);
        }
      };

      const onPaste = (event: ClipboardEvent) => {
        const active = frameDoc.activeElement;
        if (!active?.matches('[contenteditable="plaintext-only"]')) {
          return;
        }
        event.preventDefault();
        const text = event.clipboardData?.getData("text/plain") || "";
        frameDoc.execCommand("insertText", false, text);
      };

      frameDoc.addEventListener("click", onClick);
      frameDoc.addEventListener("paste", onPaste);

      // Right-click context menu for copy to notes
      const onContextMenu = (event: MouseEvent) => {
        const target = event.target as HTMLElement;
        // Check if we right-clicked on a content block or image
        const blockEl = target.closest<HTMLElement>("p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, img");
        if (!blockEl || blockEl.closest("script,style,nav#outline,math")) return;

        event.preventDefault();
        const blockId = blockEl.dataset.blockId || blockEl.closest("[data-block-id]")?.getAttribute("data-block-id") || "";
        const blockHtml = blockEl.outerHTML;

        // Calculate position relative to the page (not iframe)
        const frameRect = iframe.getBoundingClientRect();
        const x = frameRect.left + event.clientX;
        const y = frameRect.top + event.clientY;

        setIframeContextMenu({ x, y, blockId, docId: "", blockHtml, blockTag: blockEl.tagName.toLowerCase() });
      };
      frameDoc.addEventListener("contextmenu", onContextMenu);

      // Read mode: selectionchange for highlight popup
      const onSelectionChange = () => {
        if (modeRef.current !== "read") return;
        const selection = frameDoc.getSelection();
        const selectedText = selection?.toString().replace(/\s+/g, " ").trim();
        if (!selectedText || selectedText.length < 2) {
          // Don't clear immediately - let the popup handle it
          return;
        }
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const container = range?.startContainer.parentElement;
        const block = container?.closest<HTMLElement>("[data-block-id]");
        if (!block) return;

        const rangeRect = range?.getBoundingClientRect();
        if (!rangeRect) return;

        setHighlightPopup({
          x: rangeRect.left + rangeRect.width / 2,
          y: rangeRect.top - 8,
          blockId: block.dataset.blockId || "",
          text: block.textContent || ""
        });
      };
      frameDoc.addEventListener("selectionchange", onSelectionChange);
    };

    iframe.addEventListener("load", onLoad);
    return () => iframe.removeEventListener("load", onLoad);
  }, [persistState, selectedPaper, state, pendingEdits, highlights]);

  /* ── apply settings on change ───────────────────────────── */

  useEffect(() => {
    const frameDoc = iframeRef.current?.contentDocument;
    if (frameDoc) {
      applyReaderSettings(frameDoc, state.settings);
    }
  }, [state.settings]);

  /* ── pending-edits visual helpers ───────────────────────── */

  function applyPendingVisuals(frameDoc: Document) {
    for (const edit of pendingEdits) {
      const el = frameDoc.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(edit.blockId)}"]`);
      if (!el) continue;
      if (edit.operation === "delete") {
        el.style.opacity = "0.3";
        el.style.borderLeft = "3px solid #e53935";
      } else if (edit.operation === "update") {
        el.style.borderLeft = "3px solid #f9a825";
      }
    }
  }

  /* ── keyboard shortcuts ─────────────────────────────────── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, [contenteditable]")) {
        return;
      }

      /* Ctrl+S → flush pending edits */
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        flushEdits();
        return;
      }

      /* Escape → cancel editing or deselect */
      if (event.key === "Escape") {
        event.preventDefault();
        if (editingBlockId) {
          cancelBlockEdit();
        } else {
          deselectBlock();
        }
        return;
      }

      /* shortcuts only in edit mode */
      if (mode !== "edit") return;

      if (event.key === "x" || event.key === "X") {
        event.preventDefault();
        quickDeleteBlock();
      }
      if (event.key === "e" || event.key === "E") {
        event.preventDefault();
        startBlockEdit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, selectedBlock, selectedPaper, canEditSelectedPaper, editingBlockId, openedDocumentHash, pendingEdits]);

  /* ── panel collapse + notes keyboard shortcuts ─────────── */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, [contenteditable]")) return;

      if (event.key === "[") {
        event.preventDefault();
        toggleLeftPanel();
      }
      if (event.key === "]") {
        event.preventDefault();
        toggleRightPanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [leftCollapsed, rightCollapsed, notesMode]);

  /* ── panel toggle helpers ──────────────────────────────── */

  const toggleLeftPanel = useCallback(() => {
    setLeftCollapsed((prev) => {
      const next = !prev;
      persistState({ ...state, collapsedPanels: { left: next, right: rightCollapsed } }, true);
      return next;
    });
  }, [state, rightCollapsed, persistState]);

  const toggleRightPanel = useCallback(() => {
    setRightCollapsed((prev) => {
      const next = !prev;
      persistState({ ...state, collapsedPanels: { left: leftCollapsed, right: next } }, true);
      return next;
    });
  }, [state, leftCollapsed, persistState]);

  /* ── notes mode toggle ─────────────────────────────────── */

  const toggleNotesMode = useCallback(() => {
    setNotesMode((prev) => {
      const next = !prev;
      persistState({ ...state, notesMode: next }, true);
      if (next && rightCollapsed) {
        setRightCollapsed(false);
        persistState({ ...state, notesMode: next, collapsedPanels: { left: leftCollapsed, right: false } }, true);
      }
      return next;
    });
  }, [state, rightCollapsed, leftCollapsed, persistState]);

  /* ── notes load / save ─────────────────────────────────── */

  useEffect(() => {
    if (!notesMode || !selectedPaper) {
      setNoteContent("");
      return;
    }
    let cancelled = false;
    fetchNote(selectedPaper.id).then((html) => {
      if (!cancelled) setNoteContent(html);
    }).catch(() => {
      if (!cancelled) setNoteContent("");
    });
    return () => { cancelled = true; };
  }, [notesMode, selectedPaper?.id]);

  const saveNoteContent = useCallback(async (content?: string) => {
    if (!selectedPaper) return;
    const html = content ?? noteEditorRef.current?.innerHTML ?? noteContent;
    try {
      await saveNote(selectedPaper.id, html);
      setStatus("笔记已保存");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [selectedPaper, noteContent]);

  /* sync contenteditable when noteContent loads */
  useEffect(() => {
    if (noteEditorRef.current && noteContent !== undefined) {
      if (noteEditorRef.current.innerHTML !== noteContent) {
        noteEditorRef.current.innerHTML = noteContent;
      }
    }
  }, [noteContent]);

  /* ── copy block to notes ───────────────────────────────── */

  const copyToNotes = useCallback((blockHtml: string, docId: string, blockId: string) => {
    if (!notesMode) {
      setNotesMode(true);
      persistState({ ...state, notesMode: true }, true);
      if (rightCollapsed) {
        setRightCollapsed(false);
      }
    }

    const clipHtml = `<div class="note-clip" data-doc-id="${docId}" data-block-id="${blockId}">${blockHtml}</div><a class="note-link" data-doc-id="${docId}" data-block-id="${blockId}">📎 来源</a><p><br></p>`;

    /* wait for editor to mount, then insert */
    setTimeout(() => {
      const editor = noteEditorRef.current;
      if (!editor) return;
      editor.focus();

      // Try to insert at current selection
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && editor.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const frag = document.createRange().createContextualFragment(clipHtml);
        range.insertNode(frag);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        editor.innerHTML += clipHtml;
      }

      // Auto-save after insert
      clearTimeout(noteSaveTimer.current);
      noteSaveTimer.current = window.setTimeout(() => {
        saveNoteContent(editor.innerHTML);
      }, 1000);
    }, 100);
  }, [notesMode, rightCollapsed, state, persistState, saveNoteContent]);

  /* ── mode switching ─────────────────────────────────────── */

  const switchMode = (next: EditorMode) => {
    if (next === mode) return;
    /* leaving edit mode with dirty state → warn */
    if (mode === "edit" && isDirty) {
      if (!window.confirm(`你有 ${pendingEdits.length} 个未保存的更改。切换模式将丢弃这些更改。确定吗？`)) {
        return;
      }
      setPendingEdits([]);
    }
    setMode(next);
    setEditingBlockId(null);
    setSelectedBlock(null);
    /* reload to clear any visual markers */
    if (mode === "edit") {
      reloadCurrentDocument(currentProgress()).catch(() => {});
    }
  };

  /* ── deselect helper ────────────────────────────────────── */

  const deselectBlock = () => {
    const frameDoc = iframeRef.current?.contentDocument;
    if (frameDoc) {
      frameDoc.querySelectorAll('[data-reader-selected="true"]').forEach((item) => item.removeAttribute("data-reader-selected"));
    }
    setSelectedBlock(null);
  };

  /* ── paper selection ────────────────────────────────────── */

  const selectPaper = (paper: PaperSummary) => {
    setDoctorFixPreview(null);
    setPendingEdits([]);
    setMode("browse");
    persistState({
      ...state,
      currentDocId: paper.id,
      recentDocIds: [paper.id, ...state.recentDocIds.filter((id) => id !== paper.id)].slice(0, 12),
      lastReadByDocId: { ...state.lastReadByDocId, [paper.id]: new Date().toISOString() }
    });
  };

  /* ── note link click handler ───────────────────────────── */

  const handleNoteEditorClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains("note-link")) {
      e.preventDefault();
      const docId = target.dataset.docId;
      const blockId = target.dataset.blockId;
      if (docId) {
        const paper = papers.find((p) => p.id === docId);
        if (paper) {
          selectPaper(paper);
          if (blockId) {
            setTimeout(() => {
              const frameDoc = iframeRef.current?.contentDocument;
              const block = frameDoc?.querySelector(`[data-block-id="${blockId}"]`);
              block?.scrollIntoView({ behavior: "smooth", block: "center" });
            }, 500);
          }
        }
      }
    }
  }, [papers, selectPaper]);

  const updateSettings = (settings: Partial<ReaderState["settings"]>) => {
    persistState({
      ...state,
      settings: { ...state.settings, ...settings }
    });
  };

  /* ── annotations ────────────────────────────────────────── */

  const addAnnotation = async () => {
    const frameDoc = iframeRef.current?.contentDocument;
    if (!selectedPaper || !frameDoc) {
      return;
    }
    const item = buildSelectionAnnotation(selectedPaper.id, frameDoc);
    const next = { docId: selectedPaper.id, items: [item, ...annotations.items] };
    setAnnotations(next);
    await saveAnnotations(next);
    setActiveTab("annotations");
    setStatus("Saved");
    await refreshLibrary();
  };

  const updateAnnotationNote = async (id: string, note: string) => {
    const next = {
      ...annotations,
      items: annotations.items.map((item) =>
        item.id === id ? { ...item, note, updatedAt: new Date().toISOString() } : item
      )
    };
    setAnnotations(next);
    await saveAnnotations(next);
    setStatus("Saved");
  };

  /* ── highlights ─────────────────────────────────────────── */

  function applyHighlightsToDoc(frameDoc: Document, items: Highlight[]) {
    // Remove existing highlight marks
    frameDoc.querySelectorAll("mark[data-hl-id]").forEach((el) => {
      const parent = el.parentNode;
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
      }
    });
    // Normalize to merge adjacent text nodes
    frameDoc.body?.normalize();

    const bodyText = frameDoc.body?.innerText || "";
    for (const hl of items) {
      // Find text position in current body
      const idx = bodyText.indexOf(hl.selectedText);
      if (idx < 0) continue;
      // Walk text nodes to find the range
      const range = findTextRange(frameDoc, hl.selectedText, idx);
      if (!range) continue;
      try {
        const mark = frameDoc.createElement("mark");
        mark.dataset.hlId = hl.id;
        mark.style.backgroundColor = HIGHLIGHT_COLORS[hl.color] || "#fef08a";
        mark.style.padding = "1px 2px";
        mark.style.borderRadius = "2px";
        range.surroundContents(mark);
      } catch {
        // Range may span multiple elements, skip complex cases
      }
    }
  }

  function findTextRange(doc: Document, text: string, bodyIndex: number): Range | null {
    const walker = doc.createTreeWalker(doc.body!, NodeFilter.SHOW_TEXT);
    let charCount = 0;
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;

    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const nodeLen = node.textContent?.length || 0;
      if (!startNode && charCount + nodeLen > bodyIndex) {
        startNode = node;
        startOffset = bodyIndex - charCount;
      }
      if (startNode && charCount + nodeLen >= bodyIndex + text.length) {
        endNode = node;
        endOffset = bodyIndex + text.length - charCount;
        break;
      }
      charCount += nodeLen;
    }

    if (!startNode || !endNode) return null;
    const range = doc.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  const addHighlight = async () => {
    const frameDoc = iframeRef.current?.contentDocument;
    if (!selectedPaper || !frameDoc) return;

    const selection = frameDoc.getSelection();
    const selectedText = selection?.toString().replace(/\s+/g, " ").trim();
    if (!selectedText || selectedText.length < 2) return;

    const bodyText = frameDoc.body?.innerText || "";
    const start = bodyText.indexOf(selectedText);
    if (start < 0) return;

    const item: Highlight = {
      id: `hl_${Date.now()}`,
      docId: selectedPaper.id,
      selectedText,
      prefix: bodyText.slice(Math.max(0, start - 40), start),
      suffix: bodyText.slice(start + selectedText.length, start + selectedText.length + 40),
      textPosition: { start, end: start + selectedText.length },
      color: highlightColor,
      note: "",
      createdAt: new Date().toISOString()
    };

    const next = { docId: selectedPaper.id, items: [item, ...highlights.items] };
    setHighlights(next);
    await saveHighlights(next);
    // Apply highlight mark visually
    applyHighlightsToDoc(frameDoc, [item]);
    setStatus("Highlighted");
  };

  const deleteHighlight = async (id: string) => {
    const next = { ...highlights, items: highlights.items.filter((h) => h.id !== id) };
    setHighlights(next);
    await saveHighlights(next);
    // Re-render highlights in iframe
    const frameDoc = iframeRef.current?.contentDocument;
    if (frameDoc) applyHighlightsToDoc(frameDoc, next.items);
    setStatus("Saved");
  };

  /* ── tags ──────────────────────────────────────────────── */

  const addTagToDoc = async (tag: string) => {
    if (!selectedPaper || !tag.trim()) return;
    const trimmed = tag.trim();
    if (docTags.includes(trimmed)) return;
    const next = [...docTags, trimmed].sort();
    setDocTags(next);
    await saveTags(selectedPaper.id, next);
    // update paper in local list
    setPapers((prev) => prev.map((p) => p.id === selectedPaper.id ? { ...p, tags: next } : p));
    // refresh global tag list
    const allResult = await fetchTags() as { tags: string[] };
    if (allResult?.tags) setAllTags(allResult.tags);
    setTagInput("");
    setStatus("Saved");
  };

  const removeTagFromDoc = async (tag: string) => {
    if (!selectedPaper) return;
    const next = docTags.filter((t) => t !== tag);
    setDocTags(next);
    await saveTags(selectedPaper.id, next);
    setPapers((prev) => prev.map((p) => p.id === selectedPaper.id ? { ...p, tags: next } : p));
    setStatus("Saved");
  };

  /* ── outline / scroll ───────────────────────────────────── */

  const jumpToOutline = (id: string) => {
    const target = iframeRef.current?.contentDocument?.getElementById(id);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const currentProgress = () => {
    const frameWin = iframeRef.current?.contentWindow;
    return frameWin ? getScrollProgress(frameWin) : 0;
  };

  /* ── block editing (deferred save) ──────────────────────── */

  const startBlockEdit = () => {
    if (!canEditSelectedPaper) {
      window.alert("Doctor 当前判定该文档不适合写回，请先运行 Doctor 修复。");
      setActiveTab("doctor");
      return;
    }
    if (!selectedBlock) {
      return;
    }
    const block = iframeRef.current?.contentDocument?.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(selectedBlock.id)}"]`
    );
    if (!block) {
      return;
    }
    block.setAttribute("contenteditable", "plaintext-only");
    block.focus();
    setEditingBlockId(selectedBlock.id);
  };

  const cancelBlockEdit = () => {
    /* just reload to revert unsaved contenteditable changes */
    reloadCurrentDocument(currentProgress()).catch((editError) => setError(editError instanceof Error ? editError.message : String(editError)));
    setEditingBlockId(null);
  };

  const saveBlockEdit = async () => {
    if (!selectedPaper || !editingBlockId) {
      return;
    }
    if (!canEditSelectedPaper) {
      window.alert("Doctor 当前判定该文档不适合写回，请先运行 Doctor 修复。");
      setActiveTab("doctor");
      return;
    }
    const block = iframeRef.current?.contentDocument?.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(editingBlockId)}"]`
    );
    if (!block) {
      return;
    }

    if (mode === "edit") {
      /* deferred: add to pending queue */
      const text = block.textContent || "";
      const ctx = editContextFor(selectedPaper);
      /* remove any previous update for the same block */
      const filtered = pendingEdits.filter((e) => !(e.blockId === editingBlockId && e.operation === "update"));
      setPendingEdits([
        ...filtered,
        {
          blockId: editingBlockId,
          operation: "update",
          text,
          filePath: ctx.filePath,
          sourcePath: ctx.sourcePath,
          expectedHash: openedDocumentHash || selectedPaper.hash
        }
      ]);
      /* visual feedback: yellow left border */
      block.style.borderLeft = "3px solid #f9a825";
      block.removeAttribute("contenteditable");
      setEditingBlockId(null);
      setStatus("已编辑 (未保存)");
    } else {
      /* non-edit mode: immediate save (legacy) */
      const progress = currentProgress();
      setStatus("Saving edit");
      await updateBlock({ ...editContextFor(selectedPaper), expectedHash: openedDocumentHash || selectedPaper.hash }, editingBlockId, block.textContent || "");
      await reloadCurrentDocument(progress);
      await refreshLibrary();
      setStatus("Saved");
    }
  };

  /* ── deferred delete ────────────────────────────────────── */

  const removeSelectedBlock = async () => {
    if (!selectedPaper || !selectedBlock) {
      return;
    }
    if (!canEditSelectedPaper) {
      window.alert("Doctor 当前判定该文档不适合写回，请先运行 Doctor 修复。");
      setActiveTab("doctor");
      return;
    }

    if (mode === "edit") {
      /* deferred delete */
      const ctx = editContextFor(selectedPaper);
      const filtered = pendingEdits.filter((e) => !(e.blockId === selectedBlock.id && e.operation === "delete"));
      setPendingEdits([
        ...filtered,
        {
          blockId: selectedBlock.id,
          operation: "delete",
          filePath: ctx.filePath,
          sourcePath: ctx.sourcePath,
          expectedHash: openedDocumentHash || selectedPaper.hash
        }
      ]);
      /* visual: hide the block */
      const el = iframeRef.current?.contentDocument?.querySelector<HTMLElement>(
        `[data-block-id="${CSS.escape(selectedBlock.id)}"]`
      );
      if (el) {
        el.style.opacity = "0.3";
        el.style.borderLeft = "3px solid #e53935";
      }
      setSelectedBlock(null);
      setStatus("已标记删除 (未保存)");
    } else {
      /* legacy immediate delete */
      if (!window.confirm("确认删除当前块？删除前会自动创建 .bak 备份。")) {
        return;
      }
      await doDeleteBlock();
    }
  };

  const doDeleteBlock = async () => {
    if (!selectedPaper || !selectedBlock) {
      return;
    }
    const progress = currentProgress();
    setStatus("Deleting");
    await deleteBlock({ ...editContextFor(selectedPaper), expectedHash: openedDocumentHash || selectedPaper.hash }, selectedBlock.id);
    await reloadCurrentDocument(progress);
    await refreshLibrary();
    setStatus("Saved");
  };

  const quickDeleteBlock = async () => {
    if (!selectedPaper || !selectedBlock || !canEditSelectedPaper || editingBlockId) {
      return;
    }

    if (mode === "edit") {
      /* deferred */
      const ctx = editContextFor(selectedPaper);
      const filtered = pendingEdits.filter((e) => !(e.blockId === selectedBlock.id && e.operation === "delete"));
      setPendingEdits([
        ...filtered,
        {
          blockId: selectedBlock.id,
          operation: "delete",
          filePath: ctx.filePath,
          sourcePath: ctx.sourcePath,
          expectedHash: openedDocumentHash || selectedPaper.hash
        }
      ]);
      const el = iframeRef.current?.contentDocument?.querySelector<HTMLElement>(
        `[data-block-id="${CSS.escape(selectedBlock.id)}"]`
      );
      if (el) {
        el.style.opacity = "0.3";
        el.style.borderLeft = "3px solid #e53935";
      }
      setSelectedBlock(null);
      setStatus("已标记删除 (未保存)");
    } else {
      /* legacy immediate */
      setStatus("Deleting");
      await deleteBlock({ ...editContextFor(selectedPaper), expectedHash: openedDocumentHash || selectedPaper.hash }, selectedBlock.id);
      await reloadCurrentDocument(currentProgress());
      await refreshLibrary();
      setStatus("Deleted — click next block or press X again");
    }
  };

  /* ── flush / cancel pending edits ───────────────────────── */

  const flushEdits = async () => {
    if (!selectedPaper || pendingEdits.length === 0) {
      return;
    }
    try {
      setStatus(`保存中 (${pendingEdits.length} 项)…`);
      const result = await batchEdit(selectedPaper.path, pendingEdits);
      setPendingEdits([]);
      if (result.failed > 0) {
        setError(`批量保存部分失败：${result.errors.join("; ")}`);
      }
      await reloadCurrentDocument(currentProgress());
      await refreshLibrary();
      setStatus(`已保存 (${result.applied} 项)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelAllEdits = () => {
    if (!isDirty) return;
    if (!window.confirm(`丢弃 ${pendingEdits.length} 个未保存的更改？`)) return;
    setPendingEdits([]);
    reloadCurrentDocument(currentProgress()).catch(() => {});
    setStatus("已取消");
  };

  /* ── insert near block (deferred in edit mode) ──────────── */

  const insertNearSelectedBlock = async (operation: "insertBefore" | "insertAfter", insertKind: InsertKind) => {
    if (!selectedPaper || !selectedBlock) {
      return;
    }
    if (!canEditSelectedPaper) {
      window.alert("Doctor 当前判定该文档不适合写回，请先运行 Doctor 修复。");
      setActiveTab("doctor");
      return;
    }
    const defaultText = insertKind === "translation" ? "新译文段落" : insertKind === "note" ? "我的笔记" : insertKind === "heading" ? "新小标题" : "新段落";
    const text = window.prompt("请输入要插入的纯文本内容：", defaultText);
    if (text === null) {
      return;
    }

    if (mode === "edit") {
      const ctx = editContextFor(selectedPaper);
      setPendingEdits([
        ...pendingEdits,
        {
          blockId: selectedBlock.id,
          operation,
          text,
          filePath: ctx.filePath,
          sourcePath: ctx.sourcePath,
          expectedHash: openedDocumentHash || selectedPaper.hash,
          insertKind
        }
      ]);
      setStatus("已添加插入 (未保存)");
    } else {
      const progress = currentProgress();
      setStatus("Inserting");
      await insertBlock({ ...editContextFor(selectedPaper), expectedHash: openedDocumentHash || selectedPaper.hash }, selectedBlock.id, operation, insertKind, text);
      await reloadCurrentDocument(progress);
      await refreshLibrary();
      setStatus("Saved");
    }
  };

  /* ── copy ───────────────────────────────────────────────── */

  const copySelectedBlock = async () => {
    if (!selectedBlock) {
      return;
    }
    await navigator.clipboard.writeText(selectedBlock.text);
    setStatus("Copied");
  };

  /* ── selection operations (always immediate) ────────────── */

  const applySelectionOperation = async (operation: "selectionDelete" | "selectionReplace" | "selectionInsertAfter") => {
    if (!selectedPaper) {
      return;
    }
    if (!canEditSelectedPaper) {
      window.alert("Doctor 当前判定该文档不适合写回，请先运行 Doctor 修复。");
      setActiveTab("doctor");
      return;
    }
    const frameDoc = iframeRef.current?.contentDocument;
    if (!frameDoc) {
      return;
    }
    const selection = blockFromSelection(frameDoc);
    if ("error" in selection) {
      window.alert(selection.error);
      return;
    }
    let text = "";
    if (operation === "selectionReplace") {
      const replacement = window.prompt("替换为纯文本：", selection.selectedText);
      if (replacement === null) {
        return;
      }
      text = replacement;
    }
    if (operation === "selectionInsertAfter") {
      const inserted = window.prompt("在选区后插入纯文本：", "");
      if (inserted === null) {
        return;
      }
      text = inserted;
    }
    const progress = currentProgress();
    setStatus("Saving selection");
    await editSelection({ ...editContextFor(selectedPaper), expectedHash: openedDocumentHash || selectedPaper.hash }, selection.blockId, operation, selection.start, selection.end, text);
    await reloadCurrentDocument(progress);
    await refreshLibrary();
    setStatus("Saved");
  };

  /* ── undo (server-side, always available) ───────────────── */

  const undoEdit = async () => {
    const progress = currentProgress();
    setStatus("Undoing");
    try {
      await undoLastEdit();
      await reloadCurrentDocument(progress);
      await refreshLibrary();
      setStatus("Saved");
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : String(undoError));
    }
  };

  /* ── doctor ─────────────────────────────────────────────── */

  const previewFixes = async () => {
    if (!selectedPaper) {
      return;
    }
    setStatus("Previewing fixes");
    try {
      const result = await previewDoctorFix(selectedPaper.id);
      setDoctorFixPreview(result);
      setStatus("Preview ready");
    } catch (fixError) {
      setError(fixError instanceof Error ? fixError.message : String(fixError));
    }
  };

  const applyFixes = async () => {
    if (!selectedPaper) {
      return;
    }
    if (!window.confirm("确认应用 Doctor 自动修复？写回前会创建 .bak 备份。")) {
      return;
    }
    const progress = currentProgress();
    setStatus("Applying fixes");
    try {
      const result = await applyDoctorFix(selectedPaper.id);
      setDoctorFixPreview(result);
      await reloadCurrentDocument(progress);
      await refreshLibrary();
      setStatus("Saved");
    } catch (fixError) {
      setError(fixError instanceof Error ? fixError.message : String(fixError));
    }
  };

  const openBackupFolder = async () => {
    try {
      await openDoctorBackupFolder();
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError));
    }
  };

  /* ── rename ─────────────────────────────────────────────── */

  const renamePaper = async (paper: PaperSummary, event: ReactMouseEvent) => {
    event.stopPropagation();
    const nextTitle = window.prompt("输入新的左侧显示标题，会写入该 HTML 的 reader-title 与 title：", paper.title);
    if (nextTitle === null) {
      return;
    }
    const trimmed = nextTitle.replace(/\s+/g, " ").trim();
    if (!trimmed || trimmed === paper.title) {
      return;
    }
    setStatus("Renaming");
    try {
      const result = await renameDocument(paper.id, trimmed, paper.id === selectedPaper?.id ? openedDocumentHash || paper.hash : paper.hash);
      if (paper.id === selectedPaper?.id) {
        setOpenedDocumentHash(result.hash);
      }
      await refreshLibrary();
      setStatus("Saved");
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    }
  };

  /* ── column divider drag handlers ─────────────────────── */

  const leftWidth = state.panelWidths?.left ?? 300;
  const rightWidth = state.panelWidths?.right ?? 330;

  const handleDividerMouseDown = (which: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingDivider(which);
    dragStartRef.current = { startX: e.clientX, startLeft: leftWidth, startRight: rightWidth };
  };

  useEffect(() => {
    if (!isDraggingDivider) return;
    const onMouseMove = (e: MouseEvent) => {
      const { startX, startLeft, startRight } = dragStartRef.current;
      const dx = e.clientX - startX;
      if (isDraggingDivider === "left") {
        const newLeft = Math.max(180, Math.min(600, startLeft + dx));
        persistState({ ...state, panelWidths: { left: newLeft, right: rightWidth } }, true);
      } else {
        const newRight = Math.max(200, Math.min(600, startRight - dx));
        persistState({ ...state, panelWidths: { left: leftWidth, right: newRight } }, true);
      }
    };
    const onMouseUp = () => {
      setIsDraggingDivider(null);
      // Final save
      saveState(state).catch(() => {});
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDraggingDivider, state, leftWidth, rightWidth, persistState]);

  /* ── context menu handlers ───────────────────────────── */

  const handleContextMenu = (paper: PaperSummary, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, paper });
  };

  const closeContextMenu = () => setContextMenu(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => closeContextMenu();
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [contextMenu]);

  /* close iframe context menu on outside click */
  useEffect(() => {
    if (!iframeContextMenu) return;
    const handler = () => setIframeContextMenu(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [iframeContextMenu]);

  const contextRename = async () => {
    if (!contextMenu) return;
    closeContextMenu();
    await renamePaper(contextMenu.paper, { stopPropagation: () => {} } as ReactMouseEvent);
  };

  const contextDelete = async () => {
    if (!contextMenu) return;
    const paper = contextMenu.paper;
    closeContextMenu();
    if (!window.confirm(`确认删除 "${paper.title}" 及其所有备份文件？此操作不可撤销。`)) return;
    try {
      setStatus("Deleting...");
      await deleteDocument(paper.id);
      if (selectedPaper?.id === paper.id) {
        persistState({ ...state, currentDocId: undefined });
      }
      await refreshLibrary();
      setStatus("Deleted");
    } catch (delErr) {
      setError(delErr instanceof Error ? delErr.message : String(delErr));
    }
  };

  const contextOpenFolder = async () => {
    if (!contextMenu) return;
    const paper = contextMenu.paper;
    closeContextMenu();
    try {
      await openDocumentFolder(paper.id);
    } catch (folderErr) {
      setError(folderErr instanceof Error ? folderErr.message : String(folderErr));
    }
  };

  /* ── batch delete (edit mode multi-select) ───────────── */

  const batchDeleteSelected = async () => {
    if (!selectedPaper || selectedBlockIds.size === 0) return;
    if (!canEditSelectedPaper) {
      window.alert("Doctor 当前判定该文档不适合写回，请先运行 Doctor 修复。");
      setActiveTab("doctor");
      return;
    }
    const ctx = editContextFor(selectedPaper);
    const ids = [...selectedBlockIds];
    if (mode === "edit") {
      // Deferred: add all to pending edits
      const newEdits = ids.map((id) => ({
        blockId: id,
        operation: "delete" as const,
        filePath: ctx.filePath,
        sourcePath: ctx.sourcePath,
        expectedHash: openedDocumentHash || selectedPaper.hash
      }));
      // Remove any existing deletes for same blocks
      const filtered = pendingEdits.filter((e) => !(e.operation === "delete" && ids.includes(e.blockId)));
      setPendingEdits([...filtered, ...newEdits]);
      // Visual feedback
      const frameDoc = iframeRef.current?.contentDocument;
      if (frameDoc) {
        for (const id of ids) {
          const el = frameDoc.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
          if (el) {
            el.style.opacity = "0.3";
            el.style.borderLeft = "3px solid #e53935";
          }
        }
      }
      setSelectedBlockIds(new Set());
      setSelectedBlock(null);
      setStatus(`已标记 ${ids.length} 个段落删除 (未保存)`);
    }
  };

  /* ── highlight popup handler (read mode) ─────────────── */

  const applyParagraphHighlight = async (color: HighlightColor) => {
    if (!highlightPopup || !selectedPaper) return;
    const frameDoc = iframeRef.current?.contentDocument;
    if (!frameDoc) return;

    const text = highlightPopup.text;
    if (!text) return;

    const bodyText = frameDoc.body?.innerText || "";
    const start = bodyText.indexOf(text);
    if (start < 0) return;

    const item: Highlight = {
      id: `hl_${Date.now()}`,
      docId: selectedPaper.id,
      selectedText: text,
      prefix: bodyText.slice(Math.max(0, start - 40), start),
      suffix: bodyText.slice(start + text.length, start + text.length + 40),
      textPosition: { start, end: start + text.length },
      color,
      note: "",
      createdAt: new Date().toISOString()
    };

    const next = { docId: selectedPaper.id, items: [item, ...highlights.items] };
    setHighlights(next);
    await saveHighlights(next);
    applyHighlightsToDoc(frameDoc, [item]);
    setHighlightPopup(null);
    setStatus("Highlighted");
  };
  /* ── render ─────────────────────────────────────────────── */

  return (
    <main
      className="app-shell"
      style={{
        gridTemplateColumns: `${leftCollapsed ? 4 : leftWidth}px ${leftCollapsed ? "0" : "6px"} minmax(520px, 1fr) ${rightCollapsed ? "0" : "6px"} ${rightCollapsed ? 4 : rightWidth}px`,
        cursor: isDraggingDivider ? "col-resize" : undefined,
        userSelect: isDraggingDivider ? "none" : undefined
      }}
    >
      {/* ─── left: library panel ─────────────────────────── */}
      {leftCollapsed ? (
        <aside className="library-panel collapsed-strip" onClick={toggleLeftPanel} title="展开左面板 ([)">
          <ChevronRight size={16} />
        </aside>
      ) : (
        <aside className="library-panel">
        <div className="brand-row">
          <div className="brand-mark">
            <BookOpen size={19} />
          </div>
          <div>
            <h1>Paper HTML Reader</h1>
            <p>{papers.length || "..."} local HTML papers</p>
          </div>
        </div>

        <label className="search-box">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, file, year" />
        </label>

        {/* ── sort / filter bar ── */}
        <div className="sort-filter-bar">
          <div className="sort-buttons">
            <button className={sortKey === "year-desc" ? "active" : ""} onClick={() => setSortKey("year-desc")} title="年份降序">年↓</button>
            <button className={sortKey === "year-asc" ? "active" : ""} onClick={() => setSortKey("year-asc")} title="年份升序">年↑</button>
            <button className={sortKey === "title-asc" ? "active" : ""} onClick={() => setSortKey("title-asc")} title="标题A→Z">
              <ArrowDownAZ size={14} />
            </button>
            <button className={sortKey === "title-desc" ? "active" : ""} onClick={() => setSortKey("title-desc")} title="标题Z→A">
              <ArrowUpAZ size={14} />
            </button>
          </div>
          <button className={`filter-toggle ${showFilterPanel ? "active" : ""}`} onClick={() => setShowFilterPanel(!showFilterPanel)}>
            <Filter size={14} />
            {(filterYear || filterTag) && <span className="filter-dot" />}
          </button>
        </div>

        {showFilterPanel && (
          <div className="filter-panel">
            <label>
              年份
              <select value={filterYear} onChange={(e) => setFilterYear(e.target.value)}>
                <option value="">全部</option>
                {uniqueYears.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            <label>
              标签
              <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)}>
                <option value="">全部</option>
                {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            {(filterYear || filterTag) && (
              <button className="clear-filter" onClick={() => { setFilterYear(""); setFilterTag(""); }}>清除筛选</button>
            )}
          </div>
        )}

        <div className="library-meta">
          <span title={libraryRoot}>{libraryRoot || "F:/wiki/paper/pro"}</span>
          <span className="paper-count">{filteredPapers.length}/{papers.length}</span>
          <button className="icon-button" onClick={() => refreshLibrary()} title="Rescan library">
            <RefreshCw size={15} />
          </button>
        </div>

        <div className="paper-list">
          {filteredPapers.map((paper) => (
            <div
              className={`paper-row ${paper.id === selectedPaper?.id ? "selected" : ""}`}
              key={paper.id}
              onClick={() => selectPaper(paper)}
              onContextMenu={(e) => handleContextMenu(paper, e)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  selectPaper(paper);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span className="paper-title-row">
                <span className="paper-title">{paper.title}</span>
              </span>
              <span className="paper-subline">
                <FileText size={13} />
                {paper.year || "----"} | {formatBytes(paper.size)} | {paper.progress}%
              </span>
              {paper.tags && paper.tags.length > 0 && (
                <span className="paper-tags">
                  {paper.tags.map((t) => (
                    <span key={t} className="tag-chip" onClick={(e) => { e.stopPropagation(); setFilterTag(t); setShowFilterPanel(true); }}>{t}</span>
                  ))}
                </span>
              )}
              <span className="progress-track">
                <span style={{ width: `${paper.progress}%` }} />
              </span>
            </div>
          ))}
        </div>
      </aside>
      )}

      {/* ─── left divider ────────────────────────────────── */}
      {!leftCollapsed && (
        <div
          className={`column-divider ${isDraggingDivider === "left" ? "active" : ""}`}
          onMouseDown={handleDividerMouseDown("left")}
        >
          <button className="collapse-btn" onClick={toggleLeftPanel} title="收起左面板 ([)">
            <PanelLeftClose size={14} />
          </button>
        </div>
      )}

      {/* ─── center: reader column ───────────────────────── */}
      <section className="reader-column">
        <header className="reader-toolbar">
          {/* left: title */}
          <div className="doc-title-block">
            <span className="doc-title">{selectedPaper?.title || "No paper selected"}</span>
            <span className="doc-path">{selectedPaper?.fileName || ""}</span>
          </div>

          {/* right: mode tabs + mode-specific controls */}
          <div className="toolbar-controls">
            {/* mode tabs */}
            <div className="segmented mode-tabs" aria-label="Editor mode">
              <button className={mode === "browse" ? "active" : ""} onClick={() => switchMode("browse")}>浏览</button>
              <button className={mode === "read" ? "active" : ""} onClick={() => switchMode("read")}>阅读</button>
              <button className={mode === "edit" ? "active" : ""} onClick={() => switchMode("edit")}>编辑</button>
            </div>

            {/* ── BROWSE mode controls ─────────────────────── */}
            {mode === "browse" && (
              <>
                <DisplayModeDropdown
                  value={state.settings.displayMode}
                  onChange={(m) => updateSettings({ displayMode: m })}
                />
                <label className="number-control" title="Font size">
                  <Type size={15} />
                  <input
                    min={13}
                    max={22}
                    type="number"
                    value={state.settings.fontSize}
                    onChange={(event) => updateSettings({ fontSize: Number(event.target.value) })}
                  />
                </label>
                <label className="number-control" title="Line height">
                  <SlidersHorizontal size={15} />
                  <input
                    min={1.25}
                    max={2.1}
                    step={0.05}
                    type="number"
                    value={state.settings.lineHeight}
                    onChange={(event) => updateSettings({ lineHeight: Number(event.target.value) })}
                  />
                </label>
              </>
            )}

            {/* ── READ mode controls ───────────────────────── */}
            {mode === "read" && (
              <>
                <button className="tool-button" onClick={addAnnotation}>
                  <MessageSquarePlus size={16} />
                  Add note
                </button>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8, borderLeft: "1px solid #ddd", paddingLeft: 8 }}>
                  <span style={{ fontSize: 12, color: "#888" }}>Highlight:</span>
                  {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
                    <button
                      key={c}
                      onClick={() => setHighlightColor(c)}
                      style={{
                        width: 18, height: 18, borderRadius: 3,
                        background: HIGHLIGHT_COLORS[c],
                        border: highlightColor === c ? "2px solid #333" : "1px solid #ccc",
                        cursor: "pointer"
                      }}
                      title={c}
                    />
                  ))}
                  <button className="tool-button" onClick={addHighlight} style={{ marginLeft: 4 }}>
                    <Highlighter size={16} />
                    高亮
                  </button>
                </div>
                <button className="ghost-tool-button" onClick={undoEdit}>
                  <Undo2 size={15} />
                  Undo
                </button>
              </>
            )}

            {/* ── EDIT mode controls ───────────────────────── */}
            {mode === "edit" && (
              <>
                <button
                  className={`tool-button save-button ${isDirty ? "save-dirty" : ""}`}
                  disabled={!isDirty}
                  onClick={flushEdits}
                  title="保存所有更改 (Ctrl+S)"
                >
                  <Save size={15} />
                  保存 (Ctrl+S)
                  {isDirty && <span className="dirty-dot" />}
                </button>
                <button className="ghost-tool-button" onClick={undoEdit} title="撤销服务器端上次编辑">
                  <Undo2 size={15} />
                  Undo
                </button>
                {isDirty && (
                  <button className="ghost-tool-button" onClick={cancelAllEdits} title="丢弃所有未保存更改">
                    <X size={15} />
                    丢弃
                  </button>
                )}
                {/* selection operations */}
                <button
                  className="ghost-tool-button"
                  disabled={!canEditSelectedPaper}
                  onClick={() => applySelectionOperation("selectionDelete")}
                >
                  <Trash2 size={15} />
                  删选区
                </button>
                <button
                  className="ghost-tool-button"
                  disabled={!canEditSelectedPaper}
                  onClick={() => applySelectionOperation("selectionReplace")}
                >
                  <Edit3 size={15} />
                  替换
                </button>
                <button
                  className="ghost-tool-button"
                  disabled={!canEditSelectedPaper}
                  onClick={() => applySelectionOperation("selectionInsertAfter")}
                >
                  <Plus size={15} />
                  插入选区后
                </button>
              </>
            )}

            {/* notes toggle button (all modes) */}
            <button
              className={`tool-button ${notesMode ? "active" : ""}`}
              onClick={toggleNotesMode}
              title="切换笔记面板 (Notes)"
              style={notesMode ? { background: "#dbeafe", color: "#1d4ed8", borderColor: "#93c5fd" } : {}}
            >
              <StickyNote size={16} />
              笔记
            </button>

            {/* status indicator (all modes) */}
            <span className={`save-state ${isDirty ? "save-state-dirty" : ""}`}>
              <Check size={14} />
              {isDirty ? `${pendingEdits.length} 个未保存更改` : status}
            </span>
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="reader-frame-wrap">
          <iframe ref={iframeRef} title="Paper reading area" sandbox="allow-same-origin" />

          {/* ── block toolbar popup (edit mode only) ──────── */}
          {selectedBlock && mode === "edit" ? (
            <div className="block-toolbar" style={{ top: selectedBlock.rect.top, left: selectedBlock.rect.left }}>
              <span className="block-chip">
                {selectedBlock.tagName}
                {selectedBlock.isTranslation ? " .translation" : ""}
              </span>
              {editingBlockId === selectedBlock.id ? (
                <>
                  <button onClick={saveBlockEdit}>
                    <Save size={14} />
                    Save
                  </button>
                  <button onClick={cancelBlockEdit}>
                    <X size={14} />
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button disabled={!canEditSelectedPaper} onClick={startBlockEdit} title="编辑此块 (E)">
                    <Edit3 size={14} />
                    Edit <kbd>E</kbd>
                  </button>
                  <button disabled={!canEditSelectedPaper} onClick={removeSelectedBlock} title="删除此块 (X)">
                    <Trash2 size={14} />
                    Del <kbd>X</kbd>
                  </button>
                  <button disabled={!canEditSelectedPaper} onClick={() => insertNearSelectedBlock("insertBefore", "paragraph")}>
                    <Plus size={14} />
                    P before
                  </button>
                  <button disabled={!canEditSelectedPaper} onClick={() => insertNearSelectedBlock("insertAfter", "paragraph")}>
                    <Plus size={14} />
                    P after
                  </button>
                  <button disabled={!canEditSelectedPaper} onClick={() => insertNearSelectedBlock("insertAfter", "translation")}>
                    <Plus size={14} />
                    Translation
                  </button>
                  <button disabled={!canEditSelectedPaper} onClick={() => insertNearSelectedBlock("insertAfter", "note")}>
                    <Plus size={14} />
                    Note
                  </button>
                  <button disabled={!canEditSelectedPaper} onClick={() => insertNearSelectedBlock("insertAfter", "heading")}>
                    <Plus size={14} />
                    H3
                  </button>
                  <button onClick={copySelectedBlock}>
                    <Copy size={14} />
                    Copy
                  </button>
                </>
              )}
            </div>
          ) : null}

          {/* ── read mode: annotation quick-add on click ──── */}
          {selectedBlock && mode === "read" ? (
            <div className="block-toolbar" style={{ top: selectedBlock.rect.top, left: selectedBlock.rect.left }}>
              <span className="block-chip">
                {selectedBlock.tagName}
                {selectedBlock.isTranslation ? " .translation" : ""}
              </span>
              <button onClick={addAnnotation}>
                <MessageSquarePlus size={14} />
                Add note
              </button>
              <button onClick={copySelectedBlock}>
                <Copy size={14} />
                Copy
              </button>
            </div>
          ) : null}
        </div>
      </section>

      {/* ─── right divider ───────────────────────────────── */}
      {!rightCollapsed && (
        <div
          className={`column-divider ${isDraggingDivider === "right" ? "active" : ""}`}
          onMouseDown={handleDividerMouseDown("right")}
        >
          <button className="collapse-btn" onClick={toggleRightPanel} title="收起右面板 (])">
            <PanelRightClose size={14} />
          </button>
        </div>
      )}

      {/* ─── right panel ──────────────────────────────────── */}
      {rightCollapsed ? (
        <aside className="inspector-panel collapsed-strip" onClick={toggleRightPanel} title="展开右面板 (])">
          <ChevronLeft size={16} />
        </aside>
      ) : notesMode ? (
        <aside className="inspector-panel notes-panel">
          <div className="notes-toolbar">
            <button className="note-tool-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("bold"); }} title="粗体"><Bold size={14} /></button>
            <button className="note-tool-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("italic"); }} title="斜体"><Italic size={14} /></button>
            <button className="note-tool-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("formatBlock", false, "h2"); }} title="标题2"><Heading2 size={14} /></button>
            <button className="note-tool-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("formatBlock", false, "h3"); }} title="标题3"><Heading3 size={14} /></button>
            <button className="note-tool-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertUnorderedList"); }} title="无序列表"><List size={14} /></button>
            <button className="note-tool-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertOrderedList"); }} title="有序列表"><ListOrdered size={14} /></button>
            <button className="note-tool-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("formatBlock", false, "pre"); }} title="代码块"><Code2 size={14} /></button>
            <div style={{ flex: 1 }} />
            <span className="note-file-label">{selectedPaper?.id || "未选择论文"}</span>
            <button className="note-tool-btn" onClick={() => saveNoteContent()} title="保存笔记 (Ctrl+S)"><Save size={14} /></button>
          </div>
          <div
            ref={noteEditorRef}
            className="note-editor"
            contentEditable
            suppressContentEditableWarning
            onBlur={() => {
              clearTimeout(noteSaveTimer.current);
              noteSaveTimer.current = window.setTimeout(() => {
                if (noteEditorRef.current && selectedPaper) {
                  saveNoteContent(noteEditorRef.current.innerHTML);
                }
              }, 300);
            }}
            onClick={handleNoteEditorClick}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                if (noteEditorRef.current && selectedPaper) {
                  saveNoteContent(noteEditorRef.current.innerHTML);
                }
              }
            }}
          />
        </aside>
      ) : (
        <aside className="inspector-panel">
        <div className="tabs">
          <button className={activeTab === "outline" ? "active" : ""} onClick={() => setActiveTab("outline")}>
            <ListTree size={16} />
            Outline
          </button>
          <button className={activeTab === "annotations" ? "active" : ""} onClick={() => setActiveTab("annotations")}>
            <StickyNote size={16} />
            Annotations
          </button>
          <button className={activeTab === "highlights" ? "active" : ""} onClick={() => setActiveTab("highlights")}>
            <Highlighter size={16} />
            高亮
          </button>
          <button className={activeTab === "tags" ? "active" : ""} onClick={() => setActiveTab("tags")}>
            <Tag size={16} />
            Tags
          </button>
          <button className={activeTab === "doctor" ? "active" : ""} onClick={() => setActiveTab("doctor")}>
            <Wrench size={16} />
            Doctor
          </button>
        </div>

        {activeTab === "outline" ? (
          <div className="outline-list">
            {outline.length ? (
              outline.map((item) => (
                <button
                  className="outline-item"
                  data-level={Math.min(item.level, 4)}
                  key={`${item.id}-${item.text}`}
                  onClick={() => jumpToOutline(item.id)}
                >
                  {item.text}
                </button>
              ))
            ) : (
              <p className="empty-panel">Open a paper to extract its outline.</p>
            )}
          </div>
        ) : activeTab === "annotations" ? (
          <div className="annotation-list">
            {annotations.items.length ? (
              annotations.items.map((item) => (
                <article className="annotation-card" key={item.id}>
                  <blockquote>{item.selectedText}</blockquote>
                  <textarea
                    value={item.note}
                    onChange={(event) => updateAnnotationNote(item.id, event.target.value)}
                    placeholder="Add your note..."
                  />
                  <div className="annotation-meta">
                    <span>{item.type}</span>
                    <span>{formatDate(item.createdAt)}</span>
                  </div>
                </article>
              ))
            ) : (
              <p className="empty-panel">Select text in the paper, then press Add note to create sidecar annotation data.</p>
            )}
          </div>
        ) : activeTab === "highlights" ? (
          <div className="annotation-list">
            {highlights.items.length ? (
              highlights.items.map((item) => (
                <article className="annotation-card" key={item.id} style={{ borderLeft: `4px solid ${HIGHLIGHT_COLORS[item.color]}` }}>
                  <blockquote style={{ background: `${HIGHLIGHT_COLORS[item.color]}40`, padding: "4px 8px", borderRadius: 4 }}>{item.selectedText}</blockquote>
                  <textarea
                    value={item.note}
                    onChange={(event) => {
                      const next = { ...highlights, items: highlights.items.map((h) => h.id === item.id ? { ...h, note: event.target.value } : h) };
                      setHighlights(next);
                      saveHighlights(next);
                    }}
                    placeholder="Add note..."
                  />
                  <div className="annotation-meta">
                    <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: 2, background: HIGHLIGHT_COLORS[item.color], marginRight: 4 }} />
                    <span>{item.color}</span>
                    <span>{formatDate(item.createdAt)}</span>
                    <button className="ghost-tool-button" onClick={() => deleteHighlight(item.id)} style={{ marginLeft: "auto" }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <p className="empty-panel">Select text in read mode, choose a color, then click 高亮 to highlight.</p>
            )}
          </div>
        ) : activeTab === "tags" ? (
          <div className="tags-panel">
            {selectedPaper ? (
              <>
                <div className="tag-editor">
                  <div className="tag-input-row">
                    <input
                      className="tag-input"
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && tagInput.trim()) {
                          addTagToDoc(tagInput);
                        }
                      }}
                      placeholder="输入标签，回车添加"
                      list="tag-suggestions"
                    />
                    <datalist id="tag-suggestions">
                      {allTags.filter((t) => !docTags.includes(t)).map((t) => <option key={t} value={t} />)}
                    </datalist>
                    <button className="icon-button" onClick={() => addTagToDoc(tagInput)} disabled={!tagInput.trim()}>
                      <Plus size={15} />
                    </button>
                  </div>
                </div>
                <div className="tag-list">
                  {docTags.length ? docTags.map((t) => (
                    <span key={t} className="tag-chip tag-removable">
                      {t}
                      <button onClick={() => removeTagFromDoc(t)} title={`移除 ${t}`}>
                        <X size={12} />
                      </button>
                    </span>
                  )) : (
                    <p className="empty-panel">暂无标签。输入标签名添加。</p>
                  )}
                </div>
                {allTags.length > 0 && (
                  <div className="all-tags-section">
                    <h4>所有标签（点击快速添加）</h4>
                    <div className="tag-list">
                      {allTags.filter((t) => !docTags.includes(t)).map((t) => (
                        <span key={t} className="tag-chip tag-clickable" onClick={() => addTagToDoc(t)}>{t}</span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="empty-panel">打开一篇论文来管理标签。</p>
            )}
          </div>
        ) : (
          <div className="doctor-panel">
            {selectedPaper ? (
              <>
                <section className={`doctor-summary ${selectedPaper.health.status}`}>
                  <div>
                    <span className="doctor-label">{healthBadge(selectedPaper.health.status)}</span>
                    <strong>{selectedPaper.health.score}/100</strong>
                  </div>
                  <p>
                    {selectedPaper.health.status === "error" || selectedPaper.health.status === "readonly"
                      ? "安全编辑已暂停，请先预览并应用低风险修复。"
                      : "当前文档允许安全编辑，保存前仍会执行 preflight。"}
                  </p>
                </section>
                <div className="doctor-actions">
                  <button className="ghost-tool-button" onClick={previewFixes}>
                    <Wrench size={15} />
                    Preview Fix
                  </button>
                  <button className="tool-button" onClick={applyFixes}>
                    <Check size={15} />
                    Apply Fix
                  </button>
                  <button className="ghost-tool-button" onClick={openBackupFolder}>
                    <FolderOpen size={15} />
                    Open Backup Folder
                  </button>
                </div>
                <div className="doctor-issues">
                  {selectedPaper.health.issues.length ? (
                    selectedPaper.health.issues.map((issue) => (
                      <article className={`doctor-issue ${issue.severity}`} key={`${issue.code}-${issue.message}`}>
                        <header>
                          <strong>{issue.code}</strong>
                          <span>{issue.severity}</span>
                        </header>
                        <p>{issue.message}</p>
                        <small>{issue.suggestion}</small>
                        {issue.autoFixable ? <em>Auto fixable</em> : null}
                      </article>
                    ))
                  ) : (
                    <p className="empty-panel">Doctor did not find structural issues.</p>
                  )}
                </div>
                {doctorFixPreview ? (
                  <section className="doctor-preview">
                    <h2>{doctorFixPreview.dryRun ? "Dry-run diff" : "Applied fixes"}</h2>
                    <p>{doctorFixPreview.fixes.length ? doctorFixPreview.fixes.join(" · ") : "No low-risk fixes available."}</p>
                    {doctorFixPreview.diff ? <pre>{doctorFixPreview.diff}</pre> : null}
                  </section>
                ) : null}
              </>
            ) : (
              <p className="empty-panel">Open a paper to inspect its HTML health.</p>
            )}
          </div>
        )}
      </aside>
      )}

      {/* ─── context menu overlay ──────────────────────── */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button onClick={() => { contextRename(); setContextMenu(null); }}>
            <Edit3 size={14} /> 重命名
          </button>
          <button onClick={() => { contextOpenFolder(); setContextMenu(null); }}>
            <FolderOpen size={14} /> 打开文件夹
          </button>
          <div className="context-menu-sep" />
          <button className="danger" onClick={() => { contextDelete(); setContextMenu(null); }}>
            <Trash2 size={14} /> 删除（含备份）
          </button>
        </div>
      )}

      {/* ─── highlight popup overlay ────────────────────── */}
      {highlightPopup && mode === "read" && (
        <div
          className="highlight-popup"
          style={{ left: highlightPopup.x, top: highlightPopup.y }}
        >
          {(Object.keys(HIGHLIGHT_COLORS) as HighlightColor[]).map((c) => (
            <button
              key={c}
              className="highlight-swatch"
              style={{ background: HIGHLIGHT_COLORS[c] }}
              onClick={() => applyParagraphHighlight(c)}
              title={c}
            />
          ))}
          <button className="highlight-close" onClick={() => setHighlightPopup(null)}>
            <X size={12} />
          </button>
        </div>
      )}

      {/* ─── batch delete floating button ───────────────── */}
      {mode === "edit" && selectedBlockIds.size > 1 && (
        <div className="batch-delete-bar">
          <span>已选 {selectedBlockIds.size} 段</span>
          <button className="batch-delete-btn" onClick={batchDeleteSelected}>
            <Trash2 size={14} /> 删除选中
          </button>
          <button className="batch-clear-btn" onClick={() => setSelectedBlockIds(new Set())}>
            取消
          </button>
        </div>
      )}

      {/* ─── iframe context menu (copy to notes) ────────── */}
      {iframeContextMenu && (
        <div
          className="context-menu"
          style={{ left: iframeContextMenu.x, top: iframeContextMenu.y }}
        >
          <button onClick={() => {
            copyToNotes(iframeContextMenu.blockHtml, selectedPaper?.id || "", iframeContextMenu.blockId);
            setIframeContextMenu(null);
          }}>
            <Copy size={14} /> 复制到笔记
          </button>
        </div>
      )}
    </main>
  );
}


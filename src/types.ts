export type DisplayMode = "bilingual" | "original" | "translation" | "soft";

export type PaperSummary = {
  id: string;
  title: string;
  fileName: string;
  path: string;
  sourcePath: string;
  hash: string;
  year: string;
  size: number;
  lastModified: string;
  lastReadAt: string;
  progress: number;
  annotationCount: number;
  health: DoctorHealth;
  tags: string[];
};

export type HealthStatus = "ok" | "warning" | "error" | "readonly";

export type DoctorIssue = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  suggestion: string;
  autoFixable: boolean;
};

export type DoctorHealth = {
  status: HealthStatus;
  score: number;
  issues: DoctorIssue[];
};

export type DoctorReport = {
  generatedAt: string;
  entries: Array<{
    id: string;
    fileName: string;
    filePath: string;
    sourcePath: string;
    hash: string;
    checkedAt: string;
    health: DoctorHealth;
  }>;
};

export type DoctorFixResult = {
  dryRun: boolean;
  fixes: string[];
  diff: string;
  health: DoctorHealth;
};

export type RenameResult = {
  title: string;
  oldTitle: string;
  hash: string;
  backupPath: string;
  changed: boolean;
};

export type OutlineItem = {
  id: string;
  text: string;
  level: number;
};

export type ReaderSettings = {
  displayMode: DisplayMode;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
};

export type ReaderState = {
  currentDocId?: string;
  recentDocIds: string[];
  scrollByDocId: Record<string, number>;
  lastReadByDocId: Record<string, string>;
  settings: ReaderSettings;
  panelWidths?: { left: number; right: number };
  collapsedPanels?: { left: boolean; right: boolean };
  notesMode?: boolean;
};

export type AnnotationType = "highlight" | "underline" | "note" | "question";

export type Annotation = {
  id: string;
  docId: string;
  selectedText: string;
  prefix: string;
  suffix: string;
  textPosition: {
    start: number;
    end: number;
  };
  cssPath: string;
  type: AnnotationType;
  color: string;
  note: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type AnnotationStore = {
  docId: string;
  items: Annotation[];
};

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "orange" | "purple";

export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: "#fef08a",
  green: "#86efac",
  blue: "#93c5fd",
  pink: "#f9a8d4",
  orange: "#fdba74",
  purple: "#c4b5fd",
};

export type Highlight = {
  id: string;
  docId: string;
  selectedText: string;
  prefix: string;
  suffix: string;
  textPosition: { start: number; end: number };
  color: HighlightColor;
  note: string;
  createdAt: string;
};

export type HighlightStore = {
  docId: string;
  items: Highlight[];
};

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

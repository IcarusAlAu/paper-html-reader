import type {
  AnnotationStore,
  DoctorFixResult,
  DoctorReport,
  EditHistoryEntry,
  HighlightStore,
  InsertKind,
  PaperSummary,
  ReaderState,
  RenameResult
} from "./types";

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchLibrary() {
  return request<{ root: string; papers: PaperSummary[] }>("/api/library");
}

export async function fetchDoctorReport() {
  return request<DoctorReport>("/api/doctor/report");
}

export async function fetchState() {
  return request<ReaderState>("/api/state");
}

export async function saveState(state: ReaderState) {
  return request<ReaderState>("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state)
  });
}

export async function fetchDocument(path: string) {
  const response = await fetch(`/api/document?path=${encodeURIComponent(path)}`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const hash = response.headers.get("X-Document-Hash") || "";
  return { html: await response.text(), hash };
}

export async function fetchAnnotations(docId: string) {
  return request<AnnotationStore>(`/api/annotations?docId=${encodeURIComponent(docId)}`);
}

export async function saveAnnotations(store: AnnotationStore) {
  return request<AnnotationStore>(`/api/annotations?docId=${encodeURIComponent(store.docId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(store)
  });
}

export async function fetchHighlights(docId: string) {
  return request<HighlightStore>(`/api/highlights?docId=${encodeURIComponent(docId)}`);
}

export async function saveHighlights(store: HighlightStore) {
  return request<HighlightStore>(`/api/highlights?docId=${encodeURIComponent(store.docId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(store)
  });
}

type EditContext = {
  filePath: string;
  sourcePath?: string;
  expectedHash?: string;
};

export async function updateBlock(context: EditContext, blockId: string, text: string) {
  return request<EditHistoryEntry>("/api/edit/block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...context, blockId, operation: "update", text })
  });
}

export async function deleteBlock(context: EditContext, blockId: string) {
  return request<EditHistoryEntry>("/api/edit/block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...context, blockId, operation: "delete" })
  });
}

export async function insertBlock(
  context: EditContext,
  blockId: string,
  operation: "insertBefore" | "insertAfter",
  insertKind: InsertKind,
  text: string
) {
  return request<EditHistoryEntry>("/api/edit/block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...context, blockId, operation, insertKind, text })
  });
}

export async function editSelection(
  context: EditContext,
  blockId: string,
  operation: "selectionDelete" | "selectionReplace" | "selectionInsertAfter",
  start: number,
  end: number,
  text = ""
) {
  return request<EditHistoryEntry>("/api/edit/block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...context, blockId, operation, start, end, text })
  });
}

export async function undoLastEdit() {
  return request<{ undone: EditHistoryEntry; backupPath: string }>("/api/edit/undo", {
    method: "POST"
  });
}

export async function batchEdit(filePath: string, operations: Array<Record<string, unknown>>) {
  return request<{ applied: number; failed: number; errors: string[]; hash: string }>("/api/edit/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filePath, operations })
  });
}

export async function previewDoctorFix(docId: string) {
  return request<DoctorFixResult>(`/api/docs/${encodeURIComponent(docId)}/doctor/fix?dryRun=true`, { method: "POST" });
}

export async function applyDoctorFix(docId: string) {
  return request<DoctorFixResult>(`/api/docs/${encodeURIComponent(docId)}/doctor/fix?dryRun=false`, { method: "POST" });
}

export async function openDoctorBackupFolder() {
  return request<{ opened: string }>("/api/doctor/open-backup-folder", { method: "POST" });
}

export async function renameDocument(docId: string, title: string, expectedHash?: string) {
  return request<RenameResult>(`/api/docs/${encodeURIComponent(docId)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, expectedHash })
  });
}

export async function deleteDocument(docId: string) {
  return request<{ deleted: string; backupsCleaned: boolean }>(`/api/docs/${encodeURIComponent(docId)}/delete`, {
    method: "POST"
  });
}

export async function openDocumentFolder(docId: string) {
  return request<{ opened: string }>(`/api/docs/${encodeURIComponent(docId)}/open-folder`, {
    method: "POST"
  });
}

export async function fetchTags(docId?: string) {
  const qs = docId ? `?docId=${encodeURIComponent(docId)}` : "";
  return request<string[] | { tags: string[] }>(`/api/tags${qs}`);
}

export async function saveTags(docId: string, tags: string[]) {
  return request<string[]>(`/api/tags?docId=${encodeURIComponent(docId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tags)
  });
}

export async function fetchNote(id: string) {
  const response = await fetch(`/api/notes/${encodeURIComponent(id)}`);
  if (response.status === 404) return "";
  if (!response.ok) throw new Error(await response.text());
  return response.text();
}

export async function saveNote(id: string, html: string) {
  const response = await fetch(`/api/notes/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "text/html" },
    body: html
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<{ id: string; saved: boolean }>;
}

export async function fetchNoteList() {
  return request<{ notes: Array<{ id: string; fileName: string; mtime: string }> }>("/api/notes");
}

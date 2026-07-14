import type { BookNote } from "./book";

export type CoReadingStatus = "off" | "active" | "paused";
export type CoReadingBlockStatus = "tracking" | "queued" | "processing" | "silent" | "annotated" | "failed";

export interface CoReadingSettings {
  bookId: string;
  status: CoReadingStatus;
  dwellSeconds: number;
  rollingSummary: string;
  /** Provider id only; empty follows global selected model. No credentials. */
  modelProviderId: string;
  /** Model id within provider; empty follows global selected model. */
  modelId: string;
  createdAt: number;
  updatedAt: number;
}

export interface CoReadingBlock {
  id: string;
  bookId: string;
  blockKey: string;
  sectionIndex: number;
  sectionLabel: string;
  cfi: string;
  text: string;
  textHash: string;
  dwellMs: number;
  status: CoReadingBlockStatus;
  decision: string | null;
  annotationId: string | null;
  error: string | null;
  unlockedAt: number | null;
  processedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CoReadingStats {
  tracking: number;
  queued: number;
  processing: number;
  silent: number;
  annotated: number;
  failed: number;
}

export interface CoReadingSnapshot {
  settings: CoReadingSettings;
  stats: CoReadingStats;
  blocks: CoReadingBlock[];
}

export interface CoReadingBlockUpsert {
  id: string;
  bookId: string;
  blockKey: string;
  sectionIndex: number;
  sectionLabel: string;
  cfi: string;
  text: string;
  textHash: string;
  dwellMs: number;
  status: "tracking" | "queued";
  unlockedAt: number | null;
}

export interface UpdateCoReadingSettingsData {
  bookId: string;
  status: CoReadingStatus;
  dwellSeconds: number;
  rollingSummary?: string;
  /** Omitted keeps existing; empty string clears book override. */
  modelProviderId?: string;
  /** Omitted keeps existing; empty string clears book override. */
  modelId?: string;
}

export interface CoReadingDecision {
  action: "silent" | "annotate";
  blockKey: string | null;
  quote: string;
  comment: string;
  summary: string;
}

export interface CoReadingAnnotationDecision {
  blockKey: string;
  quote: string;
  comment: string;
}

export interface CoReadingBatchDecision {
  annotations: CoReadingAnnotationDecision[];
  summary: string;
}

export interface CoReadingBatch {
  newBlocks: CoReadingBlock[];
  recentBlocks: CoReadingBlock[];
  rollingSummary: string;
  annotations: string[];
  estimatedInputTokens: number;
}

export interface CoReadingRuntimeState {
  visibleBlockCount: number;
  leadingBlockKey: string | null;
  leadingBlockDwellMs: number;
  isProcessing: boolean;
  error: string | null;
}

export type ValidatedCoReadingDecision =
  | { ok: true; action: "silent"; summary: string }
  | {
      ok: true;
      action: "annotate";
      block: CoReadingBlock;
      quote: string;
      comment: string;
      summary: string;
    }
  | { ok: false; error: string };

export type CoReadingRangeTaskStatus = "running" | "paused" | "completed" | "stopped" | "failed";
export type CoReadingFootprintStatus = "filtered" | "candidate" | "selected" | "silent" | "annotated" | "failed";

export interface CoReadingRangeTask {
  id: string;
  bookId: string;
  format: "EPUB" | "PDF";
  rangeKind: "section" | "page";
  startIndex: number;
  endIndex: number;
  startLabel: string;
  endLabel: string;
  startCharOffset: number | null;
  endCharOffset: number | null;
  startPercent: number | null;
  endPercent: number | null;
  status: CoReadingRangeTaskStatus;
  previousFollowStatus: CoReadingStatus;
  candidateLimit: number;
  perSectionLimit: number;
  requestLimit: number;
  scannedCount: number;
  selectedCount: number;
  processedCount: number;
  requestCount: number;
  cursorIndex: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface CoReadingFootprint {
  id: string;
  taskId: string;
  bookId: string;
  blockKey: string;
  sectionIndex: number;
  sectionLabel: string;
  cfi: string;
  text: string;
  textHash: string;
  status: CoReadingFootprintStatus;
  reason: string | null;
  summary: string | null;
  comment: string | null;
  annotationId: string | null;
  createdAt: number;
  updatedAt: number;
  processedAt: number | null;
}
export interface CoReadingRangeSnapshot {
  tasks: CoReadingRangeTask[];
  footprints: CoReadingFootprint[];
}

export interface ReadingFootprintTarget {
  bookId: string;
  annotationId: string;
  cfi: string;
  annotation: BookNote;
}

export interface CoReadingSourceTarget {
  bookId: string;
  cfi: string | null;
  annotationId: string | null;
  blockKey: string | null;
  sectionIndex: number | null;
  sectionLabel: string | null;
  text: string;
}

export interface CreateCoReadingRangeTaskData {
  bookId: string;
  format: "EPUB" | "PDF";
  rangeKind: "section" | "page";
  startIndex: number;
  endIndex: number;
  startLabel: string;
  endLabel: string;
  startCharOffset?: number;
  endCharOffset?: number;
  startPercent?: number;
  endPercent?: number;
}

export type CoReadingFootprintUpsert = Omit<CoReadingFootprint, "createdAt" | "updatedAt">;

import type { BookNote } from "./book";

export type CoReadingStatus = "off" | "active" | "paused";
export type CoReadingBlockStatus =
  | "tracking"
  | "queued"
  | "processing"
  | "silent"
  | "annotated"
  | "failed";

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
  /** Stable visible page/spread focus identifier shared by all blocks read together. */
  focusKey?: string;
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
  /** Stable visible page/spread focus identifier shared by all blocks read together. */
  focusKey: string;
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

/** Final result for one complete visible page/spread focus. */
export interface CoReadingItemResult {
  summary: string;
  annotations: Array<{
    blockKey: string;
    quote: string;
    comment: string;
  }>;
}

/** Final result for a user-triggered review of one human underline. */
export interface CoReadingReviewResult {
  review: string;
}

export interface CoReadingReviewInput {
  text: string;
  contextBefore: string;
  contextAfter: string;
  humanNote: string;
  rollingSummary: string;
  recentAiAnnotations: string[];
}

export interface CoReadingNoteCreateData {
  id: string;
  blockKey: string;
  type: "annotation";
  cfi: string;
  text: string;
  style: "underline";
  color: "blue";
  note: string;
  context: {
    before: string;
    after: string;
  };
}

export interface PersistCoReadingFocusData {
  bookId: string;
  blockKeys: string[];
  notes: CoReadingNoteCreateData[];
  rollingSummary?: string;
}

export interface PersistCoReadingFocusResult {
  notes: BookNote[];
}

export interface ReleaseCoReadingFocusData {
  bookId: string;
  blockKeys: string[];
}

export interface ReleaseCoReadingFocusResult {
  /** True only when this call changed the complete focus from processing back to queued. */
  released: boolean;
  /** True when the focus had already committed atomically before cancellation reached Rust. */
  committed: boolean;
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
  visibleQueuedBlockCount: number;
  visibleFailedBlockCount: number;
  leadingBlockKey: string | null;
  leadingBlockDwellMs: number;
  /** Current visible page/spread focus or the focus being processed. */
  focusKey: string | null;
  processingBlockCount: number;
  processingStartedAt: number | null;
  runBlocked: boolean;
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

export interface ValidatedCoReadingItemResult {
  annotations: Array<{
    block: CoReadingBlock;
    quote: string;
    comment: string;
  }>;
  summary: string;
}

export type CoReadingRangeTaskStatus =
  | "running"
  | "paused"
  | "completed"
  | "stopped"
  | "failed";
export type CoReadingFootprintStatus =
  | "filtered"
  // Historical compatibility only: active range workers persist final states directly.
  | "candidate"
  | "selected"
  | "silent"
  | "annotated"
  | "failed";

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

export interface UpdateCoReadingRangeTaskData {
  taskId: string;
  status: CoReadingRangeTaskStatus;
  error?: string;
  expectedUpdatedAt: number;
}
export type CoReadingFootprintUpsert = Omit<
  CoReadingFootprint,
  "createdAt" | "updatedAt"
>;

export interface AdvanceCoReadingRangeTaskData {
  taskId: string;
  expectedUpdatedAt: number;
  cursorIndex: number;
  scannedDelta: number;
  selectedDelta: number;
  processedDelta: number;
  requestDelta: number;
}

export interface PersistCoReadingRangeSectionData
  extends AdvanceCoReadingRangeTaskData {
  notes: CoReadingNoteCreateData[];
  footprints: CoReadingFootprintUpsert[];
  rollingSummary: string;
}

export interface PersistCoReadingRangeSectionResult {
  task: CoReadingRangeTask;
  notes: BookNote[];
  footprints: CoReadingFootprint[];
}

export interface FailCoReadingRangeSectionData {
  taskId: string;
  expectedUpdatedAt: number;
  requestDelta: number;
  error: string;
  footprints: CoReadingFootprintUpsert[];
}

export interface FailCoReadingRangeSectionResult {
  task: CoReadingRangeTask;
  footprints: CoReadingFootprint[];
}

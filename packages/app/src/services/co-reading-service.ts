import type {
  CoReadingBlock,
  CoReadingBlockUpsert,
  CoReadingFootprint,
  CoReadingFootprintUpsert,
  CoReadingRangeSnapshot,
  CoReadingRangeTask,
  CoReadingRangeTaskStatus,
  CoReadingSettings,
  CoReadingSnapshot,
  CreateCoReadingRangeTaskData,
  UpdateCoReadingSettingsData,
} from "@/types/co-reading";
import { invoke } from "@tauri-apps/api/core";

export function getCoReadingSnapshot(bookId: string): Promise<CoReadingSnapshot> {
  return invoke<CoReadingSnapshot>("get_co_reading_snapshot", { bookId });
}

export function updateCoReadingSettings(data: UpdateCoReadingSettingsData): Promise<CoReadingSettings> {
  return invoke<CoReadingSettings>("update_co_reading_settings", { data });
}

export function upsertCoReadingBlocks(blocks: CoReadingBlockUpsert[]): Promise<CoReadingBlock[]> {
  return invoke<CoReadingBlock[]>("upsert_co_reading_blocks", { blocks });
}

export function getQueuedCoReadingBlocks(bookId: string, limit = 20): Promise<CoReadingBlock[]> {
  return invoke<CoReadingBlock[]>("get_queued_co_reading_blocks", {
    bookId,
    limit,
  });
}

export function claimCoReadingBlocks(bookId: string, blockKeys: string[]): Promise<CoReadingBlock[]> {
  return invoke<CoReadingBlock[]>("claim_co_reading_blocks", {
    data: { bookId, blockKeys },
  });
}

export function completeCoReadingBatch(data: {
  bookId: string;
  blockKeys: string[];
  status: "silent" | "annotated" | "failed";
  decision?: string;
  annotationId?: string;
  annotatedBlockKey?: string;
  error?: string;
  rollingSummary?: string;
}): Promise<void> {
  return invoke("complete_co_reading_batch", { data });
}

export function retryCoReadingBlocks(bookId: string, blockKeys: string[]): Promise<number> {
  return invoke<number>("retry_co_reading_blocks", {
    data: { bookId, blockKeys },
  });
}

export function createCoReadingRangeTask(data: CreateCoReadingRangeTaskData): Promise<CoReadingRangeTask> {
  return invoke<CoReadingRangeTask>("create_co_reading_range_task", { data });
}

export function getCoReadingRangeSnapshot(bookId: string): Promise<CoReadingRangeSnapshot> {
  return invoke<CoReadingRangeSnapshot>("get_co_reading_range_snapshot", {
    bookId,
  });
}

export function updateCoReadingRangeTask(
  taskId: string,
  status: CoReadingRangeTaskStatus,
  error?: string,
): Promise<CoReadingRangeTask> {
  return invoke<CoReadingRangeTask>("update_co_reading_range_task", {
    data: { taskId, status, error },
  });
}

export function upsertCoReadingFootprints(items: CoReadingFootprintUpsert[]): Promise<CoReadingFootprint[]> {
  return invoke<CoReadingFootprint[]>("upsert_co_reading_footprints", {
    items,
  });
}

export function advanceCoReadingRangeTask(data: {
  taskId: string;
  cursorIndex: number;
  scannedDelta: number;
  selectedDelta: number;
  processedDelta: number;
  requestDelta: number;
}): Promise<CoReadingRangeTask> {
  return invoke<CoReadingRangeTask>("advance_co_reading_range_task", { data });
}

import type { CoReadingFootprint } from "../types/co-reading.ts";

export const CO_READING_DIARY_DEFAULT_COUNT = 30;
export const CO_READING_DIARY_COUNT_PRESETS = [10, 20, 30, 50] as const;
export const CO_READING_DIARY_MIN_COUNT = 1;
export const CO_READING_DIARY_MAX_COUNT = 100;

export interface CoReadingDiaryEntry {
  originalText: string;
  text: string;
  aiComment: string;
  comment: string;
  summary: string | null;
  section: string | null;
  sectionLabel: string | null;
  sectionIndex: number;
  position: string | number;
  cfi: string | null;
  page: number | null;
  task: string;
  time: number;
  createdAt: number;
}

export interface CoReadingDiaryPayload {
  bookTitle: string;
  currentDate: string;
  currentTime: string;
  selectedCount: number;
  entries: CoReadingDiaryEntry[];
}

export interface CoReadingDiarySelectionState {
  eligibleCount: number;
  selectedCount: number;
  validCount: boolean;
  canSubmit: boolean;
}

export function getCoReadingFootprintTime(item: CoReadingFootprint): number {
  return item.createdAt;
}

export function getDiaryEligibleFootprints(footprints: CoReadingFootprint[]): CoReadingFootprint[] {
  return footprints.filter(
    (item) => item.status === "annotated" && item.text.trim().length > 0 && Boolean(item.comment?.trim()),
  );
}

function assertRequestedCount(requestedCount: number): void {
  if (!Number.isInteger(requestedCount)) throw new Error("记录条数必须是整数");
  if (requestedCount < CO_READING_DIARY_MIN_COUNT || requestedCount > CO_READING_DIARY_MAX_COUNT) {
    throw new Error(`记录条数必须在 ${CO_READING_DIARY_MIN_COUNT} 到 ${CO_READING_DIARY_MAX_COUNT} 之间`);
  }
}

export function selectRecentCoReadingFootprints(
  footprints: CoReadingFootprint[],
  requestedCount: number,
): CoReadingFootprint[] {
  assertRequestedCount(requestedCount);

  const recent = getDiaryEligibleFootprints(footprints)
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        getCoReadingFootprintTime(right.item) - getCoReadingFootprintTime(left.item) || left.index - right.index,
    )
    .slice(0, requestedCount);

  // Select newest first, then restore reading order so the diary can form a chronological narrative.
  return recent
    .sort(
      (left, right) =>
        getCoReadingFootprintTime(left.item) - getCoReadingFootprintTime(right.item) || left.index - right.index,
    )
    .map(({ item }) => item);
}

export function getCoReadingDiarySelectionState(
  footprints: CoReadingFootprint[],
  requestedCount: number,
): CoReadingDiarySelectionState {
  const eligibleCount = getDiaryEligibleFootprints(footprints).length;
  const validCount =
    Number.isInteger(requestedCount) &&
    requestedCount >= CO_READING_DIARY_MIN_COUNT &&
    requestedCount <= CO_READING_DIARY_MAX_COUNT;
  const selectedCount = validCount ? selectRecentCoReadingFootprints(footprints, requestedCount).length : 0;
  return { eligibleCount, selectedCount, validCount, canSubmit: validCount && selectedCount > 0 };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatCoReadingDiaryDateTime(now: Date): { currentDate: string; currentTime: string } {
  return {
    currentDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    currentTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

export function buildCoReadingDiaryPayload(
  bookTitle: string,
  footprints: CoReadingFootprint[],
  requestedCount: number,
  now = new Date(),
): CoReadingDiaryPayload {
  const title = bookTitle.trim();
  if (!title) throw new Error("缺少书名，无法创建共读日记");

  const selected = selectRecentCoReadingFootprints(footprints, requestedCount);
  if (selected.length === 0) throw new Error("还没有可写入的 AI 共读记录");

  const dateTime = formatCoReadingDiaryDateTime(now);
  const entries = selected.map((item): CoReadingDiaryEntry => {
    const text = item.text.trim();
    const comment = item.comment?.trim();
    if (!comment) throw new Error("共读记录缺少 AI 评论");
    const sectionLabel = item.sectionLabel.trim() || null;
    const cfi = item.cfi.trim() || null;
    const createdAt = getCoReadingFootprintTime(item);

    return {
      originalText: text,
      text,
      aiComment: comment,
      comment,
      summary: item.summary?.trim() || null,
      section: sectionLabel,
      sectionLabel,
      sectionIndex: item.sectionIndex,
      position: cfi || item.sectionIndex,
      cfi,
      page: null,
      task: item.taskId,
      time: createdAt,
      createdAt,
    };
  });

  return {
    bookTitle: title,
    ...dateTime,
    selectedCount: entries.length,
    entries,
  };
}

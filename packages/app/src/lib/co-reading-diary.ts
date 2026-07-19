import {
  compareReadingLocations,
  normalizeReadingCfi,
} from "./annotation-order";
import type { CoReadingDiarySourceRecord } from "../types/co-reading.ts";

export const CO_READING_DIARY_DEFAULT_COUNT = 30;
export const CO_READING_DIARY_COUNT_PRESETS = [10, 20, 30, 50] as const;
export const CO_READING_DIARY_MIN_COUNT = 1;
export const CO_READING_DIARY_MAX_COUNT = 100;

export interface CoReadingDiaryEntry {
  sourceKey: string;
  sourceAnnotationId: string | null;
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
  sourceKeys: string[];
  entries: CoReadingDiaryEntry[];
}

export interface CoReadingDiaryClassification {
  /** Every source row returned by the backend, before identity de-duplication. */
  allRecords: CoReadingDiarySourceRecord[];
  /** Current source identities after ordinary/range metadata is merged. */
  activeExisting: CoReadingDiarySourceRecord[];
  eligible: CoReadingDiarySourceRecord[];
  unwritten: CoReadingDiarySourceRecord[];
  alreadyWritten: CoReadingDiarySourceRecord[];
}

export interface CoReadingDiarySelectionState {
  totalCount: number;
  activeExistingCount: number;
  eligibleCount: number;
  unwrittenCount: number;
  alreadyWrittenCount: number;
  selectedCount: number;
  validCount: boolean;
  canSubmit: boolean;
}

function sourceIdentity(item: CoReadingDiarySourceRecord): string {
  return (
    item.sourceAnnotationId?.trim() ||
    item.annotationId?.trim() ||
    item.sourceKey.trim()
  );
}

/** Front-to-back reading order; generation time is only a stable fallback. */
function compareSourcePosition(
  left: CoReadingDiarySourceRecord,
  right: CoReadingDiarySourceRecord
): number {
  const position = compareReadingLocations(left, right);
  if (position != null && position !== 0) return position;

  const leftHasLocation =
    (Number.isInteger(left.sectionIndex) && left.sectionIndex >= 0) ||
    normalizeReadingCfi(left.cfi) != null;
  const rightHasLocation =
    (Number.isInteger(right.sectionIndex) && right.sectionIndex >= 0) ||
    normalizeReadingCfi(right.cfi) != null;
  if (leftHasLocation !== rightHasLocation) return leftHasLocation ? -1 : 1;

  return (
    left.createdAt - right.createdAt ||
    left.sourceKey.localeCompare(right.sourceKey)
  );
}

export function mergeCoReadingDiarySources(
  records: CoReadingDiarySourceRecord[]
): CoReadingDiarySourceRecord[] {
  const unique = new Map<string, CoReadingDiarySourceRecord>();
  for (const record of records) {
    const identity = sourceIdentity(record);
    if (!identity) continue;
    const previous = unique.get(identity);
    if (
      !previous ||
      (previous.sourceKind === "ordinary" && record.sourceKind === "range")
    ) {
      unique.set(identity, record);
    }
  }
  return [...unique.values()].sort(compareSourcePosition);
}

export function isDiaryEligibleSource(
  item: CoReadingDiarySourceRecord
): boolean {
  return (
    item.status === "annotated" &&
    item.text.trim().length > 0 &&
    Boolean(item.comment?.trim())
  );
}

export function classifyCoReadingDiarySources(
  records: CoReadingDiarySourceRecord[]
): CoReadingDiaryClassification {
  const allRecords = [...records].sort(compareSourcePosition);
  const activeExisting = mergeCoReadingDiarySources(records);
  const eligible = activeExisting.filter(isDiaryEligibleSource);
  const unwritten = eligible.filter((item) => item.writtenAt == null);
  const alreadyWritten = eligible.filter((item) => item.writtenAt != null);
  return { allRecords, activeExisting, eligible, unwritten, alreadyWritten };
}

function assertRequestedCount(requestedCount: number): void {
  if (!Number.isInteger(requestedCount)) throw new Error("记录条数必须是整数");
  if (
    requestedCount < CO_READING_DIARY_MIN_COUNT ||
    requestedCount > CO_READING_DIARY_MAX_COUNT
  ) {
    throw new Error(
      `记录条数必须在 ${CO_READING_DIARY_MIN_COUNT} 到 ${CO_READING_DIARY_MAX_COUNT} 之间`
    );
  }
}

export function selectRecentCoReadingDiarySources(
  records: CoReadingDiarySourceRecord[],
  requestedCount: number
): CoReadingDiarySourceRecord[] {
  assertRequestedCount(requestedCount);
  const recent = classifyCoReadingDiarySources(records)
    .unwritten.map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        compareSourcePosition(right.item, left.item) ||
        right.item.createdAt - left.item.createdAt ||
        left.index - right.index
    )
    .slice(0, requestedCount);

  return recent
    .sort(
      (left, right) =>
        compareSourcePosition(left.item, right.item) ||
        left.item.createdAt - right.item.createdAt ||
        left.index - right.index
    )
    .map(({ item }) => item);
}

export function getCoReadingDiarySelectionState(
  records: CoReadingDiarySourceRecord[],
  requestedCount: number
): CoReadingDiarySelectionState {
  const classified = classifyCoReadingDiarySources(records);
  const validCount =
    Number.isInteger(requestedCount) &&
    requestedCount >= CO_READING_DIARY_MIN_COUNT &&
    requestedCount <= CO_READING_DIARY_MAX_COUNT;
  const selectedCount = validCount
    ? selectRecentCoReadingDiarySources(records, requestedCount).length
    : 0;
  return {
    totalCount: classified.allRecords.length,
    activeExistingCount: classified.activeExisting.length,
    eligibleCount: classified.eligible.length,
    unwrittenCount: classified.unwritten.length,
    alreadyWrittenCount: classified.alreadyWritten.length,
    selectedCount,
    validCount,
    canSubmit: validCount && selectedCount > 0,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatCoReadingDiaryDateTime(now: Date): {
  currentDate: string;
  currentTime: string;
} {
  return {
    currentDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
      now.getDate()
    )}`,
    currentTime: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

export function buildCoReadingDiaryPayload(
  bookTitle: string,
  records: CoReadingDiarySourceRecord[],
  requestedCount: number,
  now = new Date()
): CoReadingDiaryPayload {
  const title = bookTitle.trim();
  if (!title) throw new Error("缺少书名，无法创建 Agent 日记");

  const selected = selectRecentCoReadingDiarySources(records, requestedCount);
  if (selected.length === 0) throw new Error("当前没有新的待写入共读记录");

  const dateTime = formatCoReadingDiaryDateTime(now);
  const entries = selected.map((item): CoReadingDiaryEntry => {
    const text = item.text.trim();
    const comment = item.comment?.trim();
    if (!comment) throw new Error("共读记录缺少 Agent 评论");
    const sectionLabel = item.sectionLabel.trim() || null;
    const cfi = item.cfi.trim() || null;

    return {
      sourceKey: item.sourceKey,
      sourceAnnotationId: item.sourceAnnotationId,
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
      task: item.taskId || "ordinary",
      time: item.createdAt,
      createdAt: item.createdAt,
    };
  });

  return {
    bookTitle: title,
    ...dateTime,
    selectedCount: entries.length,
    sourceKeys: entries.map((item) => item.sourceKey),
    entries,
  };
}

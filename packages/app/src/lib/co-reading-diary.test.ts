import assert from "node:assert/strict";
import test from "node:test";
import type { CoReadingFootprint } from "../types/co-reading.ts";
import {
  buildCoReadingDiaryPayload,
  formatCoReadingDiaryDateTime,
  getCoReadingDiarySelectionState,
  selectRecentCoReadingFootprints,
} from "./co-reading-diary.ts";

function footprint(id: string, createdAt: number, overrides: Partial<CoReadingFootprint> = {}): CoReadingFootprint {
  return {
    id,
    taskId: "task",
    bookId: "book",
    blockKey: id,
    sectionIndex: 2,
    sectionLabel: "第三章",
    cfi: `epubcfi(${id})`,
    text: `原文 ${id}`,
    textHash: id,
    status: "annotated",
    reason: null,
    summary: `摘要 ${id}`,
    comment: `评论 ${id}`,
    annotationId: id,
    createdAt,
    updatedAt: createdAt + 10,
    processedAt: createdAt + 20,
    ...overrides,
  };
}

test("selects newest N by createdAt and restores chronological reading order", () => {
  const items = [
    footprint("old", 100, { processedAt: 900 }),
    footprint("newest", 400),
    footprint("failed", 500, { status: "failed" }),
    footprint("middle", 300),
  ];
  assert.deepEqual(
    selectRecentCoReadingFootprints(items, 2).map((item) => item.id),
    ["middle", "newest"],
  );
});

test("requires an AI comment for every selected source record", () => {
  const withoutComment = footprint("silent", 200, { status: "silent", comment: null });
  const annotatedWithoutComment = footprint("empty-comment", 300, { comment: "  " });
  assert.deepEqual(selectRecentCoReadingFootprints([withoutComment, annotatedWithoutComment], 30), []);
});

test("reports actual count and disables empty or invalid submissions", () => {
  assert.deepEqual(getCoReadingDiarySelectionState([footprint("only", 100)], 30), {
    eligibleCount: 1,
    selectedCount: 1,
    validCount: true,
    canSubmit: true,
  });
  assert.equal(getCoReadingDiarySelectionState([], 30).canSubmit, false);
  assert.equal(getCoReadingDiarySelectionState([footprint("only", 100)], 101).canSubmit, false);
});

test("rejects custom counts outside the supported range", () => {
  assert.throws(() => selectRecentCoReadingFootprints([], 0), /1 到 100/);
  assert.throws(() => selectRecentCoReadingFootprints([], 101), /1 到 100/);
  assert.throws(() => selectRecentCoReadingFootprints([], 1.5), /整数/);
});

test("builds the complete VCP diary source contract", () => {
  const payload = buildCoReadingDiaryPayload("  测试书  ", [footprint("entry", 20)], 30, new Date(2026, 6, 13, 9, 5));
  assert.deepEqual(payload, {
    bookTitle: "测试书",
    currentDate: "2026-07-13",
    currentTime: "09:05",
    selectedCount: 1,
    entries: [
      {
        originalText: "原文 entry",
        text: "原文 entry",
        aiComment: "评论 entry",
        comment: "评论 entry",
        summary: "摘要 entry",
        section: "第三章",
        sectionLabel: "第三章",
        sectionIndex: 2,
        position: "epubcfi(entry)",
        cfi: "epubcfi(entry)",
        page: null,
        task: "task",
        time: 20,
        createdAt: 20,
      },
    ],
  });
});

test("formats local current date and minute", () => {
  assert.deepEqual(formatCoReadingDiaryDateTime(new Date(2026, 0, 2, 3, 4)), {
    currentDate: "2026-01-02",
    currentTime: "03:04",
  });
});

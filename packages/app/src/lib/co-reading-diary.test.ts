import assert from "node:assert/strict";
import test from "node:test";
import type { CoReadingDiarySourceRecord } from "../types/co-reading.ts";
import {
  buildCoReadingDiaryPayload,
  classifyCoReadingDiarySources,
  formatCoReadingDiaryDateTime,
  getCoReadingDiarySelectionState,
  mergeCoReadingDiarySources,
  selectRecentCoReadingDiarySources,
} from "./co-reading-diary.ts";

function source(
  id: string,
  sectionIndex: number,
  createdAt: number,
  overrides: Partial<CoReadingDiarySourceRecord> = {}
): CoReadingDiarySourceRecord {
  return {
    sourceKey: id,
    sourceKind: "ordinary",
    sourceAnnotationId: id,
    taskId: null,
    blockKey: id,
    bookId: "book",
    sectionIndex,
    sectionLabel: `第 ${sectionIndex + 1} 章`,
    cfi: `epubcfi(/6/${sectionIndex * 2 + 2}/${id})`,
    text: `原文 ${id}`,
    comment: `评论 ${id}`,
    summary: `摘要 ${id}`,
    status: "annotated",
    createdAt,
    annotationId: id,
    writtenAt: null,
    diaryId: null,
    ...overrides,
  };
}

test("classifies active, eligible, unwritten and already-written records separately", () => {
  const records = [
    source("new", 1, 100),
    source("written", 2, 200, { writtenAt: 300, diaryId: "diary" }),
    source("empty", 3, 300, { comment: " " }),
    source("failed", 4, 400, { status: "failed" }),
  ];
  const result = classifyCoReadingDiarySources(records);
  assert.equal(result.allRecords.length, 4);
  assert.equal(result.activeExisting.length, 4);
  assert.equal(result.eligible.length, 2);
  assert.deepEqual(
    result.unwritten.map((item) => item.sourceKey),
    ["new"]
  );
  assert.deepEqual(
    result.alreadyWritten.map((item) => item.sourceKey),
    ["written"]
  );
});

test("deduplicates one annotation identity and keeps richer range metadata", () => {
  const ordinary = source("ordinary-key", 1, 100, {
    sourceAnnotationId: "annotation",
  });
  const range = source("range-key", 2, 100, {
    sourceKind: "range",
    sourceAnnotationId: "annotation",
    taskId: "task",
  });
  assert.deepEqual(mergeCoReadingDiarySources([ordinary, range]), [range]);
  const classified = classifyCoReadingDiarySources([ordinary, range]);
  assert.equal(classified.allRecords.length, 2);
  assert.equal(classified.activeExisting.length, 1);
});

test("selects latest unwritten positions then returns them in forward reading order", () => {
  const records = [
    source("first", 1, 900),
    source("second", 2, 100),
    source("third", 3, 200),
    source("written-latest", 4, 300, { writtenAt: 400, diaryId: "d" }),
  ];
  assert.deepEqual(
    selectRecentCoReadingDiarySources(records, 2).map((item) => item.sourceKey),
    ["second", "third"]
  );
});

test("reports all four counts and disables empty or invalid submissions", () => {
  const records = [
    source("new", 1, 100),
    source("written", 2, 200, { writtenAt: 300, diaryId: "diary" }),
    source("empty", 3, 300, { comment: "" }),
  ];
  assert.deepEqual(getCoReadingDiarySelectionState(records, 30), {
    totalCount: 3,
    activeExistingCount: 3,
    eligibleCount: 2,
    unwrittenCount: 1,
    alreadyWrittenCount: 1,
    selectedCount: 1,
    validCount: true,
    canSubmit: true,
  });
  assert.equal(getCoReadingDiarySelectionState([], 30).canSubmit, false);
  assert.equal(getCoReadingDiarySelectionState(records, 101).canSubmit, false);
});

test("rejects custom counts outside the supported range", () => {
  assert.throws(() => selectRecentCoReadingDiarySources([], 0), /1 到 100/);
  assert.throws(() => selectRecentCoReadingDiarySources([], 101), /1 到 100/);
  assert.throws(() => selectRecentCoReadingDiarySources([], 1.5), /整数/);
});

test("builds the VCP diary payload with source keys and forward reading order", () => {
  const payload = buildCoReadingDiaryPayload(
    "  测试书  ",
    [source("later", 3, 10), source("earlier", 1, 900)],
    30,
    new Date(2026, 6, 13, 9, 5)
  );
  assert.equal(payload.bookTitle, "测试书");
  assert.equal(payload.currentDate, "2026-07-13");
  assert.equal(payload.currentTime, "09:05");
  assert.equal(payload.selectedCount, 2);
  assert.deepEqual(payload.sourceKeys, ["earlier", "later"]);
  assert.deepEqual(
    payload.entries.map((entry) => entry.sourceKey),
    ["earlier", "later"]
  );
  assert.deepEqual(
    payload.entries.map((entry) => entry.sourceAnnotationId),
    ["earlier", "later"]
  );
  assert.equal(payload.entries[0].originalText, "原文 earlier");
  assert.equal(payload.entries[0].aiComment, "评论 earlier");
});

test("does not select records without an AI comment", () => {
  assert.deepEqual(
    selectRecentCoReadingDiarySources(
      [
        source("silent", 1, 100, { status: "silent", comment: null }),
        source("empty-comment", 2, 200, { comment: "  " }),
      ],
      30
    ),
    []
  );
});

test("formats local current date and minute", () => {
  assert.deepEqual(formatCoReadingDiaryDateTime(new Date(2026, 0, 2, 3, 4)), {
    currentDate: "2026-01-02",
    currentTime: "03:04",
  });
});

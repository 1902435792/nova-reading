import assert from "node:assert/strict";
import test from "node:test";
import type { CoReadingBlock, CoReadingDecision } from "../types/co-reading.ts";
import * as coReadingCore from "./co-reading-core.ts";
import {
  buildCoReadingBatch,
  estimateTokens,
  sanitizeCoReadingError,
  splitTextOffsets,
  validateCoReadingBatchDecision,
  validateCoReadingDecision,
} from "./co-reading-core.ts";

const makeBlock = (blockKey: string, text: string, status: CoReadingBlock["status"] = "queued"): CoReadingBlock => ({
  id: `id-${blockKey}`,
  bookId: "book",
  blockKey,
  sectionIndex: 1,
  sectionLabel: "Chapter",
  cfi: `epubcfi(/6/2[${blockKey}])`,
  text,
  textHash: `hash-${blockKey}`,
  dwellMs: 15_000,
  status,
  decision: null,
  annotationId: null,
  error: null,
  unlockedAt: 100,
  processedAt: null,
  createdAt: 100,
  updatedAt: 100,
});

test("token estimation is conservative for CJK and Latin text", () => {
  assert.equal(estimateTokens("共同阅读"), 4);
  assert.ok(estimateTokens("four latin words here") >= 5);
});

test("batch includes only whole unlocked blocks and stays within 5000 tokens", () => {
  const queued = Array.from({ length: 5 }, (_, index) => makeBlock(`new-${index}`, "新内容".repeat(300)));
  const recent = Array.from({ length: 4 }, (_, index) =>
    makeBlock(`old-${index}`, "old context ".repeat(180), "silent"),
  );

  const batch = buildCoReadingBatch({
    queued,
    recent,
    rollingSummary: "摘要".repeat(500),
    annotations: ["批注".repeat(300)],
  });

  assert.ok(batch.newBlocks.length > 0);
  assert.ok(batch.newBlocks.length < queued.length);
  assert.ok(batch.estimatedInputTokens <= 5_000);
  assert.ok(batch.newBlocks.every((block) => block.status === "queued"));
  assert.ok(batch.recentBlocks.every((block) => block.status === "silent" || block.status === "annotated"));
  assert.equal(
    batch.newBlocks.map((block) => block.blockKey).join(","),
    queued
      .slice(0, batch.newBlocks.length)
      .map((block) => block.blockKey)
      .join(","),
  );
});

test("long visible text is split at sentence boundaries without gaps", () => {
  const sentence = "这是一个完整句子，用于测试稳定文本分片。";
  const text = sentence.repeat(180);
  const offsets = splitTextOffsets(text, 600, 1_200);

  assert.ok(offsets.length > 1);
  assert.equal(offsets[0]?.start, 0);
  assert.equal(offsets.at(-1)?.end, text.length);
  assert.ok(offsets.every(({ start, end }) => estimateTokens(text.slice(start, end)) <= 1_200));
  assert.ok(offsets.slice(1).every((offset, index) => offset.start === offsets[index]?.end));
});

test("batch never fills context from tracking or future blocks", () => {
  const batch = buildCoReadingBatch({
    queued: [makeBlock("future", "not unlocked", "tracking"), makeBlock("ready", "ready")],
    recent: [makeBlock("failed", "not completed", "failed")],
    rollingSummary: "",
    annotations: [],
  });

  assert.deepEqual(
    batch.newBlocks.map((block) => block.blockKey),
    ["ready"],
  );
  assert.deepEqual(batch.recentBlocks, []);
});

test("silent decisions must not smuggle an annotation payload", () => {
  const decision: CoReadingDecision = {
    action: "silent",
    blockKey: "ready",
    quote: "ready",
    comment: "comment",
    summary: "summary",
  };

  assert.deepEqual(validateCoReadingDecision(decision, [makeBlock("ready", "ready text")]), {
    ok: false,
    error: "沉默决定不能包含批注内容",
  });
});

test("persisted model errors redact credentials", () => {
  const sanitized = sanitizeCoReadingError("request failed Authorization: Bearer sk-secret api_key=another-secret");
  assert.equal(sanitized.includes("sk-secret"), false);
  assert.equal(sanitized.includes("another-secret"), false);
  assert.equal(sanitized.includes("[REDACTED]"), true);
});

test("a persisted flush response cannot roll back newer local dwell or queued state", () => {
  const merge = (
    coReadingCore as typeof coReadingCore & {
      mergeTrackedCoReadingState?: (
        local: {
          dwellMs: number;
          status: "tracking" | "queued";
          unlockedAt: number | null;
        },
        persisted: CoReadingBlock,
      ) => {
        dwellMs: number;
        status: "tracking" | "queued";
        unlockedAt: number | null;
      };
    }
  ).mergeTrackedCoReadingState;
  assert.equal(typeof merge, "function");
  if (!merge) return;

  const persisted = {
    ...makeBlock("race", "visible text", "tracking"),
    dwellMs: 4_000,
    unlockedAt: null,
  };
  assert.deepEqual(merge({ dwellMs: 5_100, status: "queued", unlockedAt: 200 }, persisted), {
    dwellMs: 5_100,
    status: "queued",
    unlockedAt: 200,
  });
});

test("batch decision supports zero to four contextual annotations and rejects invalid quotes", () => {
  const claimed = [
    makeBlock("one", "第一段里有值得停下来的准确引文。", "processing"),
    makeBlock("two", "第二段继续推进同一条阅读脉络。", "processing"),
  ];
  assert.deepEqual(validateCoReadingBatchDecision({ annotations: [], summary: "连续摘要" }, claimed), {
    annotations: [],
    summary: "连续摘要",
  });
  assert.deepEqual(
    validateCoReadingBatchDecision(
      {
        annotations: [
          {
            blockKey: "one",
            quote: "准确引文",
            comment: "这处停顿延续了上一段的犹疑。",
          },
          {
            blockKey: "two",
            quote: "继续推进",
            comment: "这里让同一条线索发生了变化。",
          },
        ],
        summary: "更新后的连续摘要",
      },
      claimed,
    ).annotations.map((item) => item.block.blockKey),
    ["one", "two"],
  );
  assert.throws(
    () =>
      validateCoReadingBatchDecision(
        {
          annotations: [{ blockKey: "one", quote: "改写引文", comment: "无效" }],
          summary: "摘要",
        },
        claimed,
      ),
    /逐字来自/,
  );
});

test("annotation quote must be an exact substring of a claimed block", () => {
  const claimed = [makeBlock("ready", "The exact quotation lives here.", "processing")];
  const invalidKey: CoReadingDecision = {
    action: "annotate",
    blockKey: "other",
    quote: "exact quotation",
    comment: "This lands differently after the previous paragraph.",
    summary: "summary",
  };
  const invalidQuote: CoReadingDecision = {
    ...invalidKey,
    blockKey: "ready",
    quote: "paraphrased quotation",
  };
  const valid: CoReadingDecision = {
    ...invalidKey,
    blockKey: "ready",
    quote: "exact quotation",
  };

  assert.equal(validateCoReadingDecision(invalidKey, claimed).ok, false);
  assert.equal(validateCoReadingDecision(invalidQuote, claimed).ok, false);
  assert.deepEqual(validateCoReadingDecision(valid, claimed), {
    ok: true,
    action: "annotate",
    block: claimed[0],
    quote: "exact quotation",
    comment: valid.comment,
    summary: "summary",
  });
});

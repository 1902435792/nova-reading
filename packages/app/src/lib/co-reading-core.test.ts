import assert from "node:assert/strict";
import test from "node:test";
import type { CoReadingBlock, CoReadingDecision } from "../types/co-reading.ts";
import * as coReadingCore from "./co-reading-core.ts";
import {
  buildCoReadingBatch,
  estimateTokens,
  getCoReadingErrorInfo,
  groupCoReadingFailures,
  sanitizeCoReadingError,
  splitTextOffsets,
  validateCoReadingBatchDecision,
  validateCoReadingDecision,
  validateCoReadingItemResult,
  validateCoReadingReviewResult,
} from "./co-reading-core.ts";

const makeBlock = (
  blockKey: string,
  text: string,
  status: CoReadingBlock["status"] = "queued"
): CoReadingBlock => ({
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
  const queued = Array.from({ length: 5 }, (_, index) =>
    makeBlock(`new-${index}`, "新内容".repeat(300))
  );
  const recent = Array.from({ length: 4 }, (_, index) =>
    makeBlock(`old-${index}`, "old context ".repeat(180), "silent")
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
  assert.ok(
    batch.recentBlocks.every(
      (block) => block.status === "silent" || block.status === "annotated"
    )
  );
  assert.equal(
    batch.newBlocks.map((block) => block.blockKey).join(","),
    queued
      .slice(0, batch.newBlocks.length)
      .map((block) => block.blockKey)
      .join(",")
  );
});

test("batch caps failure blast radius at six new blocks", () => {
  const batch = buildCoReadingBatch({
    queued: Array.from({ length: 12 }, (_, index) =>
      makeBlock(`small-${index}`, `第 ${index} 段短文本`)
    ),
    recent: [],
    rollingSummary: "",
    annotations: [],
  });
  assert.equal(batch.newBlocks.length, 6);
  assert.deepEqual(
    batch.newBlocks.map((block) => block.blockKey),
    ["small-0", "small-1", "small-2", "small-3", "small-4", "small-5"]
  );
});

test("co-reading errors are actionable and permanent configuration errors are fatal", () => {
  assert.deepEqual(
    getCoReadingErrorInfo(new Error("Insufficient account balance")),
    {
      message: "模型服务额度不足，请充值或切换可用模型后重试。",
      fatal: true,
      retryable: false,
      kind: "balance",
    }
  );
  assert.equal(
    getCoReadingErrorInfo(new Error("Requested Bridge Profile does not exist."))
      .kind,
    "profile"
  );
  assert.deepEqual(
    getCoReadingErrorInfo(new Error("native_placeholder_unresolved")),
    {
      message:
        "VCP Bridge Prompt 仍有未展开的原生占位符，请检查 Profile、Prompt 与 VCP 变量配置后重试。",
      fatal: true,
      retryable: false,
      kind: "profile",
    }
  );
  assert.equal(getCoReadingErrorInfo(new Error("HTTP 429")).retryable, true);
  assert.equal(
    getCoReadingErrorInfo(
      new Error("No object generated: response did not match schema.")
    ).kind,
    "format"
  );
  assert.equal(
    getCoReadingErrorInfo(
      new Error("Insufficient quota: upstream JSON error response")
    ).kind,
    "balance"
  );
});

test("failure groups count page focuses separately from DOM blocks", () => {
  const failed = Array.from({ length: 6 }, (_, index) => ({
    blockKey: `block-${index}`,
    focusKey: "page-focus",
    error: "Insufficient quota: upstream JSON error response",
  }));
  failed.push({
    blockKey: "other-block",
    focusKey: "other-focus",
    error: "No object generated: response did not match schema.",
  });

  assert.deepEqual(groupCoReadingFailures(failed), [
    {
      message: "模型服务额度不足，请充值或切换可用模型后重试。",
      fatal: true,
      retryable: false,
      kind: "balance",
      blockCount: 6,
      focusCount: 1,
    },
    {
      message:
        "模型未返回符合要求的共读 JSON，已停止当前小批；可以重试或切换模型。",
      fatal: false,
      retryable: true,
      kind: "format",
      blockCount: 1,
      focusCount: 1,
    },
  ]);
});

test("long visible text is split at sentence boundaries without gaps", () => {
  const sentence = "这是一个完整句子，用于测试稳定文本分片。";
  const text = sentence.repeat(180);
  const offsets = splitTextOffsets(text, 600, 1_200);

  assert.ok(offsets.length > 1);
  assert.equal(offsets[0]?.start, 0);
  assert.equal(offsets.at(-1)?.end, text.length);
  assert.ok(
    offsets.every(
      ({ start, end }) => estimateTokens(text.slice(start, end)) <= 1_200
    )
  );
  assert.ok(
    offsets
      .slice(1)
      .every((offset, index) => offset.start === offsets[index]?.end)
  );
});

test("batch never fills context from tracking or future blocks", () => {
  const batch = buildCoReadingBatch({
    queued: [
      makeBlock("future", "not unlocked", "tracking"),
      makeBlock("ready", "ready"),
    ],
    recent: [makeBlock("failed", "not completed", "failed")],
    rollingSummary: "",
    annotations: [],
  });

  assert.deepEqual(
    batch.newBlocks.map((block) => block.blockKey),
    ["ready"]
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

  assert.deepEqual(
    validateCoReadingDecision(decision, [makeBlock("ready", "ready text")]),
    {
      ok: false,
      error: "沉默决定不能包含批注内容",
    }
  );
});

test("persisted model errors redact credentials", () => {
  const sanitized = sanitizeCoReadingError(
    "request failed Authorization: Bearer sk-secret api_key=another-secret"
  );
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
        persisted: CoReadingBlock
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
  assert.deepEqual(
    merge({ dwellMs: 5_100, status: "queued", unlockedAt: 200 }, persisted),
    {
      dwellMs: 5_100,
      status: "queued",
      unlockedAt: 200,
    }
  );
});

test("batch decision supports zero to four contextual annotations and rejects invalid quotes", () => {
  const claimed = [
    makeBlock("one", "第一段里有值得停下来的准确引文。", "processing"),
    makeBlock("two", "第二段继续推进同一条阅读脉络。", "processing"),
  ];
  assert.deepEqual(
    validateCoReadingBatchDecision(
      { annotations: [], summary: "连续摘要" },
      claimed
    ),
    {
      annotations: [],
      summary: "连续摘要",
    }
  );
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
      claimed
    ).annotations.map((item) => item.block.blockKey),
    ["one", "two"]
  );
  assert.throws(
    () =>
      validateCoReadingBatchDecision(
        {
          annotations: [
            { blockKey: "one", quote: "改写引文", comment: "无效" },
          ],
          summary: "摘要",
        },
        claimed
      ),
    /逐字来自/
  );
});

test("single-item result is silent or validates an exact current-block quote", () => {
  const block = makeBlock(
    "one",
    "这一段包含准确引文，也继续推进上下文。",
    "processing"
  );
  assert.deepEqual(
    validateCoReadingItemResult({ summary: " 摘要 ", annotations: [] }, [
      block,
    ]),
    {
      annotations: [],
      summary: "摘要",
    }
  );
  assert.deepEqual(
    validateCoReadingItemResult(
      {
        summary: "继续",
        annotations: [
          {
            blockKey: block.blockKey,
            quote: "准确引文",
            comment: " 语气在这里发生变化。 ",
          },
        ],
      },
      [block]
    ),
    {
      annotations: [
        { block, quote: "准确引文", comment: "语气在这里发生变化。" },
      ],
      summary: "继续",
    }
  );
  assert.throws(() =>
    validateCoReadingItemResult(
      {
        summary: "",
        annotations: [
          { blockKey: block.blockKey, quote: "改写引文", comment: "无效" },
        ],
      },
      [block]
    )
  );
  assert.deepEqual(
    validateCoReadingItemResult(
      {
        summary: "",
        annotations: [
          { blockKey: block.blockKey, quote: "准确引文", comment: "第一条" },
          {
            blockKey: block.blockKey,
            quote: "推进上下文",
            comment: "第二条",
          },
        ],
      },
      [block]
    ).annotations,
    [
      { block, quote: "准确引文", comment: "第一条" },
      { block, quote: "推进上下文", comment: "第二条" },
    ]
  );
  assert.equal(
    validateCoReadingReviewResult({ review: " 这是一条书评。 " }),
    "这是一条书评。"
  );
  assert.throws(() => validateCoReadingReviewResult({ review: "   " }));
  assert.throws(() =>
    validateCoReadingReviewResult({ review: "长".repeat(2_001) })
  );
});

test("annotation quote must be an exact substring of a claimed block", () => {
  const claimed = [
    makeBlock("ready", "The exact quotation lives here.", "processing"),
  ];
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

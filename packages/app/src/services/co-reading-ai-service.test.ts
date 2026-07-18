import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCoReadingBatchDecisionText,
  parseCoReadingDecisionText,
  parseCoReadingItemResultText,
  parseCoReadingReviewResultText,
  parseCoReadingSelectionText,
} from "./co-reading-decision-parser.ts";

const silent = {
  action: "silent",
  blockKey: null,
  quote: "",
  comment: "",
  summary: "测试正文。",
} as const;

const annotate = {
  action: "annotate",
  blockKey: "chapter-1:block-2",
  quote: "测试正文",
  comment: "这一句值得停一下。",
  summary: "测试正文。",
} as const;

test("accepts complete single and batch decisions", () => {
  assert.deepEqual(parseCoReadingDecisionText(JSON.stringify(silent)), silent);
  assert.deepEqual(
    parseCoReadingDecisionText(JSON.stringify(annotate)),
    annotate
  );
  assert.deepEqual(
    parseCoReadingBatchDecisionText(
      JSON.stringify({
        annotations: [
          { blockKey: "one", quote: "原文", comment: "值得停一下。" },
        ],
        summary: "连续摘要",
      })
    ),
    {
      annotations: [
        { blockKey: "one", quote: "原文", comment: "值得停一下。" },
      ],
      summary: "连续摘要",
    }
  );
});

test("parses direct single-item and manual review results strictly", () => {
  const item = {
    summary: "连续摘要",
    annotations: [
      {
        blockKey: "block-1",
        quote: "原文",
        comment: "这一处改变了前文的语气。",
      },
    ],
  };
  assert.deepEqual(parseCoReadingItemResultText(JSON.stringify(item)), item);
  assert.deepEqual(
    parseCoReadingItemResultText(
      `结果：\n\`\`\`json\n${JSON.stringify({
        summary: "继续",
        annotations: [],
      })}\n\`\`\``
    ),
    { summary: "继续", annotations: [] }
  );
  assert.deepEqual(
    parseCoReadingReviewResultText(
      '书评：{"review":"这里的迟疑把前文重新照亮。"}'
    ),
    {
      review: "这里的迟疑把前文重新照亮。",
    }
  );
  assert.throws(() =>
    parseCoReadingItemResultText(JSON.stringify({ ...item, extra: true }))
  );
  assert.throws(() => parseCoReadingReviewResultText('{"review":""}'));
  assert.throws(() =>
    parseCoReadingReviewResultText('{"review":"ok"}{"review":"again"}')
  );
  assert.throws(() =>
    parseCoReadingReviewResultText('<<<[TOOL_REQUEST]>>>{"review":"bad"}')
  );
  assert.throws(() =>
    parseCoReadingReviewResultText(
      JSON.stringify({ review: "长".repeat(2_001) })
    )
  );
});

test("adds action only to an exact safe four-field silent decision", () => {
  const { action: _action, ...withoutAction } = silent;
  assert.deepEqual(
    parseCoReadingDecisionText(JSON.stringify(withoutAction)),
    silent
  );

  const { action: _annotateAction, ...annotateWithoutAction } = annotate;
  assert.throws(() =>
    parseCoReadingDecisionText(JSON.stringify(annotateWithoutAction))
  );
});

test("structured fallback accepts one fenced or prose-wrapped JSON object", () => {
  assert.deepEqual(
    parseCoReadingSelectionText(
      '选择如下：\n```json\n{"selectedBlockKeys":["one","two"]}\n```'
    ),
    ["one", "two"]
  );
  assert.deepEqual(
    parseCoReadingBatchDecisionText(
      '结果：{"annotations":[],"summary":"继续推进"}。'
    ),
    { annotations: [], summary: "继续推进" }
  );
  assert.deepEqual(
    parseCoReadingDecisionText(`\`\`\`json\n${JSON.stringify(silent)}\n\`\`\``),
    silent
  );
});

test("structured fallback remains fail-closed for tools, multiple objects and invalid schemas", () => {
  assert.throws(() =>
    parseCoReadingDecisionText(
      `<<<[TOOL_REQUEST]>>>\n{}\n<<<[END_TOOL_REQUEST]>>>\n${JSON.stringify(
        silent
      )}`
    )
  );
  assert.throws(() =>
    parseCoReadingDecisionText(
      `${JSON.stringify(silent)}\n${JSON.stringify(silent)}`
    )
  );
  assert.throws(() =>
    parseCoReadingSelectionText(
      JSON.stringify({ selectedBlockKeys: ["1", "2", "3", "4", "5", "6", "7"] })
    )
  );
  assert.throws(() =>
    parseCoReadingBatchDecisionText(
      JSON.stringify({ annotations: [], summary: "ok", extra: true })
    )
  );
  assert.throws(() =>
    parseCoReadingDecisionText(JSON.stringify({ ...silent, blockKey: 1 }))
  );
});

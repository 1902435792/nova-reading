import assert from "node:assert/strict";
import test from "node:test";
import { parseCoReadingDecisionText } from "./co-reading-decision-parser.ts";

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

test("accepts a complete silent decision", () => {
  assert.deepEqual(parseCoReadingDecisionText(JSON.stringify(silent)), silent);
});

test("accepts a complete annotate decision", () => {
  assert.deepEqual(parseCoReadingDecisionText(JSON.stringify(annotate)), annotate);
});

test("adds action only to an exact safe four-field silent decision", () => {
  const { action: _action, ...withoutAction } = silent;
  assert.deepEqual(parseCoReadingDecisionText(JSON.stringify(withoutAction)), silent);
});

test("rejects an annotate-like decision without action", () => {
  const { action: _action, ...withoutAction } = annotate;
  assert.throws(() => parseCoReadingDecisionText(JSON.stringify(withoutAction)));
});

test("rejects Markdown-wrapped JSON", () => {
  assert.throws(() => parseCoReadingDecisionText(`\`\`\`json\n${JSON.stringify(silent)}\n\`\`\``));
});

test("rejects TOOL_REQUEST content", () => {
  assert.throws(() =>
    parseCoReadingDecisionText(`<<<[TOOL_REQUEST]>>>\n{}\n<<<[END_TOOL_REQUEST]>>>\n${JSON.stringify(silent)}`),
  );
});

test("rejects text before or after the JSON object", () => {
  assert.throws(() => parseCoReadingDecisionText(`result: ${JSON.stringify(silent)}`));
  assert.throws(() => parseCoReadingDecisionText(`${JSON.stringify(silent)} done`));
});

test("rejects multiple JSON objects", () => {
  assert.throws(() => parseCoReadingDecisionText(`${JSON.stringify(silent)}\n${JSON.stringify(silent)}`));
});

test("rejects wrong field types and unknown fields", () => {
  assert.throws(() => parseCoReadingDecisionText(JSON.stringify({ ...silent, blockKey: 1 })));
  assert.throws(() => parseCoReadingDecisionText(JSON.stringify({ ...silent, extra: true })));
});

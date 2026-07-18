import assert from "node:assert/strict";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";
import type { FoliateView } from "../types/view.ts";
import {
  extractVisibleCoReadingFocus,
  resolveVisibleCoReadingRanges,
  type VisibleCoReadingRange,
} from "./co-reading-dom.ts";

const previousGlobals = {
  Document: globalThis.Document,
  Element: globalThis.Element,
  Node: globalThis.Node,
  NodeFilter: globalThis.NodeFilter,
  Range: globalThis.Range,
  Text: globalThis.Text,
};

function installDom(html: string): Document {
  const dom = new JSDOM(html);
  const { window } = dom;
  Object.assign(globalThis, {
    Document: window.Document,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Range: window.Range,
    Text: window.Text,
  });
  return window.document;
}

after(() => {
  Object.assign(globalThis, previousGlobals);
});

function selectText(doc: Document, start: string, end = start): Range {
  const startElement = doc.getElementById(start);
  const endElement = doc.getElementById(end);
  assert.ok(startElement);
  assert.ok(endElement);
  const range = doc.createRange();
  range.setStart(startElement, 0);
  range.setEnd(endElement, endElement.childNodes.length);
  return range;
}

function createView(
  contents: Array<{ doc: Document; index: number }>,
  visibleRanges?: Array<{ index?: number; range: Range }>
): FoliateView {
  return {
    renderer: {
      page: 4,
      start: 0.25,
      end: 0.5,
      getContents: () => contents,
      ...(visibleRanges ? { getVisibleRanges: () => visibleRanges } : {}),
    },
    getCFI: (index: number, range: Range) =>
      `cfi:${index}:${range.toString().replace(/\s+/gu, " ").trim()}`,
    resolveCFI: () => ({ index: contents[0]?.index ?? 0, anchor: () => null }),
  } as unknown as FoliateView;
}

test("complete two-page focus keeps visual range order and assigns one shared focusKey", () => {
  const left = installDom("<body><p id='left'>左页正文</p></body>");
  const right = installDom("<body><p id='right'>右页正文</p></body>");
  const ranges: VisibleCoReadingRange[] = [
    { index: 0, range: selectText(left, "left") },
    { index: 1, range: selectText(right, "right") },
  ];
  const view = createView(
    [
      { doc: left, index: 0 },
      { doc: right, index: 1 },
    ],
    ranges
  );

  const blocks = extractVisibleCoReadingFocus("book", view, ranges, "双页");
  assert.deepEqual(
    blocks.map((block) => block.text),
    ["左页正文", "右页正文"]
  );
  assert.equal(new Set(blocks.map((block) => block.focusKey)).size, 1);
});

test("RTL visual ordering supplied by renderer is preserved", () => {
  const right = installDom("<body><p id='right'>右侧先读</p></body>");
  const left = installDom("<body><p id='left'>左侧后读</p></body>");
  const ranges: VisibleCoReadingRange[] = [
    { index: 8, range: selectText(right, "right") },
    { index: 7, range: selectText(left, "left") },
  ];
  const view = createView(
    [
      { doc: left, index: 7 },
      { doc: right, index: 8 },
    ],
    ranges
  );

  assert.deepEqual(
    extractVisibleCoReadingFocus("book", view, ranges, "RTL").map(
      (block) => block.text
    ),
    ["右侧先读", "左侧后读"]
  );
});

test("visible focus includes clipped edge paragraphs and excludes invisible text", () => {
  const doc = installDom(`
    <body>
      <p id="before">不可见前文</p>
      <p id="first">前半不可见，后半可见</p>
      <p id="middle">完整可见</p>
      <p id="last">前半可见，后半不可见</p>
      <p id="after">不可见后文</p>
    </body>
  `);
  const firstText = doc.getElementById("first")?.firstChild;
  const lastText = doc.getElementById("last")?.firstChild;
  assert.ok(firstText);
  assert.ok(lastText);
  const range = doc.createRange();
  range.setStart(firstText, "前半不可见，".length);
  range.setEnd(lastText, "前半可见".length);
  const view = createView([{ doc, index: 3 }], [{ index: 3, range }]);

  const texts = extractVisibleCoReadingFocus(
    "book",
    view,
    [{ index: 3, range }],
    "边缘"
  ).map((block) => block.text);
  assert.deepEqual(texts, ["后半可见", "完整可见", "前半可见"]);
});

test("ordinary visible focus filters only obvious noise, exact duplicates, and keeps short headings", () => {
  const doc = installDom(`
    <body>
      <p id="all">
        <span><p> </p></span>
      </p>
      <p>第 12 页</p>
      <p>下一页</p>
      <p>—— ❦ ——</p>
      <h2>前言</h2>
      <p>短句</p>
      <p>重复正文</p>
      <p>重复正文</p>
    </body>
  `);
  const range = doc.createRange();
  range.selectNodeContents(doc.body);
  const view = createView([{ doc, index: 0 }], [{ index: 0, range }]);
  const blocks = extractVisibleCoReadingFocus(
    "book",
    view,
    [{ index: 0, range }],
    "过滤"
  );

  assert.deepEqual(
    blocks.map((block) => block.text.trim()),
    ["前言", "短句", "重复正文"]
  );
});

test("renderer complete ranges take precedence over a collapsed CFI anchor", () => {
  const doc = installDom("<body><p id='page'>完整当前页</p></body>");
  const range = selectText(doc, "page");
  let resolveCalls = 0;
  const view = createView([{ doc, index: 2 }], [{ index: 2, range }]);
  view.resolveCFI = () => {
    resolveCalls += 1;
    const collapsed = doc.createRange();
    collapsed.setStart(doc.getElementById("page")?.firstChild ?? doc.body, 0);
    collapsed.collapse(true);
    return { index: 2, anchor: () => collapsed };
  };

  const resolved = resolveVisibleCoReadingRanges(view, {
    location: "epubcfi(collapsed-anchor)",
    sectionIndex: 2,
  });
  assert.equal(resolveCalls, 0);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.range.toString(), "完整当前页");
});

test("stale or mismatched renderer ranges are rejected without expanding a CFI anchor", () => {
  const current = installDom("<body><p id='current'>当前页</p></body>");
  const stale = installDom("<body><p id='stale'>旧页面</p></body>");
  const staleRange = selectText(stale, "stale");
  let resolveCalls = 0;
  const view = createView([{ doc: current, index: 5 }], [
    { index: 5, range: staleRange },
  ]);
  view.resolveCFI = () => {
    resolveCalls += 1;
    return { index: 5, anchor: () => null };
  };

  assert.deepEqual(
    resolveVisibleCoReadingRanges(view, {
      location: "epubcfi(stale)",
      sectionIndex: 5,
    }),
    []
  );
  assert.equal(resolveCalls, 0);
});

test("stable resampling preserves focus identity while a changed page creates a new focus", () => {
  const doc = installDom(
    "<body><p id='one'>第一页</p><p id='two'>第二页</p></body>"
  );
  const firstA = selectText(doc, "one");
  const firstB = selectText(doc, "one");
  const second = selectText(doc, "two");
  const view = createView([{ doc, index: 0 }]);

  const firstFocusA = extractVisibleCoReadingFocus(
    "book",
    view,
    [{ index: 0, range: firstA }],
    "章节"
  );
  const firstFocusB = extractVisibleCoReadingFocus(
    "book",
    view,
    [{ index: 0, range: firstB }],
    "章节"
  );
  const secondFocus = extractVisibleCoReadingFocus(
    "book",
    view,
    [{ index: 0, range: second }],
    "章节"
  );

  assert.equal(firstFocusA[0]?.focusKey, firstFocusB[0]?.focusKey);
  assert.notEqual(firstFocusA[0]?.focusKey, secondFocus[0]?.focusKey);
});

test("iframe document recreation with the same visible content retains focus identity", () => {
  const oldDoc = installDom("<body><p id='page'>同一页正文</p></body>");
  const newDoc = installDom("<body><p id='page'>同一页正文</p></body>");
  const oldRange = selectText(oldDoc, "page");
  const newRange = selectText(newDoc, "page");
  const oldView = createView([{ doc: oldDoc, index: 9 }]);
  const newView = createView([{ doc: newDoc, index: 9 }]);

  const oldFocus = extractVisibleCoReadingFocus(
    "book",
    oldView,
    [{ index: 9, range: oldRange }],
    "章节"
  );
  const newFocus = extractVisibleCoReadingFocus(
    "book",
    newView,
    [{ index: 9, range: newRange }],
    "章节"
  );
  assert.equal(oldFocus[0]?.focusKey, newFocus[0]?.focusKey);
});

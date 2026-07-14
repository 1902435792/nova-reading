import assert from "node:assert/strict";
import test from "node:test";
import type {
  CoReadingBlockUpsert,
  CoReadingFootprint,
} from "../types/co-reading.ts";
import {
  adjustEndPercentForCurrentPosition,
  buildCoReadingBookTextIndex,
  buildCoReadingRangeOptions,
  classifyRangeCandidate,
  clipCharacterRange,
  countUnicodeCharacters,
  getCoReadingDefaultPercentageRange,
  getCoReadingSectionLabel,
  getRangeTaskStatusLabel,
  groupFootprintsBySection,
  mapPercentageToBookRange,
  mapSectionOffsetToCurrentPosition,
  normalizeSelectedBlockKeys,
  RANGE_TASK_STATUS_LABELS,
  unicodeOffsetToUtf16,
} from "./co-reading-range.ts";

function block(key: string, text: string, hash = key): CoReadingBlockUpsert {
  return {
    id: key,
    bookId: "book",
    blockKey: key,
    sectionIndex: 0,
    sectionLabel: "第一章",
    cfi: `cfi:${key}`,
    text,
    textHash: hash,
    dwellMs: 0,
    status: "tracking",
    unlockedAt: null,
  };
}

test("range candidate filter rejects short and duplicate text", () => {
  const seen = new Set<string>();
  assert.equal(
    classifyRangeCandidate(block("a", "太短", "same"), seen).status,
    "filtered"
  );
  assert.equal(
    classifyRangeCandidate(
      block(
        "b",
        "这是一段足够长、包含具体动作和语气变化，值得交给 Nova 继续筛选的候选文本。",
        "same"
      ),
      seen
    ).reason,
    "重复文本"
  );
});

test("range candidate accepts substantial unique prose", () => {
  const result = classifyRangeCandidate(
    block(
      "a",
      "他说没事，却把那封信折了又折。纸张留下了一道再也展不平的死褶，而他的手仍旧没有松开，像是连一句告别也舍不得让它恢复原样。"
    ),
    new Set()
  );
  assert.deepEqual(result, { status: "candidate", reason: null });
});

test("selection only keeps allowed unique keys within limit", () => {
  const candidates = [
    block("a", "这是候选文本，长度在这里并不影响 key 校验。"),
    block("b", "另一个候选文本。"),
  ];
  assert.deepEqual(
    normalizeSelectedBlockKeys(["b", "x", "b", "a"], candidates, 2),
    ["b", "a"]
  );
});

test("EPUB range options use real nested TOC labels instead of invented chapter numbers", () => {
  const bookDoc = {
    sections: [
      { id: "cover" },
      { id: "preface" },
      { id: "part-a" },
      { id: "essay" },
    ],
    toc: [
      { label: "写在前面", href: "preface#start" },
      {
        label: "上编：夜行",
        href: "part-a",
        subitems: [{ label: "雨停以后", href: "essay#p1" }],
      },
    ],
    splitTOCHref: (href: string) => href.split("#"),
  } as never;
  assert.deepEqual(buildCoReadingRangeOptions(bookDoc, "EPUB"), [
    { sectionIndex: 1, label: "写在前面", pathLabel: "写在前面" },
    { sectionIndex: 2, label: "上编：夜行", pathLabel: "上编：夜行" },
    { sectionIndex: 3, label: "雨停以后", pathLabel: "上编：夜行 › 雨停以后" },
  ]);
  assert.equal(
    getCoReadingSectionLabel(
      buildCoReadingRangeOptions(bookDoc, "EPUB"),
      3,
      "EPUB"
    ),
    "上编：夜行 › 雨停以后"
  );
});

test("PDF range options use page numbers", () => {
  const bookDoc = { sections: [{}, {}, {}] } as never;
  assert.deepEqual(
    buildCoReadingRangeOptions(bookDoc, "PDF").map((item) => item.pathLabel),
    ["第 1 页", "第 2 页", "第 3 页"]
  );
});

test("map groups and orders footprints by section", () => {
  const base = {
    taskId: "t",
    bookId: "b",
    cfi: "c",
    text: "text",
    textHash: "h",
    status: "silent" as const,
    reason: null,
    summary: null,
    comment: null,
    annotationId: null,
    createdAt: 1,
    updatedAt: 1,
    processedAt: 1,
  };
  const items = [
    {
      ...base,
      id: "two",
      blockKey: "two",
      sectionIndex: 2,
      sectionLabel: "第三章",
    },
    {
      ...base,
      id: "one",
      blockKey: "one",
      sectionIndex: 0,
      sectionLabel: "第一章",
    },
  ] satisfies CoReadingFootprint[];
  assert.deepEqual(
    groupFootprintsBySection(items).map((group) => group.sectionIndex),
    [0, 2]
  );
});

test("map keeps empty indexed sections visible for a full-book track", () => {
  const index = buildCoReadingBookTextIndex([100, 200, 300], [], "EPUB");
  const rows = groupFootprintsBySection([], index);
  assert.deepEqual(
    rows.map((row) => [row.sectionIndex, row.footprints.length]),
    [
      [0, 0],
      [1, 0],
      [2, 0],
    ]
  );
});

test("percentage range uses cumulative real text lengths and TOC only as labels", () => {
  const options = [
    { sectionIndex: 0, label: "卷一", pathLabel: "卷一" },
    { sectionIndex: 2, label: "第二章", pathLabel: "卷一 › 第二章" },
  ];
  const index = buildCoReadingBookTextIndex([100, 300, 600], options, "EPUB");
  assert.deepEqual(mapPercentageToBookRange(index, 10, 70), {
    startPercent: 10,
    endPercent: 70,
    startIndex: 1,
    endIndex: 2,
    startCharOffset: 0,
    endCharOffset: 300,
    startLabel: "10% · 卷一 · 后续正文",
    endLabel: "70% · 卷一 › 第二章",
  });
});

test("percentage range supports PDF and EPUB without TOC", () => {
  const pdf = buildCoReadingBookTextIndex(
    [20, 80],
    buildCoReadingRangeOptions({ sections: [{}, {}] } as never, "PDF"),
    "PDF"
  );
  assert.deepEqual(mapPercentageToBookRange(pdf, 0, 100), {
    startPercent: 0,
    endPercent: 100,
    startIndex: 0,
    endIndex: 1,
    startCharOffset: 0,
    endCharOffset: 80,
    startLabel: "0% · 第 1 页",
    endLabel: "100% · 第 2 页",
  });

  const epubOptions = buildCoReadingRangeOptions(
    {
      sections: [
        { id: "empty", size: 0, linear: "yes" },
        { id: "body", size: 100, linear: "yes" },
      ],
      toc: [],
    } as never,
    "EPUB"
  );
  const epub = buildCoReadingBookTextIndex([0, 50], epubOptions, "EPUB");
  assert.equal(mapPercentageToBookRange(epub, 0, 100)?.startIndex, 1);
});

test("percentage boundaries skip empty sections and normalize reversed input", () => {
  const index = buildCoReadingBookTextIndex([0, 100, 0, 100], [], "EPUB");
  const range = mapPercentageToBookRange(index, 75, 25);
  assert.deepEqual(
    range && [
      range.startIndex,
      range.startCharOffset,
      range.endIndex,
      range.endCharOffset,
    ],
    [1, 50, 3, 50]
  );
  assert.deepEqual(range && [range.startPercent, range.endPercent], [25, 75]);
  assert.equal(mapPercentageToBookRange(index, 0, 0), null);
  assert.equal(mapPercentageToBookRange(index, Number.NaN, 50), null);
  assert.equal(
    mapPercentageToBookRange(
      buildCoReadingBookTextIndex([0, 0], [], "EPUB"),
      0,
      100
    ),
    null
  );
});

test("same-section percentages map to clipped character offsets instead of the whole section", () => {
  const index = buildCoReadingBookTextIndex([1_000], [], "EPUB");
  const range = mapPercentageToBookRange(index, 20, 30);
  assert.deepEqual(
    range && [
      range.startIndex,
      range.endIndex,
      range.startCharOffset,
      range.endCharOffset,
    ],
    [0, 0, 200, 300]
  );
});

test("Unicode character counting is code-point based and converts safely to DOM offsets", () => {
  const text = "甲😀é乙";
  assert.equal(countUnicodeCharacters(text), 5);
  assert.equal(unicodeOffsetToUtf16(text, 2), 3);
  assert.equal(unicodeOffsetToUtf16(text, 4), 5);
});

test("default percentage starts near the current real-text section", () => {
  const index = buildCoReadingBookTextIndex([100, 300, 600], [], "EPUB");
  assert.deepEqual(getCoReadingDefaultPercentageRange(index, 1), {
    startPercent: 10,
    endPercent: 20,
  });
});

test("character boundaries clip intersecting blocks and reject outside blocks", () => {
  assert.deepEqual(clipCharacterRange(10, 30, 20, 40), { start: 20, end: 30 });
  assert.deepEqual(clipCharacterRange(30, 50, 20, 40), { start: 30, end: 40 });
  assert.equal(clipCharacterRange(0, 20, 20, 40), null);
  assert.equal(clipCharacterRange(40, 60, 20, 40), null);
});

test("current EPUB position preserves exact code-point offset and advances an invalid end", () => {
  const index = buildCoReadingBookTextIndex([100, 300, 600], [], "EPUB");
  assert.deepEqual(mapSectionOffsetToCurrentPosition(index, 1, 125), {
    sectionIndex: 1,
    charOffset: 125,
    absoluteOffset: 225,
    startPercent: 22.5,
    label: "正文位置 2",
  });
  assert.equal(adjustEndPercentForCurrentPosition(22.5, 20), 32.5);
  assert.equal(adjustEndPercentForCurrentPosition(100, 100), null);
});

test("range task status labels are Chinese for production UI", () => {
  assert.deepEqual(RANGE_TASK_STATUS_LABELS, {
    running: "进行中",
    paused: "已暂停",
    completed: "已完成",
    stopped: "已停止",
    failed: "失败",
  });
  assert.equal(getRangeTaskStatusLabel("running"), "进行中");
  assert.equal(getRangeTaskStatusLabel("paused"), "已暂停");
  assert.equal(getRangeTaskStatusLabel("completed"), "已完成");
  assert.equal(getRangeTaskStatusLabel("stopped"), "已停止");
  assert.equal(getRangeTaskStatusLabel("failed"), "失败");
  assert.equal(getRangeTaskStatusLabel("unknown"), "unknown");
});

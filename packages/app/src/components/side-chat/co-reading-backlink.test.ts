import assert from "node:assert/strict";
import test from "node:test";
import type { BookNote } from "../../types/book.ts";
import type { CoReadingFootprint } from "../../types/co-reading.ts";
import {
  type ReadingFootprintTarget,
  consumePendingReadingFootprint,
  createReadingFootprintTarget,
  dispatchOpenReadingFootprint,
  findFootprintByAnnotationId,
  getAnnotationSourceTarget,
  getFootprintSourceTarget,
  listenForReadingFootprint,
  navigateToReadingSource,
  openReadingFootprintForAnnotation,
  savePendingReadingFootprint,
  shouldOpenReadingFootprint,
} from "./co-reading-backlink.ts";

const makeAnnotation = (author: BookNote["author"]): BookNote => ({
  id: `${author}-annotation`,
  type: "annotation",
  cfi: `epubcfi(/6/2[${author}])`,
  text: "quote",
  author,
  note: "comment",
  createdAt: 1,
  updatedAt: 1,
});

const makeTarget = (bookId = "book-a"): ReadingFootprintTarget => {
  const annotation = makeAnnotation("ai");
  return {
    bookId,
    annotationId: annotation.id,
    cfi: annotation.cfi,
    annotation,
  };
};

const makeFootprint = (annotationId: string | null): CoReadingFootprint => ({
  id: `footprint-${annotationId ?? "none"}`,
  taskId: "task",
  bookId: "book-a",
  blockKey: "block",
  sectionIndex: 1,
  sectionLabel: "Chapter",
  cfi: "epubcfi(/6/2)",
  text: "text",
  textHash: "hash",
  status: "annotated",
  reason: null,
  summary: null,
  comment: "comment",
  annotationId,
  createdAt: 1,
  updatedAt: 1,
  processedAt: 1,
});

test("only AI annotations open the reading footprint backlink", () => {
  assert.equal(shouldOpenReadingFootprint(makeAnnotation("ai")), true);
  assert.equal(shouldOpenReadingFootprint(makeAnnotation("human")), false);
  assert.equal(shouldOpenReadingFootprint(makeAnnotation(undefined)), false);
});

test("production entry writes pending footprint and dispatches only for AI annotations", () => {
  const eventTarget = new EventTarget();
  const received: ReadingFootprintTarget[] = [];
  const stop = listenForReadingFootprint(eventTarget, "book-a", (target) =>
    received.push(target)
  );
  const pending: Array<ReadingFootprintTarget | null> = [];
  const ai = makeAnnotation("ai");
  const human = makeAnnotation("human");

  assert.equal(
    openReadingFootprintForAnnotation({
      bookId: "book-a",
      annotation: human,
      setPendingReadingFootprint: (target) => pending.push(target),
      eventTarget,
    }),
    null
  );
  assert.deepEqual(pending, []);
  assert.deepEqual(received, []);

  const opened = openReadingFootprintForAnnotation({
    bookId: "book-a",
    annotation: ai,
    setPendingReadingFootprint: (target) => pending.push(target),
    eventTarget,
  });
  const expected = createReadingFootprintTarget("book-a", ai);
  assert.deepEqual(opened, expected);
  assert.deepEqual(pending, [expected]);
  assert.deepEqual(received, [expected]);

  assert.equal(
    openReadingFootprintForAnnotation({
      bookId: undefined,
      annotation: ai,
      setPendingReadingFootprint: (target) => pending.push(target),
      eventTarget,
    }),
    null
  );
  stop();
});

test("open event forwards the full target only to the matching book", () => {
  const eventTarget = new EventTarget();
  const received: ReadingFootprintTarget[] = [];
  const stopMatching = listenForReadingFootprint(
    eventTarget,
    "book-a",
    (target) => received.push(target)
  );
  const stopOther = listenForReadingFootprint(eventTarget, "book-b", () =>
    assert.fail("wrong book received event")
  );
  const target = makeTarget();

  dispatchOpenReadingFootprint(eventTarget, target);

  assert.deepEqual(received, [target]);
  stopMatching();
  stopOther();
  dispatchOpenReadingFootprint(eventTarget, target);
  assert.equal(received.length, 1);
});

test("annotation id selects its footprint and missing legacy footprints fall back", () => {
  const expected = makeFootprint("ai-annotation");
  const footprints = [makeFootprint(null), expected, makeFootprint("another")];

  assert.strictEqual(
    findFootprintByAnnotationId(footprints, "ai-annotation"),
    expected
  );
  assert.equal(
    findFootprintByAnnotationId(footprints, "legacy-ai-annotation"),
    null
  );
});

test("pending target survives a closed side chat and is consumed once", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const target = makeTarget();

  savePendingReadingFootprint(storage, target);

  assert.deepEqual(consumePendingReadingFootprint(storage, "book-a"), target);
  assert.equal(consumePendingReadingFootprint(storage, "book-a"), null);
});

test("source navigation selects an exact CFI and returns a section fallback when needed", async () => {
  const footprint = makeFootprint("ai-annotation");
  const exactCalls: unknown[] = [];
  const exactNavigator = {
    resolveCFI: () => ({ index: 1, anchor: () => ({} as Range) }),
    select: async () => {},
    renderer: { goTo: async (target: unknown) => exactCalls.push(target) },
  };

  assert.deepEqual(
    await navigateToReadingSource(
      exactNavigator,
      getFootprintSourceTarget(footprint)
    ),
    {
      precision: "exact",
      message: "已定位并高亮原文",
    }
  );
  assert.equal((exactCalls[0] as { select?: boolean }).select, true);

  const fallbackCalls: unknown[] = [];
  const fallbackNavigator = {
    resolveCFI: () => {
      throw new Error("stale CFI");
    },
    select: async () => {},
    renderer: { goTo: async (target: unknown) => fallbackCalls.push(target) },
  };
  assert.deepEqual(
    await navigateToReadingSource(
      fallbackNavigator,
      getFootprintSourceTarget(footprint)
    ),
    {
      precision: "fallback",
      message: "精确位置已失效，已跳到Chapter附近",
    }
  );
  assert.deepEqual(fallbackCalls, [{ index: 1, anchor: 0 }]);
});

test("ordinary follow annotation carries block metadata for section fallback", () => {
  const annotation = makeAnnotation("ai");
  assert.deepEqual(
    getAnnotationSourceTarget("book-a", annotation, {
      blockKey: "follow-block",
      sectionIndex: 4,
      sectionLabel: "第五节",
    }),
    {
      bookId: "book-a",
      cfi: annotation.cfi,
      annotationId: annotation.id,
      blockKey: "follow-block",
      sectionIndex: 4,
      sectionLabel: "第五节",
      text: "quote",
    }
  );
});

test("missing source data returns an explainable unavailable result", async () => {
  const navigator = {
    resolveCFI: () => {
      throw new Error("unexpected");
    },
    select: async () => {},
    renderer: {},
  };
  assert.deepEqual(
    await navigateToReadingSource(navigator, {
      bookId: "book-a",
      cfi: null,
      annotationId: null,
      blockKey: null,
      sectionIndex: null,
      sectionLabel: null,
      text: "legacy",
    }),
    { precision: "unavailable", message: "该记录缺少可用的原文定位信息" }
  );
});

test("pending targets cannot navigate another book and malformed data is discarded", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };

  savePendingReadingFootprint(storage, makeTarget("book-a"));
  assert.equal(consumePendingReadingFootprint(storage, "book-b"), null);
  assert.deepEqual(
    consumePendingReadingFootprint(storage, "book-a"),
    makeTarget("book-a")
  );

  storage.setItem("deepreader:pending-reading-footprint:book-a", "not-json");
  assert.equal(consumePendingReadingFootprint(storage, "book-a"), null);
});

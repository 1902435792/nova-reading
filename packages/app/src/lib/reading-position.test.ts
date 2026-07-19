import assert from "node:assert/strict";
import test from "node:test";

import {
  createVisibleReadingPosition,
  formatVisibleReadingPosition,
} from "./reading-position";

test("a Foliate relocation from page 1 to page 2 changes the live Agent position", () => {
  const pageOne = createVisibleReadingPosition({
    location: "epubcfi(/6/2!/4/2)",
    sectionIndex: 4,
    sectionLabel: "第一章",
    pageCurrent: 0,
    pageTotal: 12,
  });
  const pageTwo = createVisibleReadingPosition({
    location: "epubcfi(/6/2!/4/10)",
    sectionIndex: 4,
    sectionLabel: "第一章",
    pageCurrent: 1,
    pageTotal: 12,
  });

  const pageOnePromptContext = formatVisibleReadingPosition(pageOne);
  const pageTwoPromptContext = formatVisibleReadingPosition(pageTwo);

  assert.notEqual(pageOnePromptContext, pageTwoPromptContext);
  assert.match(pageOnePromptContext, /当前页：1\/12/);
  assert.match(pageTwoPromptContext, /当前页：2\/12/);
  assert.match(pageTwoPromptContext, /epubcfi\(\/6\/2!\/4\/10\)/);
});

test("invalid or empty relocation fields do not become fake reading positions", () => {
  const position = createVisibleReadingPosition({
    location: "  ",
    sectionIndex: -1,
    sectionLabel: null,
    pageCurrent: -1,
    pageTotal: 0,
  });

  assert.deepEqual(position, {});
  assert.equal(formatVisibleReadingPosition(position), "");
});

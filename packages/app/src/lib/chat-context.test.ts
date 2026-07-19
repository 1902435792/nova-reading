import assert from "node:assert/strict";
import test from "node:test";

import { resolveChatContextAtSend } from "./chat-context";
import { createVisibleReadingPosition } from "./reading-position";

test("request-time resolver uses page 2 after relocation instead of the rendered page 1 snapshot", () => {
  const renderedPageOne = {
    activeBookId: "book-1",
    activeReadingPosition: createVisibleReadingPosition({
      location: "epubcfi(/6/2!/4/2)",
      sectionIndex: 4,
      pageCurrent: 0,
      pageTotal: 12,
    }),
  };
  let livePage = renderedPageOne;

  livePage = {
    activeBookId: "book-1",
    activeReadingPosition: createVisibleReadingPosition({
      location: "epubcfi(/6/2!/4/10)",
      sectionIndex: 4,
      pageCurrent: 1,
      pageTotal: 12,
    }),
  };

  const outgoing = resolveChatContextAtSend(renderedPageOne, () => livePage);
  assert.equal(outgoing?.activeReadingPosition?.pageCurrent, 1);
  assert.equal(outgoing?.activeReadingPosition?.location, "epubcfi(/6/2!/4/10)");
});

test("non-reader chat keeps using its rendered context when no live resolver exists", () => {
  const context = { activeBookId: "book-1", activeContext: "thread context" };
  assert.equal(resolveChatContextAtSend(context), context);
});

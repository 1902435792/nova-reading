import assert from "node:assert/strict";
import test from "node:test";
import type { BookConfig, BookNote } from "../../types/book.ts";
import { EMPTY_BOOK_NOTES, selectBookNotes } from "./co-reading-panel-state.ts";

test("book note fallback is stable while reader config is cold-loading", () => {
  const first = selectBookNotes({ config: null });
  const second = selectBookNotes({ config: null });

  assert.strictEqual(first, EMPTY_BOOK_NOTES);
  assert.strictEqual(first, second);
  assert.deepEqual(first, []);
});

test("book note selector preserves initialized note array identity", () => {
  const booknotes: BookNote[] = [];
  const config = { updatedAt: 0, booknotes } satisfies BookConfig;

  assert.strictEqual(selectBookNotes({ config }), booknotes);
});

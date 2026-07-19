import assert from "node:assert/strict";
import test from "node:test";
import type { BookNote } from "../types/book.ts";
import {
  compareReadingLocations,
  normalizeReadingCfi,
  sortAnnotationsByReadingOrder,
} from "./annotation-order.ts";

function note(
  id: string,
  cfi: string,
  createdAt: number,
): BookNote {
  return {
    id,
    type: "annotation",
    cfi,
    text: id,
    note: id,
    createdAt,
    updatedAt: createdAt,
  };
}

test("puts page 1 above page 2 even when page 2 completed first", () => {
  const page2 = note("page-2", "epubcfi(/6/4!/4/2/2:0)", 100);
  const page1 = note("page-1", "epubcfi(/6/2!/4/2/2:0)", 900);
  assert.deepEqual(
    sortAnnotationsByReadingOrder([page2, page1]).map((item) => item.id),
    ["page-1", "page-2"],
  );
});

test("keeps earlier body text above later body text in one section", () => {
  const later = note("later", "epubcfi(/6/2!/4/10/2:0)", 100);
  const earlier = note("earlier", "epubcfi(/6/2!/4/2/2:0)", 900);
  assert.deepEqual(
    sortAnnotationsByReadingOrder([later, earlier]).map((item) => item.id),
    ["earlier", "later"],
  );
});

test("uses section index and CFI numerically rather than lexicographically", () => {
  assert.ok(
    compareReadingLocations(
      { sectionIndex: 1, cfi: "epubcfi(/6/4!/4/10/2:0)" },
      { sectionIndex: 2, cfi: "epubcfi(/6/2!/4/2/2:0)" },
    )! < 0,
  );
  assert.ok(
    compareReadingLocations(
      { sectionIndex: 1, cfi: "epubcfi(/6/4!/4/10/2:0)" },
      { sectionIndex: 1, cfi: "epubcfi(/6/4!/4/2/2:0)" },
    )! > 0,
  );
});

test("uses creation time and id only when location cannot distinguish records", () => {
  const cfi = "epubcfi(/6/2!/4/2/2:0)";
  const records = [
    note("b", cfi, 200),
    note("c", cfi, 100),
    note("a", cfi, 200),
  ];
  assert.deepEqual(
    sortAnnotationsByReadingOrder(records).map((item) => item.id),
    ["c", "a", "b"],
  );
});

test("handles missing or invalid CFI explicitly without throwing", () => {
  assert.equal(normalizeReadingCfi("not-a-cfi"), null);
  assert.equal(normalizeReadingCfi("epubcfi(test)"), null);
  const valid = note("valid", "epubcfi(/6/2!/4/2/2:0)", 900);
  const invalid = note("invalid", "not-a-cfi", 100);
  assert.deepEqual(
    sortAnnotationsByReadingOrder([invalid, valid]).map((item) => item.id),
    ["valid", "invalid"],
  );
});

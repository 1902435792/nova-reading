import assert from "node:assert/strict";
import test from "node:test";
import {
  CO_READING_DIARY_PATH,
  buildCoReadingDiaryHeaders,
  buildCoReadingDiaryRequest,
  resolveCoReadingDiaryEndpoint,
} from "./co-reading-diary-request.ts";
import type { CoReadingDiaryPayload } from "./co-reading-diary.ts";

const payload: CoReadingDiaryPayload = {
  bookTitle: "测试书",
  currentDate: "2026-07-13",
  currentTime: "09:05",
  selectedCount: 1,
  entries: [
    {
      originalText: "原文",
      text: "原文",
      aiComment: "评论",
      comment: "评论",
      summary: "摘要",
      section: "第三章",
      sectionLabel: "第三章",
      sectionIndex: 2,
      position: "epubcfi(test)",
      cfi: "epubcfi(test)",
      page: null,
      task: "task",
      time: 20,
      createdAt: 20,
    },
  ],
};

test("normalizes every supported provider base URL to the diary domain route", () => {
  for (const baseUrl of [
    "http://127.0.0.1:3100",
    "http://127.0.0.1:3100/",
    "http://127.0.0.1:3100/v1",
    "http://127.0.0.1:3100/v1/deepreader",
    "http://127.0.0.1:3100/v1/deepreader-assistant/chat/completions?old=1#hash",
  ]) {
    assert.equal(resolveCoReadingDiaryEndpoint(baseUrl), `http://127.0.0.1:3100${CO_READING_DIARY_PATH}`);
  }
});

test("rejects non-HTTP provider base URLs", () => {
  assert.throws(() => resolveCoReadingDiaryEndpoint("file:///tmp/api"), /HTTP/);
  assert.throws(() => resolveCoReadingDiaryEndpoint("not a url"), /无效/);
});

test("builds the Bridge domain payload with the configured model and no chat envelope", () => {
  const request = buildCoReadingDiaryRequest(payload, "model-id");
  assert.equal(request.model, "model-id");
  assert.deepEqual(request.entries, payload.entries);
  assert.equal(request.selectedCount, request.entries.length);
  assert.equal("messages" in request, false);
  assert.equal("userExplicitlyTriggered" in request, false);
});

test("rejects mismatched selectedCount before sending", () => {
  assert.throws(() => buildCoReadingDiaryRequest({ ...payload, selectedCount: 2 }, "model-id"), /记录数/);
});

test("uses only the provider API key for the Bearer header", () => {
  const headers = buildCoReadingDiaryHeaders("  provider-secret  ");
  assert.deepEqual(headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer provider-secret",
  });
  assert.throws(() => buildCoReadingDiaryHeaders("  "), /API Key/);
});

import assert from "node:assert/strict";
import test from "node:test";

import { parseConfirmedVcpCoReadingDiaryResponse } from "./co-reading-diary-response";

test("accepts only a non-empty VCP result with a server-confirmed identity", () => {
  assert.deepEqual(
    parseConfirmedVcpCoReadingDiaryResponse({
      id: "vcp-request-1",
      status: "success",
      generationSucceeded: true,
      dailyNoteWritten: true,
      choices: [{ message: { content: " 已写入 DailyNote " } }],
    }),
    { diaryId: "vcp-request-1", message: "已写入 DailyNote" }
  );
});

test("malformed VCP success responses cannot advance the local ledger", () => {
  assert.throws(
    () => parseConfirmedVcpCoReadingDiaryResponse(null),
    /未返回明确的写入结果/
  );
  assert.throws(
    () =>
      parseConfirmedVcpCoReadingDiaryResponse({
        id: "vcp-request-1",
        choices: [{ message: { content: " " } }],
      }),
    /未返回明确的写入结果/
  );
  assert.throws(
    () =>
      parseConfirmedVcpCoReadingDiaryResponse({
        choices: [{ message: { content: "已写入" } }],
      }),
    /未明确确认日记生成与 DailyNote 写入均成功/
  );
  assert.throws(
    () =>
      parseConfirmedVcpCoReadingDiaryResponse({
        id: "vcp-request-1",
        status: "success",
        generationSucceeded: true,
        dailyNoteWritten: false,
        choices: [{ message: { content: "已写入" } }],
      }),
    /未明确确认日记生成与 DailyNote 写入均成功/
  );
  assert.throws(
    () =>
      parseConfirmedVcpCoReadingDiaryResponse({
        status: "success",
        generationSucceeded: true,
        dailyNoteWritten: true,
        choices: [{ message: { content: "已写入" } }],
      }),
    /未返回可确认的日记\/请求 ID/
  );
});

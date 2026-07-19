export interface VcpCoReadingDiaryResponse {
  status?: string;
  generationSucceeded?: boolean;
  dailyNoteWritten?: boolean;
  id?: string;
  requestId?: string;
  diaryId?: string;
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export interface ConfirmedVcpCoReadingDiaryResponse {
  diaryId: string;
  message: string;
}

/**
 * Requires both a non-empty VCP completion and a server-confirmed request or
 * diary identity. The local ledger must never be advanced from a guessed ID.
 */
export function parseConfirmedVcpCoReadingDiaryResponse(
  body: VcpCoReadingDiaryResponse | null
): ConfirmedVcpCoReadingDiaryResponse {
  const message = body?.choices?.[0]?.message?.content?.trim();
  if (!body || !message) {
    throw new Error("VCP 共读 Agent 未返回明确的写入结果");
  }
  if (
    body.status !== "success" ||
    body.generationSucceeded !== true ||
    body.dailyNoteWritten !== true
  ) {
    throw new Error("VCP 共读 Agent 未明确确认日记生成与 DailyNote 写入均成功");
  }

  const diaryId =
    body.diaryId?.trim() || body.requestId?.trim() || body.id?.trim();
  if (!diaryId) {
    throw new Error("VCP 共读 Agent 未返回可确认的日记/请求 ID");
  }

  return { diaryId, message };
}

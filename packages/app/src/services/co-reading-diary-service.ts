import type { CoReadingDiaryPayload } from "@/lib/co-reading-diary";
import {
  buildCoReadingDiaryHeaders,
  buildCoReadingDiaryRequest,
  resolveCoReadingDiaryEndpoint,
} from "@/lib/co-reading-diary-request";
import {
  parseConfirmedVcpCoReadingDiaryResponse,
  type VcpCoReadingDiaryResponse,
} from "@/lib/co-reading-diary-response";
import { markCoReadingDiaryWritten } from "@/services/co-reading-service";
import { useProviderStore } from "@/store/provider-store";
import { fetch as fetchTauri } from "@tauri-apps/plugin-http";

const CO_READING_DIARY_TIMEOUT_MS = 120_000;

export interface CoReadingDiaryWriteResult {
  message: string;
  diaryId: string;
  writtenCount: number;
}

export async function createCoReadingDiary(
  bookId: string,
  payload: CoReadingDiaryPayload,
): Promise<CoReadingDiaryWriteResult> {
  const state = useProviderStore.getState();
  const selected = state.selectedModel;
  if (!selected) throw new Error("请先在问答 Agent 中选择可用模型");

  const provider = state.modelProviders.find(
    (item) => item.provider === selected.providerId && item.active,
  );
  const model = provider?.models.find(
    (item) => item.id === selected.modelId && item.active !== false,
  );
  const baseUrl = provider?.baseUrl?.trim();
  const apiKey = provider?.apiKey?.trim();
  if (!provider || !model || !baseUrl || !apiKey) {
    throw new Error("问答 Agent 当前模型不可用，或缺少服务地址/API Key");
  }

  const response = await fetchTauri(resolveCoReadingDiaryEndpoint(baseUrl), {
    method: "POST",
    headers: buildCoReadingDiaryHeaders(apiKey),
    body: JSON.stringify(buildCoReadingDiaryRequest(payload, selected.modelId)),
    signal: AbortSignal.timeout(CO_READING_DIARY_TIMEOUT_MS),
  });
  const body = (await response
    .json()
    .catch(() => null)) as VcpCoReadingDiaryResponse | null;

  if (!response.ok) {
    throw new Error(
      body?.error?.message?.trim() ||
        `VCP 共读 Agent 写入失败（HTTP ${response.status}）`,
    );
  }

  // Parsing must succeed before touching the local ledger. In particular, a
  // malformed 2xx response must not be upgraded into success by a local ID.
  const confirmed = parseConfirmedVcpCoReadingDiaryResponse(body);
  try {
    const ledger = await markCoReadingDiaryWritten({
      bookId,
      diaryId: confirmed.diaryId,
      sourceKeys: payload.sourceKeys,
    });
    return {
      message: confirmed.message,
      diaryId: ledger.diaryId,
      writtenCount: ledger.writtenCount,
    };
  } catch (error) {
    throw new Error(
      `VCP 已返回写入成功，但本地来源账本更新失败；请先刷新记录，避免立即重复写入。${
        error instanceof Error ? ` ${error.message}` : ""
      }`,
      { cause: error },
    );
  }
}

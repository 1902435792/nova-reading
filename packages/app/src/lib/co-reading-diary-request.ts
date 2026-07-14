import type { CoReadingDiaryPayload } from "./co-reading-diary.ts";

export const CO_READING_DIARY_PATH = "/v1/deepreader-coreading-diary";

export function resolveCoReadingDiaryEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error("当前模型缺少可用的服务地址");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("当前模型的服务地址无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("当前模型的服务地址必须使用 HTTP(S)");
  url.pathname = CO_READING_DIARY_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function buildCoReadingDiaryRequest(
  payload: CoReadingDiaryPayload,
  model: string,
): CoReadingDiaryPayload & {
  model: string;
} {
  const modelId = model.trim();
  if (!modelId) throw new Error("当前模型缺少可用的模型 ID");
  if (payload.selectedCount !== payload.entries.length) throw new Error("共读日记记录数与内容不一致");
  return { ...payload, model: modelId };
}

export function buildCoReadingDiaryHeaders(apiKey: string): Record<string, string> {
  const providerApiKey = apiKey.trim();
  if (!providerApiKey) throw new Error("当前模型缺少可用的 API Key");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${providerApiKey}`,
  };
}

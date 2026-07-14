import type { CoReadingDiaryPayload } from "@/lib/co-reading-diary";
import {
  buildCoReadingDiaryHeaders,
  buildCoReadingDiaryRequest,
  resolveCoReadingDiaryEndpoint,
} from "@/lib/co-reading-diary-request";
import { resolveCoReadingModel } from "@/lib/co-reading-model";
import { useProviderStore } from "@/store/provider-store";
import type { CoReadingSettings } from "@/types/co-reading";
import { fetch as fetchTauri } from "@tauri-apps/plugin-http";

interface VcpDiaryResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export async function createCoReadingDiary(
  data: CoReadingDiaryPayload,
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null,
): Promise<string> {
  const state = useProviderStore.getState();
  const selected = resolveCoReadingModel(settings, state.selectedModel, state.modelProviders);
  if (!selected) throw new Error("请先配置并选择 VCP 模型");

  const provider = state.modelProviders.find((item) => item.provider === selected.providerId);
  const baseUrl = provider?.baseUrl?.trim();
  const apiKey = provider?.apiKey?.trim();
  if (!baseUrl || !apiKey) throw new Error("当前模型缺少可用的服务地址或 API Key");

  const response = await fetchTauri(resolveCoReadingDiaryEndpoint(baseUrl), {
    method: "POST",
    headers: buildCoReadingDiaryHeaders(apiKey),
    body: JSON.stringify(buildCoReadingDiaryRequest(data, selected.modelId)),
  });
  const body = (await response.json().catch(() => null)) as VcpDiaryResponse | null;

  if (!response.ok) {
    throw new Error(body?.error?.message?.trim() || `共读日记写入失败（HTTP ${response.status}）`);
  }

  const message = body?.choices?.[0]?.message?.content?.trim();
  if (!message) throw new Error("共读日记服务未返回结果");
  return message;
}

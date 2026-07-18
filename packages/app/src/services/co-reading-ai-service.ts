import { createModelInstance } from "@/ai/providers/factory";
import { getCoReadingErrorInfo } from "@/lib/co-reading-core";
import { resolveCoReadingModel } from "@/lib/co-reading-model";
import { combineAbortSignals } from "@/lib/co-reading-run-state";
import { useProviderStore } from "@/store/provider-store";
import type {
  CoReadingBatch,
  CoReadingBatchDecision,
  CoReadingDecision,
  CoReadingItemResult,
  CoReadingReviewInput,
  CoReadingReviewResult,
  CoReadingSettings,
} from "@/types/co-reading";
import { NoObjectGeneratedError, generateObject } from "ai";
import {
  coReadingBatchDecisionSchema,
  coReadingDecisionSchema,
  coReadingItemResultSchema,
  coReadingReviewResultSchema,
  coReadingSelectionSchema,
  parseCoReadingBatchDecisionText,
  parseCoReadingDecisionText,
  parseCoReadingItemResultText,
  parseCoReadingReviewResultText,
  parseCoReadingSelectionText,
} from "./co-reading-decision-parser";

export {
  coReadingBatchDecisionSchema,
  coReadingDecisionSchema,
  coReadingItemResultSchema,
  coReadingReviewResultSchema,
  coReadingSelectionSchema,
  parseCoReadingBatchDecisionText,
  parseCoReadingDecisionText,
  parseCoReadingItemResultText,
  parseCoReadingReviewResultText,
  parseCoReadingSelectionText,
} from "./co-reading-decision-parser";

const STRUCTURED_REQUEST_MAX_ATTEMPTS = 2;
const STRUCTURED_REQUEST_RETRY_DELAY_MS = 800;

const SYSTEM_PROMPT = `你是与读者保持相同进度的 Nova。把 CURRENT_VISIBLE_FOCUS 当作当前完整可见页面或双页来读，不要孤立地逐句做阅读理解；结合 RECENT_READ_BLOCKS、ROLLING_SUMMARY 和 RECENT_AI_ANNOTATIONS 延续上一焦点的感受、判断与未决疑问。
默认不批注。只有当前整体脉络中真正值得停下的地方才留下 0–3 条 annotations；每条 blockKey 必须属于 CURRENT_VISIBLE_FOCUS，quote 必须逐字复制对应正文，comment 应像真实读者的页边想法，通常 30–220 个中文字符，不重复摘要、不预判后文。
summary 必须更新为有界的连续阅读摘要，保留已发生内容、关系或论证变化、重要意象及 Nova 尚未解决的问题；只依据已提供正文，不剧透。`;
function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal?.reason));
    const timer = globalThis.setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function createRequestSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  globalThis.setTimeout(
    () => controller.abort(new Error("共读请求超时")),
    timeoutMs
  );
  return controller.signal;
}

async function requestStructuredObject<T>(
  request: (abortSignal: AbortSignal) => Promise<T>,
  parseFallback: (text: string) => T,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt < STRUCTURED_REQUEST_MAX_ATTEMPTS;
    attempt += 1
  ) {
    externalSignal?.throwIfAborted();
    try {
      return await request(
        combineAbortSignals(createRequestSignal(timeoutMs), externalSignal)
      );
    } catch (error) {
      lastError = error;
      if (externalSignal?.aborted) throw error;
      if (
        NoObjectGeneratedError.isInstance(error) &&
        typeof error.text === "string"
      ) {
        try {
          return parseFallback(error.text);
        } catch {
          // Keep the original SDK error for stable error classification below.
        }
      }
      const info = getCoReadingErrorInfo(error);
      if (!info.retryable || attempt + 1 >= STRUCTURED_REQUEST_MAX_ATTEMPTS) {
        throw new Error(info.message, { cause: error });
      }
      await wait(STRUCTURED_REQUEST_RETRY_DELAY_MS, externalSignal);
      externalSignal?.throwIfAborted();
    }
  }
  throw lastError;
}

function serializeBlocks(blocks: CoReadingBatch["newBlocks"]): string {
  return blocks
    .map(
      (block) =>
        `<block key=${JSON.stringify(block.blockKey)} section=${JSON.stringify(
          block.sectionLabel
        )}>\n${block.text}\n</block>`
    )
    .join("\n");
}

function resolveRequestModel(
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null
) {
  const state = useProviderStore.getState();
  const selectedModel = resolveCoReadingModel(
    settings,
    state.selectedModel,
    state.modelProviders
  );
  if (!selectedModel) throw new Error("请先配置并选择可用模型");
  return createModelInstance(selectedModel.providerId, selectedModel.modelId);
}

export async function requestCoReadingItem(
  batch: CoReadingBatch,
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null,
  externalSignal?: AbortSignal
): Promise<CoReadingItemResult> {
  if (batch.newBlocks.length === 0) {
    throw new Error("页面共读请求必须包含当前可见正文");
  }
  const focusKeys = new Set(
    batch.newBlocks.map((block) => block.focusKey ?? block.blockKey)
  );
  if (focusKeys.size !== 1 || focusKeys.has("")) {
    throw new Error("页面共读请求只能包含一个可见焦点");
  }
  const pageTokens = batch.newBlocks.reduce(
    (sum, block) => sum + Math.ceil(block.text.length / 2) + 12,
    0
  );
  if (pageTokens > 5_000) {
    throw new Error(
      "当前可见页正文超过单次共读上下文预算，请调整字号或页面布局后重试"
    );
  }
  const model = resolveRequestModel(settings);
  const prompt = [
    "CURRENT_VISIBLE_FOCUS（当前完整可见页/双页；这些块合在一起是一个连续阅读单元）：",
    serializeBlocks(batch.newBlocks),
    "RECENT_READ_BLOCKS（上一阅读焦点，仅供脉络，不可作为批注落点）：",
    serializeBlocks(batch.recentBlocks.slice(0, 8)),
    `ROLLING_SUMMARY：\n${batch.rollingSummary || "（无）"}`,
    `RECENT_AI_ANNOTATIONS：\n${
      batch.annotations.slice(0, 8).join("\n") || "（无）"
    }`,
  ].join("\n\n");

  return requestStructuredObject(
    async (abortSignal) => {
      const result = await generateObject({
        model,
        schema: coReadingItemResultSchema,
        mode: "json",
        system:
          "请在 VCP Bridge Profile 既有人格与共读提示之上完成当前页面任务：完整阅读 CURRENT_VISIBLE_FOCUS，而不是逐段孤立判断；在同一次回答中自主决定是否留下 0–3 条最终书评。尽量不错过真正精彩、有变化、有回响、含混、情感压力或论证推进的位置，也不要为了数量强行评论。同一 blockKey 可以对应多条书评，但 quote 必须是各不相同且逐字来自该块的引文；每条 blockKey 必须属于当前焦点；summary 更新连续阅读脉络且不剧透。只返回严格 JSON：{summary,annotations}。",
        prompt,
        maxOutputTokens: 1_400,
        temperature: 0.2,
        maxRetries: 0,
        abortSignal,
      });
      return result.object;
    },
    parseCoReadingItemResultText,
    90_000,
    externalSignal
  );
}

export async function requestCoReadingReview(
  input: CoReadingReviewInput,
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null
): Promise<CoReadingReviewResult> {
  if (!input.text.trim()) throw new Error("下划线原文为空");
  const model = resolveRequestModel(settings);
  const prompt = [
    `UNDERLINED_TEXT：\n${input.text.slice(0, 4_000)}`,
    `CONTEXT_BEFORE：\n${input.contextBefore.slice(-2_000) || "（无）"}`,
    `CONTEXT_AFTER：\n${input.contextAfter.slice(0, 2_000) || "（无）"}`,
    `READER_NOTE：\n${input.humanNote.slice(0, 1_000) || "（无）"}`,
    `ROLLING_SUMMARY：\n${input.rollingSummary.slice(0, 2_000) || "（无）"}`,
    `RECENT_AI_ANNOTATIONS：\n${
      input.recentAiAnnotations.slice(0, 8).join("\n") || "（无）"
    }`,
  ].join("\n\n");

  return requestStructuredObject(
    async (abortSignal) => {
      const result = await generateObject({
        model,
        schema: coReadingReviewResultSchema,
        mode: "json",
        system:
          "你是正在与用户共读的 Nova。围绕用户主动划线的原文，结合上下文、用户想法和当前阅读脉络写一段有脉络、有判断、不过度总结且不剧透后文的书评。只返回严格 JSON：{review}。",
        prompt,
        maxOutputTokens: 900,
        temperature: 0.3,
        maxRetries: 0,
        abortSignal,
      });
      return result.object;
    },
    parseCoReadingReviewResultText,
    90_000
  );
}

export async function requestCoReadingSelection(
  candidates: CoReadingBatch["newBlocks"],
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const model = resolveRequestModel(settings);
  return requestStructuredObject(
    async (abortSignal) => {
      const result = await generateObject({
        model,
        schema: coReadingSelectionSchema,
        mode: "json",
        system:
          "你是 Nova。请像真实读者一样，从候选文本块中选出最多 6 个最值得细读的块。优先选择有具体动作、语气变化、意象、关系转折或论证关键点的块；不要为了凑数选择标题、目录或重复内容。只返回候选中存在的 blockKey。",
        prompt: `CANDIDATE_BLOCKS：\n${serializeBlocks(candidates)}`,
        maxOutputTokens: 300,
        temperature: 0,
        maxRetries: 0,
        abortSignal,
      });
      return result.object.selectedBlockKeys;
    },
    parseCoReadingSelectionText,
    45_000
  );
}

export async function requestCoReadingBatchDecision(
  batch: CoReadingBatch,
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null
): Promise<CoReadingBatchDecision> {
  if (batch.newBlocks.length === 0) throw new Error("没有可处理的已解锁文本块");
  const model = resolveRequestModel(settings);
  const prompt = [
    "CURRENT_VISIBLE_FOCUS（当前完整可见页/双页，可批注）：",
    serializeBlocks(batch.newBlocks),
    "RECENT_READ_BLOCKS（上一批已读，仅供脉络）：",
    serializeBlocks(batch.recentBlocks),
    `ROLLING_SUMMARY：\n${batch.rollingSummary || "（无）"}`,
    `RECENT_AI_ANNOTATIONS：\n${batch.annotations.join("\n") || "（无）"}`,
  ].join("\n\n");
  return requestStructuredObject(
    async (abortSignal) => {
      const result = await generateObject({
        model,
        schema: coReadingBatchDecisionSchema,
        mode: "json",
        system: SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: 1_400,
        temperature: 0.25,
        maxRetries: 0,
        abortSignal,
      });
      return result.object;
    },
    parseCoReadingBatchDecisionText,
    90_000
  );
}

export async function requestCoReadingDecision(
  batch: CoReadingBatch,
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null
): Promise<CoReadingDecision> {
  if (batch.newBlocks.length === 0) throw new Error("没有可处理的已解锁文本块");
  const model = resolveRequestModel(settings);
  const prompt = [
    "CURRENT_VISIBLE_FOCUS（当前完整可见页/双页，可用于批注）：",
    serializeBlocks(batch.newBlocks),
    "RECENT_READ_BLOCKS（仅供回顾，不可作为批注落点）：",
    serializeBlocks(batch.recentBlocks),
    `ROLLING_SUMMARY：\n${batch.rollingSummary || "（无）"}`,
    `RECENT_AI_ANNOTATIONS：\n${batch.annotations.join("\n") || "（无）"}`,
  ].join("\n\n");
  return requestStructuredObject(
    async (abortSignal) => {
      const result = await generateObject({
        model,
        schema: coReadingDecisionSchema,
        mode: "json",
        system: SYSTEM_PROMPT,
        prompt,
        maxOutputTokens: 600,
        temperature: 0,
        maxRetries: 0,
        abortSignal,
      });
      return result.object;
    },
    parseCoReadingDecisionText,
    60_000
  );
}

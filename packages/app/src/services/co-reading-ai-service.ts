import { createModelInstance } from "@/ai/providers/factory";
import { resolveCoReadingModel } from "@/lib/co-reading-model";
import { useProviderStore } from "@/store/provider-store";
import type { CoReadingBatch, CoReadingBatchDecision, CoReadingDecision, CoReadingSettings } from "@/types/co-reading";
import { NoObjectGeneratedError, generateObject } from "ai";
import { z } from "zod";
import { coReadingDecisionSchema, parseCoReadingDecisionText } from "./co-reading-decision-parser";

export {
  coReadingDecisionSchema,
  parseCoReadingDecisionText,
} from "./co-reading-decision-parser";

const coReadingSelectionSchema = z.object({ selectedBlockKeys: z.array(z.string()).max(6) }).strict();

const SYSTEM_PROMPT = `你是与读者保持相同进度的 Nova。把 NEW_BLOCKS 当作当前完整页面或连续阅读片段来读，不要孤立地逐句做阅读理解；结合 RECENT_READ_BLOCKS、ROLLING_SUMMARY 和 RECENT_AI_ANNOTATIONS 延续上一批的感受、判断与未决疑问。
默认不批注。只有当前整体脉络中真正值得停下的地方才留下 0–4 条 annotations；每条 blockKey 必须属于 NEW_BLOCKS，quote 必须逐字复制对应正文，comment 应像真实读者的页边想法，通常 30–220 个中文字符，不重复摘要、不预判后文。
summary 必须更新为有界的连续阅读摘要，保留已发生内容、关系或论证变化、重要意象及 Nova 尚未解决的问题；只依据已提供正文，不剧透。`;

function serializeBlocks(blocks: CoReadingBatch["newBlocks"]): string {
  return blocks
    .map(
      (block) =>
        `<block key=${JSON.stringify(block.blockKey)} section=${JSON.stringify(
          block.sectionLabel,
        )}>\n${block.text}\n</block>`,
    )
    .join("\n");
}

export async function requestCoReadingSelection(
  candidates: CoReadingBatch["newBlocks"],
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const state = useProviderStore.getState();
  const selectedModel = resolveCoReadingModel(settings, state.selectedModel, state.modelProviders);
  if (!selectedModel) throw new Error("请先配置并选择可用模型");
  const model = createModelInstance(selectedModel.providerId, selectedModel.modelId);
  const result = await generateObject({
    model,
    schema: coReadingSelectionSchema,
    mode: "json",
    system:
      "你是 Nova。请像真实读者一样，从候选文本块中选出最多 6 个最值得细读的块。优先选择有具体动作、语气变化、意象、关系转折或论证关键点的块；不要为了凑数选择标题、目录或重复内容。只返回候选中存在的 blockKey。",
    prompt: `CANDIDATE_BLOCKS：\n${serializeBlocks(candidates)}`,
    maxOutputTokens: 300,
    temperature: 0,
  });
  return result.object.selectedBlockKeys;
}

const coReadingBatchDecisionSchema = z
  .object({
    annotations: z
      .array(
        z
          .object({
            blockKey: z.string(),
            quote: z.string(),
            comment: z.string(),
          })
          .strict(),
      )
      .max(4),
    summary: z.string(),
  })
  .strict();

export async function requestCoReadingBatchDecision(
  batch: CoReadingBatch,
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null,
): Promise<CoReadingBatchDecision> {
  const state = useProviderStore.getState();
  const selectedModel = resolveCoReadingModel(settings, state.selectedModel, state.modelProviders);
  if (!selectedModel) throw new Error("请先配置并选择可用模型");
  if (batch.newBlocks.length === 0) throw new Error("没有可处理的已解锁文本块");
  const model = createModelInstance(selectedModel.providerId, selectedModel.modelId);
  const prompt = [
    "CURRENT_READING_BUNDLE（当前整页/连续片段，可批注）：",
    serializeBlocks(batch.newBlocks),
    "RECENT_READ_BLOCKS（上一批已读，仅供脉络）：",
    serializeBlocks(batch.recentBlocks),
    `ROLLING_SUMMARY：\n${batch.rollingSummary || "（无）"}`,
    `RECENT_AI_ANNOTATIONS：\n${batch.annotations.join("\n") || "（无）"}`,
  ].join("\n\n");
  const result = await generateObject({
    model,
    schema: coReadingBatchDecisionSchema,
    mode: "json",
    system: SYSTEM_PROMPT,
    prompt,
    maxOutputTokens: 1_400,
    temperature: 0.25,
  });
  return result.object;
}

export async function requestCoReadingDecision(
  batch: CoReadingBatch,
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null,
): Promise<CoReadingDecision> {
  const state = useProviderStore.getState();
  const selectedModel = resolveCoReadingModel(settings, state.selectedModel, state.modelProviders);
  if (!selectedModel) throw new Error("请先配置并选择可用模型");
  if (batch.newBlocks.length === 0) throw new Error("没有可处理的已解锁文本块");

  // Credentials come from provider store at call time; book settings only store ids.
  const model = createModelInstance(selectedModel.providerId, selectedModel.modelId);
  const prompt = [
    "NEW_BLOCKS（本批新解锁，可用于批注）：",
    serializeBlocks(batch.newBlocks),
    "RECENT_READ_BLOCKS（仅供回顾，不可作为批注落点）：",
    serializeBlocks(batch.recentBlocks),
    `ROLLING_SUMMARY：\n${batch.rollingSummary || "（无）"}`,
    `RECENT_AI_ANNOTATIONS：\n${batch.annotations.join("\n") || "（无）"}`,
  ].join("\n\n");

  try {
    const result = await generateObject({
      model,
      schema: coReadingDecisionSchema,
      mode: "json",
      system: SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: 600,
      temperature: 0,
    });
    return result.object;
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error) || typeof error.text !== "string") throw error;
    try {
      return parseCoReadingDecisionText(error.text);
    } catch {
      throw error;
    }
  }
}

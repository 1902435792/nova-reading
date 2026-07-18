import { z } from "zod";
import type {
  CoReadingBatchDecision,
  CoReadingDecision,
  CoReadingItemResult,
  CoReadingReviewResult,
} from "../types/co-reading.ts";

export const coReadingDecisionSchema = z
  .object({
    action: z.enum(["silent", "annotate"]),
    blockKey: z.string().nullable(),
    quote: z.string(),
    comment: z.string(),
    summary: z.string(),
  })
  .strict();

export const coReadingSelectionSchema = z
  .object({ selectedBlockKeys: z.array(z.string()).max(6) })
  .strict();

export const coReadingBatchDecisionSchema = z
  .object({
    annotations: z
      .array(
        z
          .object({
            blockKey: z.string(),
            quote: z.string(),
            comment: z.string(),
          })
          .strict()
      )
      .max(4),
    summary: z.string(),
  })
  .strict();

export const coReadingItemResultSchema = z
  .object({
    summary: z.string().trim().max(2_000),
    annotations: z
      .array(
        z
          .object({
            blockKey: z.string().trim().min(1),
            quote: z.string().trim().min(1).max(1_200),
            comment: z.string().trim().min(1).max(500),
          })
          .strict()
      )
      .max(3),
  })
  .strict();

export const coReadingReviewResultSchema = z
  .object({
    review: z.string().trim().min(1).max(2_000),
  })
  .strict();

const SAFE_SILENT_KEYS = ["blockKey", "quote", "comment", "summary"] as const;
const TOOL_REQUEST_PATTERN = /<<<\s*\[?TOOL_REQUEST\]?\s*>>>/iu;

function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  if (depth !== 0 || inString) throw new Error("模型返回的 JSON 不完整");
  return objects;
}

/**
 * Structured-output fallback for providers that wrap one JSON object in prose or
 * a Markdown fence. Multiple objects and tool requests remain fail-closed.
 */
export function parseUniqueCoReadingJson<T>(
  text: string,
  schema: z.ZodType<T>
): T {
  const normalized = String(text || "").trim();
  if (!normalized || TOOL_REQUEST_PATTERN.test(normalized)) {
    throw new Error("模型未返回可用的共读 JSON");
  }
  const candidates = extractJsonObjects(normalized);
  if (candidates.length !== 1) {
    throw new Error("模型必须只返回一个共读 JSON 对象");
  }
  return schema.parse(JSON.parse(candidates[0]));
}

export function parseCoReadingSelectionText(text: string): string[] {
  return parseUniqueCoReadingJson(text, coReadingSelectionSchema)
    .selectedBlockKeys;
}

export function parseCoReadingBatchDecisionText(
  text: string
): CoReadingBatchDecision {
  return parseUniqueCoReadingJson(text, coReadingBatchDecisionSchema);
}

export function parseCoReadingItemResultText(
  text: string
): CoReadingItemResult {
  return parseUniqueCoReadingJson(text, coReadingItemResultSchema);
}

export function parseCoReadingReviewResultText(
  text: string
): CoReadingReviewResult {
  return parseUniqueCoReadingJson(text, coReadingReviewResultSchema);
}

export function parseCoReadingDecisionText(text: string): CoReadingDecision {
  const value = parseUniqueCoReadingJson(
    text,
    z.record(z.string(), z.unknown())
  );
  if (!("action" in value)) {
    const keys = Object.keys(value);
    const isExactSafeSilentShape =
      keys.length === SAFE_SILENT_KEYS.length &&
      keys.every((key) =>
        SAFE_SILENT_KEYS.includes(key as (typeof SAFE_SILENT_KEYS)[number])
      ) &&
      value.blockKey === null &&
      value.quote === "" &&
      value.comment === "" &&
      typeof value.summary === "string";
    if (isExactSafeSilentShape) {
      return coReadingDecisionSchema.parse({ action: "silent", ...value });
    }
  }
  return coReadingDecisionSchema.parse(value);
}

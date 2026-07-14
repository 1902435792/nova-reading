import { z } from "zod";
import type { CoReadingDecision } from "../types/co-reading.ts";

export const coReadingDecisionSchema = z
  .object({
    action: z.enum(["silent", "annotate"]),
    blockKey: z.string().nullable(),
    quote: z.string(),
    comment: z.string(),
    summary: z.string(),
  })
  .strict();

const SAFE_SILENT_KEYS = ["blockKey", "quote", "comment", "summary"] as const;

export function parseCoReadingDecisionText(text: string): CoReadingDecision {
  const value: unknown = JSON.parse(text);
  if (value && typeof value === "object" && !Array.isArray(value) && !("action" in value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const isExactSafeSilentShape =
      keys.length === SAFE_SILENT_KEYS.length &&
      keys.every((key) => SAFE_SILENT_KEYS.includes(key as (typeof SAFE_SILENT_KEYS)[number])) &&
      record.blockKey === null &&
      record.quote === "" &&
      record.comment === "" &&
      typeof record.summary === "string";
    if (isExactSafeSilentShape) {
      return coReadingDecisionSchema.parse({ action: "silent", ...record });
    }
  }
  return coReadingDecisionSchema.parse(value);
}

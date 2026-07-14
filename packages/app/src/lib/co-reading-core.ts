import type {
  CoReadingBatch,
  CoReadingBatchDecision,
  CoReadingBlock,
  CoReadingDecision,
  ValidatedCoReadingDecision,
} from "../types/co-reading.ts";

const TOTAL_INPUT_BUDGET = 5_000;
const SYSTEM_BUDGET = 700;
const SAFETY_BUDGET = 200;
const NEW_BLOCK_BUDGET = 2_400;
const RECENT_BLOCK_BUDGET = 1_200;
const SUPPLEMENTAL_BUDGET = TOTAL_INPUT_BUDGET - SYSTEM_BUDGET - SAFETY_BUDGET - NEW_BLOCK_BUDGET - RECENT_BLOCK_BUDGET;

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const LATIN_PATTERN = /[\p{L}\p{N}]/u;

export function sanitizeCoReadingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|secret|token)\s*[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .slice(0, 1_000);
}

export function mergeTrackedCoReadingState(
  local: {
    dwellMs: number;
    status: "tracking" | "queued";
    unlockedAt: number | null;
  },
  persisted: CoReadingBlock,
): {
  dwellMs: number;
  status: "tracking" | "queued";
  unlockedAt: number | null;
} {
  return {
    dwellMs: Math.max(local.dwellMs, persisted.dwellMs),
    status: local.status === "queued" || persisted.status === "queued" ? "queued" : "tracking",
    unlockedAt: local.unlockedAt ?? persisted.unlockedAt,
  };
}

export function estimateTokens(text: string): number {
  let tokens = 0;
  let latinRun = 0;

  const flushLatin = () => {
    if (latinRun > 0) {
      tokens += Math.ceil(latinRun / 4);
      latinRun = 0;
    }
  };

  for (const character of text) {
    if (CJK_PATTERN.test(character)) {
      flushLatin();
      tokens += 1;
    } else if (LATIN_PATTERN.test(character)) {
      latinRun += 1;
    } else {
      flushLatin();
      if (!/\s/u.test(character)) tokens += 1;
    }
  }
  flushLatin();
  return tokens;
}

function maxEndWithinTokenBudget(text: string, start: number, budget: number): number {
  let low = start + 1;
  let high = text.length;
  let best = low;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokens(text.slice(start, middle)) <= budget) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

export function splitTextOffsets(
  text: string,
  targetTokens = 600,
  maxTokens = 1_200,
): Array<{ start: number; end: number }> {
  if (!text) return [];
  if (estimateTokens(text) <= maxTokens) return [{ start: 0, end: text.length }];

  const offsets: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < text.length) {
    const maxEnd = maxEndWithinTokenBudget(text, start, maxTokens);
    if (maxEnd >= text.length) {
      offsets.push({ start, end: text.length });
      break;
    }

    const preferredStart = maxEndWithinTokenBudget(text, start, targetTokens);
    const window = text.slice(preferredStart, maxEnd);
    const sentenceBoundary = Math.max(
      window.lastIndexOf("。"),
      window.lastIndexOf("！"),
      window.lastIndexOf("？"),
      window.lastIndexOf("."),
      window.lastIndexOf("!"),
      window.lastIndexOf("?"),
    );
    const end = sentenceBoundary >= 0 ? preferredStart + sentenceBoundary + 1 : maxEnd;
    offsets.push({ start, end });
    start = end;
  }
  return offsets;
}

function takeWholeBlocks(blocks: CoReadingBlock[], budget: number): CoReadingBlock[] {
  const selected: CoReadingBlock[] = [];
  let used = 0;
  for (const block of blocks) {
    const cost = estimateTokens(block.text) + 12;
    if (used + cost > budget) break;
    selected.push(block);
    used += cost;
  }
  return selected;
}

function takeTextWithinBudget(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low).trimEnd();
}

export function buildCoReadingBatch(input: {
  queued: CoReadingBlock[];
  recent: CoReadingBlock[];
  rollingSummary: string;
  annotations: string[];
}): CoReadingBatch {
  const newBlocks = takeWholeBlocks(
    input.queued.filter((block) => block.status === "queued"),
    NEW_BLOCK_BUDGET,
  );
  const recentBlocks = takeWholeBlocks(
    input.recent.filter((block) => block.status === "silent" || block.status === "annotated"),
    RECENT_BLOCK_BUDGET,
  );

  const rollingSummary = takeTextWithinBudget(input.rollingSummary, Math.floor(SUPPLEMENTAL_BUDGET * 0.6));
  const annotationBudget = SUPPLEMENTAL_BUDGET - estimateTokens(rollingSummary);
  const annotations: string[] = [];
  let annotationTokens = 0;
  for (const annotation of input.annotations) {
    const cost = estimateTokens(annotation);
    if (annotationTokens + cost > annotationBudget) break;
    annotations.push(annotation);
    annotationTokens += cost;
  }

  const estimatedInputTokens =
    SYSTEM_BUDGET +
    SAFETY_BUDGET +
    newBlocks.reduce((sum, block) => sum + estimateTokens(block.text) + 12, 0) +
    recentBlocks.reduce((sum, block) => sum + estimateTokens(block.text) + 12, 0) +
    estimateTokens(rollingSummary) +
    annotationTokens;

  return {
    newBlocks,
    recentBlocks,
    rollingSummary,
    annotations,
    estimatedInputTokens,
  };
}

export function validateCoReadingBatchDecision(
  decision: CoReadingBatchDecision,
  claimedBlocks: CoReadingBlock[],
  maxAnnotations = 4,
): {
  annotations: Array<{ block: CoReadingBlock; quote: string; comment: string }>;
  summary: string;
} {
  const summary = decision.summary.trim().slice(0, 2_000);
  const seenBlocks = new Set<string>();
  const annotations = decision.annotations.slice(0, maxAnnotations).map((item) => {
    const block = claimedBlocks.find((candidate) => candidate.blockKey === item.blockKey);
    if (!block || seenBlocks.has(item.blockKey)) throw new Error("批量批注包含无效或重复文本块");
    const quote = item.quote.trim();
    const comment = item.comment.trim();
    if (!quote || !comment || !block.text.includes(quote)) throw new Error("批量批注引文必须逐字来自对应正文块");
    seenBlocks.add(item.blockKey);
    return { block, quote, comment: comment.slice(0, 500) };
  });
  return { annotations, summary };
}

export function validateCoReadingDecision(
  decision: CoReadingDecision,
  claimedBlocks: CoReadingBlock[],
): ValidatedCoReadingDecision {
  const summary = decision.summary.trim().slice(0, 2_000);
  if (decision.action === "silent") {
    if (decision.blockKey || decision.quote.trim() || decision.comment.trim()) {
      return { ok: false, error: "沉默决定不能包含批注内容" };
    }
    return { ok: true, action: "silent", summary };
  }

  const block = claimedBlocks.find((candidate) => candidate.blockKey === decision.blockKey);
  if (!block) return { ok: false, error: "模型选择了本批之外的文本块" };

  const quote = decision.quote.trim();
  const comment = decision.comment.trim();
  if (!quote || !comment) return { ok: false, error: "批注必须包含逐字引文和短评" };
  if (!block.text.includes(quote)) return { ok: false, error: "模型引文不是已解锁原文的逐字子串" };

  return {
    ok: true,
    action: "annotate",
    block,
    quote,
    comment: comment.slice(0, 500),
    summary,
  };
}

import type {
  CoReadingBatch,
  CoReadingBatchDecision,
  CoReadingBlock,
  CoReadingDecision,
  CoReadingItemResult,
  CoReadingReviewResult,
  ValidatedCoReadingDecision,
  ValidatedCoReadingItemResult,
} from "../types/co-reading.ts";

const TOTAL_INPUT_BUDGET = 5_000;
const SYSTEM_BUDGET = 700;
const SAFETY_BUDGET = 200;
const NEW_BLOCK_BUDGET = 2_400;
const RECENT_BLOCK_BUDGET = 1_200;
const SUPPLEMENTAL_BUDGET =
  TOTAL_INPUT_BUDGET -
  SYSTEM_BUDGET -
  SAFETY_BUDGET -
  NEW_BLOCK_BUDGET -
  RECENT_BLOCK_BUDGET;

export const CO_READING_BATCH_MAX_BLOCKS = 6;

const CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const LATIN_PATTERN = /[\p{L}\p{N}]/u;

export interface CoReadingErrorInfo {
  message: string;
  fatal: boolean;
  retryable: boolean;
  kind:
    | "balance"
    | "auth"
    | "profile"
    | "rate-limit"
    | "timeout"
    | "network"
    | "format"
    | "unknown";
}

function redactCoReadingError(message: string): string {
  return message
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|secret|token)\s*[=:]\s*)[^\s,;]+/giu,
      "$1[REDACTED]"
    )
    .slice(0, 1_000);
}

export function getCoReadingErrorInfo(error: unknown): CoReadingErrorInfo {
  const raw = redactCoReadingError(
    error instanceof Error ? error.message : String(error)
  );
  const normalized = raw.toLowerCase();
  if (
    /insufficient account balance|insufficient quota|credit balance|余额不足|额度不足/u.test(
      normalized
    )
  ) {
    return {
      message: "模型服务额度不足，请充值或切换可用模型后重试。",
      fatal: true,
      retryable: false,
      kind: "balance",
    };
  }
  if (
    /native_placeholder_unresolved|vcp native placeholder could not be expanded|原生占位符.*(?:未展开|无法展开)|(?:未展开|无法展开).*原生占位符/u.test(
      normalized
    )
  ) {
    return {
      message:
        "VCP Bridge Prompt 仍有未展开的原生占位符，请检查 Profile、Prompt 与 VCP 变量配置后重试。",
      fatal: true,
      retryable: false,
      kind: "profile",
    };
  }
  if (
    /requested bridge profile does not exist|profile_not_found|bridge profile.*not exist|profile.*不存在/u.test(
      normalized
    )
  ) {
    return {
      message:
        "VCP Bridge Profile 不存在，请检查模型前缀或在 VCPBridgeServer 中创建对应 Profile。",
      fatal: true,
      retryable: false,
      kind: "profile",
    };
  }
  if (
    /\b401\b|\b403\b|unauthorized|forbidden|invalid.*(?:api.?key|token)|authentication|认证失败/u.test(
      normalized
    )
  ) {
    return {
      message: "模型服务认证失败，请检查 API Key 与 VCP Bridge 配置。",
      fatal: true,
      retryable: false,
      kind: "auth",
    };
  }
  if (/\b429\b|rate.?limit|too many requests|请求过于频繁/u.test(normalized)) {
    return {
      message: "模型服务请求过于频繁，请稍后重试。",
      fatal: false,
      retryable: true,
      kind: "rate-limit",
    };
  }
  if (/timeout|timed out|aborterror|超时/u.test(normalized)) {
    return {
      message: "共读请求超时，请检查网络或切换响应更快的模型后重试。",
      fatal: false,
      retryable: true,
      kind: "timeout",
    };
  }
  if (
    /fetch failed|network|socket|econn|connection|连接失败/u.test(normalized)
  ) {
    return {
      message: "无法连接模型服务，请确认 VCP Bridge 与网络可用后重试。",
      fatal: false,
      retryable: true,
      kind: "network",
    };
  }
  if (
    /no object generated|did not match schema|did not return a response|json|schema|模型未返回/u.test(
      normalized
    )
  ) {
    return {
      message:
        "模型未返回符合要求的共读 JSON，已停止当前小批；可以重试或切换模型。",
      fatal: false,
      retryable: true,
      kind: "format",
    };
  }
  return {
    message: raw || "共读处理失败，请重试。",
    fatal: false,
    retryable: false,
    kind: "unknown",
  };
}

export function sanitizeCoReadingError(error: unknown): string {
  return getCoReadingErrorInfo(error).message;
}

export interface CoReadingFailureGroup extends CoReadingErrorInfo {
  focusCount: number;
  blockCount: number;
}

export function groupCoReadingFailures(
  blocks: Array<Pick<CoReadingBlock, "blockKey" | "focusKey" | "error">>
): CoReadingFailureGroup[] {
  const groups = new Map<
    string,
    CoReadingErrorInfo & { focusKeys: Set<string>; blockCount: number }
  >();
  for (const block of blocks) {
    const info = getCoReadingErrorInfo(block.error ?? "共读处理失败");
    const key = `${info.kind}:${info.message}`;
    const current = groups.get(key) ?? {
      ...info,
      focusKeys: new Set<string>(),
      blockCount: 0,
    };
    current.focusKeys.add(block.focusKey?.trim() || block.blockKey);
    current.blockCount += 1;
    groups.set(key, current);
  }
  return [...groups.values()]
    .map(({ focusKeys, ...group }) => ({
      ...group,
      focusCount: focusKeys.size,
    }))
    .sort(
      (left, right) =>
        right.focusCount - left.focusCount || right.blockCount - left.blockCount
    );
}

export function mergeTrackedCoReadingState(
  local: {
    dwellMs: number;
    status: "tracking" | "queued";
    unlockedAt: number | null;
  },
  persisted: CoReadingBlock
): {
  dwellMs: number;
  status: "tracking" | "queued";
  unlockedAt: number | null;
} {
  return {
    dwellMs: Math.max(local.dwellMs, persisted.dwellMs),
    status:
      local.status === "queued" || persisted.status === "queued"
        ? "queued"
        : "tracking",
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

function maxEndWithinTokenBudget(
  text: string,
  start: number,
  budget: number
): number {
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
  maxTokens = 1_200
): Array<{ start: number; end: number }> {
  if (!text) return [];
  if (estimateTokens(text) <= maxTokens)
    return [{ start: 0, end: text.length }];

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
      window.lastIndexOf("?")
    );
    const end =
      sentenceBoundary >= 0 ? preferredStart + sentenceBoundary + 1 : maxEnd;
    offsets.push({ start, end });
    start = end;
  }
  return offsets;
}

function takeWholeBlocks(
  blocks: CoReadingBlock[],
  budget: number,
  maxBlocks = Number.POSITIVE_INFINITY
): CoReadingBlock[] {
  const selected: CoReadingBlock[] = [];
  let used = 0;
  for (const block of blocks) {
    if (selected.length >= maxBlocks) break;
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
    CO_READING_BATCH_MAX_BLOCKS
  );
  const recentBlocks = takeWholeBlocks(
    input.recent.filter(
      (block) => block.status === "silent" || block.status === "annotated"
    ),
    RECENT_BLOCK_BUDGET
  );

  const rollingSummary = takeTextWithinBudget(
    input.rollingSummary,
    Math.floor(SUPPLEMENTAL_BUDGET * 0.6)
  );
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
    recentBlocks.reduce(
      (sum, block) => sum + estimateTokens(block.text) + 12,
      0
    ) +
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
  maxAnnotations = 4
): {
  annotations: Array<{ block: CoReadingBlock; quote: string; comment: string }>;
  summary: string;
} {
  const summary = decision.summary.trim().slice(0, 2_000);
  const seenBlocks = new Set<string>();
  const annotations = decision.annotations
    .slice(0, maxAnnotations)
    .map((item) => {
      const block = claimedBlocks.find(
        (candidate) => candidate.blockKey === item.blockKey
      );
      if (!block || seenBlocks.has(item.blockKey))
        throw new Error("批量批注包含无效或重复文本块");
      const quote = item.quote.trim();
      const comment = item.comment.trim();
      if (!quote || !comment || !block.text.includes(quote))
        throw new Error("批量批注引文必须逐字来自对应正文块");
      seenBlocks.add(item.blockKey);
      return { block, quote, comment: comment.slice(0, 500) };
    });
  return { annotations, summary };
}

export function validateCoReadingItemResult(
  result: CoReadingItemResult,
  claimedBlocks: CoReadingBlock[]
): ValidatedCoReadingItemResult {
  if (claimedBlocks.length === 0) throw new Error("页面阅读单元不能为空");
  if (result.annotations.length > 3)
    throw new Error("单个页面最多返回 3 条批注");
  const focusKeys = new Set(
    claimedBlocks.map((block) => block.focusKey ?? block.blockKey)
  );
  if (focusKeys.size !== 1 || focusKeys.has("")) {
    throw new Error("页面阅读单元必须属于同一个可见焦点");
  }
  const summary = result.summary.trim();
  if (summary.length > 2_000) throw new Error("连续阅读摘要超过长度限制");
  const seenQuotes = new Set<string>();
  const annotations = result.annotations.map((item) => {
    const block = claimedBlocks.find(
      (candidate) => candidate.blockKey === item.blockKey
    );
    if (!block) throw new Error("模型选择了当前页面之外的文本块");
    const quote = item.quote.trim();
    const comment = item.comment.trim();
    if (!quote || !comment) throw new Error("批注必须包含逐字引文和短评");
    if (quote.length > 1_200) throw new Error("批注引文超过长度限制");
    if (comment.length > 500) throw new Error("批注短评超过长度限制");
    if (!block.text.includes(quote)) {
      throw new Error("模型引文不是当前页面对应正文块的逐字子串");
    }
    const quoteKey = `${block.blockKey}:${quote}`;
    if (seenQuotes.has(quoteKey)) throw new Error("当前页面返回了重复批注引文");
    seenQuotes.add(quoteKey);
    return { block, quote, comment };
  });
  return { annotations, summary };
}

export function validateCoReadingReviewResult(
  result: CoReadingReviewResult
): string {
  const review = result.review.trim();
  if (!review) throw new Error("AI 书评不能为空");
  if (review.length > 2_000) throw new Error("AI 书评超过长度限制");
  return review;
}

export function validateCoReadingDecision(
  decision: CoReadingDecision,
  claimedBlocks: CoReadingBlock[]
): ValidatedCoReadingDecision {
  const summary = decision.summary.trim().slice(0, 2_000);
  if (decision.action === "silent") {
    if (decision.blockKey || decision.quote.trim() || decision.comment.trim()) {
      return { ok: false, error: "沉默决定不能包含批注内容" };
    }
    return { ok: true, action: "silent", summary };
  }

  const block = claimedBlocks.find(
    (candidate) => candidate.blockKey === decision.blockKey
  );
  if (!block) return { ok: false, error: "模型选择了本批之外的文本块" };

  const quote = decision.quote.trim();
  const comment = decision.comment.trim();
  if (!quote || !comment)
    return { ok: false, error: "批注必须包含逐字引文和短评" };
  if (!block.text.includes(quote))
    return { ok: false, error: "模型引文不是已解锁原文的逐字子串" };

  return {
    ok: true,
    action: "annotate",
    block,
    quote,
    comment: comment.slice(0, 500),
    summary,
  };
}

import type { BookDoc, TOCItem } from "@/lib/document";
import type { BookFormat } from "@/types/book";
import type {
  CoReadingBlockUpsert,
  CoReadingFootprint,
  CoReadingFootprintStatus,
  CoReadingRangeTaskStatus,
} from "@/types/co-reading";

export interface CoReadingRangeOption {
  sectionIndex: number;
  label: string;
  pathLabel: string;
}

export interface CoReadingSectionTextIndex {
  sectionIndex: number;
  charLength: number;
  cumulativeStart: number;
  cumulativeEnd: number;
  label: string;
}

export interface CoReadingPercentageRange {
  startPercent: number;
  endPercent: number;
  startIndex: number;
  endIndex: number;
  startCharOffset: number;
  endCharOffset: number;
  startLabel: string;
  endLabel: string;
}

export const CO_READING_PERCENTAGE_PRESETS = [
  { label: "前 10%", startPercent: 0, endPercent: 10 },
  { label: "前 25%", startPercent: 0, endPercent: 25 },
  { label: "前半本", startPercent: 0, endPercent: 50 },
  { label: "全书", startPercent: 0, endPercent: 100 },
] as const;

export function countUnicodeCharacters(text: string): number {
  return Array.from(text).length;
}

export function unicodeOffsetToUtf16(text: string, offset: number): number {
  return Array.from(text).slice(0, Math.max(0, offset)).join("").length;
}

export function clipCharacterRange(
  blockStart: number,
  blockEnd: number,
  boundaryStart: number,
  boundaryEnd: number
): { start: number; end: number } | null {
  const start = Math.max(blockStart, boundaryStart);
  const end = Math.min(blockEnd, boundaryEnd);
  return end > start ? { start, end } : null;
}

export function buildCoReadingBookTextIndex(
  sectionLengths: number[],
  options: CoReadingRangeOption[],
  format: BookFormat | undefined
): CoReadingSectionTextIndex[] {
  let cumulative = 0;
  return sectionLengths.map((length, sectionIndex) => {
    const charLength = Math.max(0, Math.trunc(length));
    const item = {
      sectionIndex,
      charLength,
      cumulativeStart: cumulative,
      cumulativeEnd: cumulative + charLength,
      label: getCoReadingSectionLabel(options, sectionIndex, format),
    };
    cumulative += charLength;
    return item;
  });
}

export function getCoReadingDefaultPercentageRange(
  index: CoReadingSectionTextIndex[],
  currentSection: number
): { startPercent: number; endPercent: number } {
  const total = index.at(-1)?.cumulativeEnd ?? 0;
  if (total <= 0) return { startPercent: 0, endPercent: 100 };
  const section =
    index.find(
      (item) => item.sectionIndex >= currentSection && item.charLength > 0
    ) ?? index.find((item) => item.charLength > 0);
  const startPercent = section
    ? Math.floor((section.cumulativeStart / total) * 100)
    : 0;
  return { startPercent, endPercent: Math.min(100, startPercent + 10) };
}

export interface CoReadingCurrentPosition {
  sectionIndex: number;
  charOffset: number;
  absoluteOffset: number;
  startPercent: number;
  label: string;
}

export function mapSectionOffsetToCurrentPosition(
  index: CoReadingSectionTextIndex[],
  sectionIndex: number,
  charOffset: number
): CoReadingCurrentPosition | null {
  const total = index.at(-1)?.cumulativeEnd ?? 0;
  const section = index.find((item) => item.sectionIndex === sectionIndex);
  if (!section || total <= 0 || section.charLength <= 0) return null;
  const safeOffset = Math.max(
    0,
    Math.min(section.charLength, Math.trunc(charOffset))
  );
  const absoluteOffset = section.cumulativeStart + safeOffset;
  return {
    sectionIndex,
    charOffset: safeOffset,
    absoluteOffset,
    startPercent: (absoluteOffset / total) * 100,
    label: section.label,
  };
}

export function adjustEndPercentForCurrentPosition(
  startPercent: number,
  endPercent: number,
  step = 10
): number | null {
  const start = Math.max(0, Math.min(100, startPercent));
  if (start >= 100) return null;
  const end = Math.max(0, Math.min(100, endPercent));
  return end > start ? end : Math.min(100, start + Math.max(0.01, step));
}

export function mapPercentageToBookRange(
  index: CoReadingSectionTextIndex[],
  firstPercent: number,
  secondPercent: number
): CoReadingPercentageRange | null {
  const nonEmpty = index.filter((item) => item.charLength > 0);
  const total = index.at(-1)?.cumulativeEnd ?? 0;
  if (total <= 0 || nonEmpty.length === 0) return null;

  if (!Number.isFinite(firstPercent) || !Number.isFinite(secondPercent))
    return null;
  const startPercent = Math.max(
    0,
    Math.min(100, Math.min(firstPercent, secondPercent))
  );
  const endPercent = Math.max(
    0,
    Math.min(100, Math.max(firstPercent, secondPercent))
  );
  if (startPercent === endPercent) return null;

  const startAbsolute = Math.floor((total * startPercent) / 100);
  const endAbsolute =
    endPercent === 100 ? total : Math.floor((total * endPercent) / 100);
  if (endAbsolute <= startAbsolute) return null;

  const startSection =
    nonEmpty.find((item) => item.cumulativeEnd > startAbsolute) ??
    nonEmpty.at(-1)!;
  const endSection =
    nonEmpty.find((item) => item.cumulativeEnd >= endAbsolute) ??
    nonEmpty.at(-1)!;
  const startCharOffset = Math.max(
    0,
    startAbsolute - startSection.cumulativeStart
  );
  const endCharOffset = Math.min(
    endSection.charLength,
    endAbsolute - endSection.cumulativeStart
  );

  return {
    startPercent,
    endPercent,
    startIndex: startSection.sectionIndex,
    endIndex: endSection.sectionIndex,
    startCharOffset,
    endCharOffset,
    startLabel: `${startPercent}% · ${startSection.label}`,
    endLabel: `${endPercent}% · ${endSection.label}`,
  };
}

function flattenToc(
  items: TOCItem[],
  parents: string[] = []
): Array<{ item: TOCItem; path: string[] }> {
  return items.flatMap((item) => {
    const path = [...parents, item.label.trim()].filter(Boolean);
    return [
      { item, path },
      ...(item.subitems ? flattenToc(item.subitems, path) : []),
    ];
  });
}

export function buildCoReadingRangeOptions(
  bookDoc: BookDoc | undefined,
  format: BookFormat | undefined
): CoReadingRangeOption[] {
  const sections = bookDoc?.sections ?? [];
  if (format === "PDF") {
    return sections.map((_, sectionIndex) => ({
      sectionIndex,
      label: `第 ${sectionIndex + 1} 页`,
      pathLabel: `第 ${sectionIndex + 1} 页`,
    }));
  }
  if (format !== "EPUB" || sections.length === 0) return [];
  const sectionIndexes = new Map(
    sections.map((section, index) => [section.id, index])
  );
  const options = new Map<number, CoReadingRangeOption>();
  for (const { item, path } of flattenToc(bookDoc?.toc ?? [])) {
    if (!item.href) continue;
    const sectionId = bookDoc?.splitTOCHref(item.href)[0];
    const sectionIndex =
      sectionId == null ? undefined : sectionIndexes.get(String(sectionId));
    if (sectionIndex == null || options.has(sectionIndex)) continue;
    options.set(sectionIndex, {
      sectionIndex,
      label: item.label.trim() || `位置 ${sectionIndex + 1}`,
      pathLabel: path.join(" › ") || `位置 ${sectionIndex + 1}`,
    });
  }
  if (options.size > 0)
    return [...options.values()].sort(
      (a, b) => a.sectionIndex - b.sectionIndex
    );
  return sections
    .map((section, sectionIndex) => ({ section, sectionIndex }))
    .filter(({ section }) => section.linear !== "no" && section.size > 0)
    .map(({ sectionIndex }) => ({
      sectionIndex,
      label: `位置 ${sectionIndex + 1}`,
      pathLabel: `正文位置 ${sectionIndex + 1} / ${sections.length}`,
    }));
}

export function getCoReadingSectionLabel(
  options: CoReadingRangeOption[],
  sectionIndex: number,
  format: BookFormat | undefined
): string {
  if (format === "PDF") return `第 ${sectionIndex + 1} 页`;
  const exact = options.find((option) => option.sectionIndex === sectionIndex);
  if (exact) return exact.pathLabel;
  const preceding = [...options]
    .reverse()
    .find((option) => option.sectionIndex <= sectionIndex);
  return preceding
    ? `${preceding.pathLabel} · 后续正文`
    : `正文位置 ${sectionIndex + 1}`;
}

const MIN_CANDIDATE_LENGTH = 32;
const HEADING_ONLY =
  /^(第[一二三四五六七八九十百千\d]+[章节卷部篇]|chapter\s+\d+|contents?|目录|序|前言)$/iu;

export function classifyRangeCandidate(
  block: CoReadingBlockUpsert,
  seenHashes: Set<string>
): { status: "filtered" | "candidate"; reason: string | null } {
  const text = block.text.replace(/\s+/gu, " ").trim();
  if (!text) return { status: "filtered", reason: "空白文本" };
  if (seenHashes.has(block.textHash))
    return { status: "filtered", reason: "重复文本" };
  seenHashes.add(block.textHash);
  if (text.length < MIN_CANDIDATE_LENGTH)
    return { status: "filtered", reason: "文本过短" };
  if (HEADING_ONLY.test(text))
    return { status: "filtered", reason: "标题或目录" };
  return { status: "candidate", reason: null };
}

export function normalizeSelectedBlockKeys(
  keys: string[],
  candidates: CoReadingBlockUpsert[],
  limit = 6
): string[] {
  const allowed = new Set(candidates.map((block) => block.blockKey));
  return [...new Set(keys)].filter((key) => allowed.has(key)).slice(0, limit);
}

export interface CoReadingMapRow {
  sectionIndex: number;
  sectionLabel: string;
  footprints: CoReadingFootprint[];
}

export function groupFootprintsBySection(
  footprints: CoReadingFootprint[],
  sectionIndex?: CoReadingSectionTextIndex[]
): CoReadingMapRow[] {
  const grouped = new Map<number, CoReadingFootprint[]>();
  for (const footprint of footprints) {
    const items = grouped.get(footprint.sectionIndex) ?? [];
    items.push(footprint);
    grouped.set(footprint.sectionIndex, items);
  }

  const indexes = sectionIndex?.length
    ? sectionIndex.map((section) => section.sectionIndex)
    : [...grouped.keys()].sort((a, b) => a - b);
  return indexes.map((currentSectionIndex) => {
    const items = grouped.get(currentSectionIndex) ?? [];
    const indexedLabel = sectionIndex?.find(
      (section) => section.sectionIndex === currentSectionIndex
    )?.label;
    return {
      sectionIndex: currentSectionIndex,
      sectionLabel:
        items[0]?.sectionLabel ||
        indexedLabel ||
        `第 ${currentSectionIndex + 1} 节`,
      footprints: items.sort((a, b) => a.createdAt - b.createdAt),
    };
  });
}

export const FOOTPRINT_COLORS: Record<CoReadingFootprintStatus, string> = {
  filtered: "bg-neutral-300 dark:bg-neutral-700",
  candidate: "bg-sky-300 dark:bg-sky-700",
  selected: "bg-amber-300 dark:bg-amber-700",
  silent: "bg-emerald-300 dark:bg-emerald-700",
  annotated: "bg-primary",
  failed: "bg-red-400 dark:bg-red-600",
};

export const RANGE_TASK_STATUS_LABELS: Record<
  CoReadingRangeTaskStatus,
  string
> = {
  running: "进行中",
  paused: "已暂停",
  completed: "已完成",
  stopped: "已停止",
  failed: "失败",
};

export function getRangeTaskStatusLabel(
  status: CoReadingRangeTaskStatus | string
): string {
  return RANGE_TASK_STATUS_LABELS[status as CoReadingRangeTaskStatus] ?? status;
}

import type { BookNote } from "../../types/book.ts";
import type {
  CoReadingBlock,
  CoReadingFootprint,
  CoReadingSourceTarget,
  ReadingFootprintTarget,
} from "../../types/co-reading.ts";

export type { ReadingFootprintTarget } from "../../types/co-reading.ts";

export const OPEN_READING_FOOTPRINT_EVENT = "deepreader:open-reading-footprint";
export const LOCATE_READING_FOOTPRINT_EVENT =
  "deepreader:locate-reading-footprint";
const PENDING_READING_FOOTPRINT_PREFIX =
  "deepreader:pending-reading-footprint:";

interface ReadingFootprintStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function shouldOpenReadingFootprint(annotation: BookNote): boolean {
  return annotation.author === "ai" && !annotation.sourceNoteId;
}

export function createReadingFootprintTarget(
  bookId: string,
  annotation: BookNote
): ReadingFootprintTarget {
  return {
    bookId,
    annotationId: annotation.id,
    cfi: annotation.cfi,
    annotation,
  };
}

/**
 * AI 批注 → 右侧阅读地图的生产入口。
 * 仅 author==="ai" 时写入 pending footprint 并派发事件；人类批注返回 false。
 */
export function openReadingFootprintForAnnotation(options: {
  bookId: string | undefined;
  annotation: BookNote;
  setPendingReadingFootprint?: (target: ReadingFootprintTarget | null) => void;
  eventTarget?: EventTarget;
}): ReadingFootprintTarget | null {
  const { bookId, annotation, setPendingReadingFootprint, eventTarget } =
    options;
  if (!bookId || !shouldOpenReadingFootprint(annotation)) return null;

  const target = createReadingFootprintTarget(bookId, annotation);
  setPendingReadingFootprint?.(target);
  if (eventTarget) {
    dispatchOpenReadingFootprint(eventTarget, target);
  }
  return target;
}

export function getReadingFootprintTarget(
  currentBookId: string | undefined,
  detail: ReadingFootprintTarget | undefined
): ReadingFootprintTarget | null {
  if (
    !currentBookId ||
    detail?.bookId !== currentBookId ||
    !detail.annotationId
  )
    return null;
  return detail;
}

export function findFootprintByAnnotationId(
  footprints: CoReadingFootprint[],
  annotationId: string
): CoReadingFootprint | null {
  return (
    footprints.find((footprint) => footprint.annotationId === annotationId) ??
    null
  );
}

export function getFootprintSourceTarget(
  footprint: CoReadingFootprint
): CoReadingSourceTarget {
  return {
    bookId: footprint.bookId,
    cfi: footprint.cfi || null,
    annotationId: footprint.annotationId,
    blockKey: footprint.blockKey,
    sectionIndex: footprint.sectionIndex,
    sectionLabel: footprint.sectionLabel,
    text: footprint.text,
  };
}

export function getAnnotationSourceTarget(
  bookId: string,
  annotation: BookNote,
  block?: Pick<CoReadingBlock, "blockKey" | "sectionIndex" | "sectionLabel">
): CoReadingSourceTarget {
  return {
    bookId,
    cfi: annotation.cfi || null,
    annotationId: annotation.id,
    blockKey: block?.blockKey ?? null,
    sectionIndex: block?.sectionIndex ?? null,
    sectionLabel: block?.sectionLabel ?? null,
    text: annotation.text ?? "",
  };
}

interface ReadingSourceNavigator {
  resolveCFI: (cfi: string) => {
    index: number;
    anchor: (doc: Document) => Range;
  };
  select: (target: string) => void | Promise<void>;
  renderer: {
    goTo?: (params: {
      index: number;
      anchor: number | ((doc: Document) => Range);
      select?: boolean;
    }) => void | Promise<void>;
  };
}

export type ReadingSourceNavigationResult =
  | { precision: "exact"; message: string }
  | { precision: "fallback"; message: string }
  | { precision: "unavailable"; message: string };

export async function navigateToReadingSource(
  navigator: ReadingSourceNavigator,
  target: CoReadingSourceTarget
): Promise<ReadingSourceNavigationResult> {
  let resolvedIndex: number | null = null;
  if (target.cfi) {
    try {
      const resolved = navigator.resolveCFI(target.cfi);
      resolvedIndex = resolved.index;
      if (navigator.renderer.goTo) {
        await navigator.renderer.goTo({ ...resolved, select: true });
      } else {
        await navigator.select(target.cfi);
      }
      return { precision: "exact", message: "已定位并高亮原文" };
    } catch {
      // Continue to a section-level fallback when a saved CFI no longer resolves.
    }
  }

  const fallbackIndex = target.sectionIndex ?? resolvedIndex;
  if (fallbackIndex != null && navigator.renderer.goTo) {
    try {
      await navigator.renderer.goTo({ index: fallbackIndex, anchor: 0 });
      const label = target.sectionLabel || `正文位置 ${fallbackIndex + 1}`;
      return {
        precision: "fallback",
        message: `精确位置已失效，已跳到${label}附近`,
      };
    } catch {
      // Return an actionable explanation below.
    }
  }

  return {
    precision: "unavailable",
    message: target.cfi
      ? "原文定位信息已失效，且无法回退到对应章节或页码"
      : "该记录缺少可用的原文定位信息",
  };
}

export function savePendingReadingFootprint(
  storage: ReadingFootprintStorage,
  detail: ReadingFootprintTarget
): void {
  storage.setItem(
    `${PENDING_READING_FOOTPRINT_PREFIX}${detail.bookId}`,
    JSON.stringify(detail)
  );
}

export function consumePendingReadingFootprint(
  storage: ReadingFootprintStorage,
  bookId: string | undefined
): ReadingFootprintTarget | null {
  if (!bookId) return null;
  const key = `${PENDING_READING_FOOTPRINT_PREFIX}${bookId}`;
  const raw = storage.getItem(key);
  if (!raw) return null;
  storage.removeItem(key);
  try {
    return getReadingFootprintTarget(
      bookId,
      JSON.parse(raw) as ReadingFootprintTarget
    );
  } catch {
    return null;
  }
}

export function dispatchOpenReadingFootprint(
  eventTarget: EventTarget,
  detail: ReadingFootprintTarget
): void {
  eventTarget.dispatchEvent(
    new CustomEvent(OPEN_READING_FOOTPRINT_EVENT, { detail })
  );
}

export function listenForReadingFootprint(
  eventTarget: EventTarget,
  currentBookId: string | undefined,
  listener: (target: ReadingFootprintTarget) => void
): () => void {
  const handler = (event: Event) => {
    const target = getReadingFootprintTarget(
      currentBookId,
      (event as CustomEvent<ReadingFootprintTarget>).detail
    );
    if (target) listener(target);
  };
  eventTarget.addEventListener(OPEN_READING_FOOTPRINT_EVENT, handler);
  return () =>
    eventTarget.removeEventListener(OPEN_READING_FOOTPRINT_EVENT, handler);
}

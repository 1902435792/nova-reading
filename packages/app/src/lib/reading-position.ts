export interface VisibleReadingPosition {
  /** The CFI reported by Foliate for the currently visible location. */
  location?: string;
  /** The zero-based EPUB spine/section index reported by Foliate. */
  sectionIndex?: number;
  /** The human-readable TOC label for the visible section. */
  sectionLabel?: string;
  /** The zero-based page number within the visible section. */
  pageCurrent?: number;
  /** The total number of pages within the visible section. */
  pageTotal?: number;
}

export interface VisibleReadingPositionInput {
  location?: string | null;
  sectionIndex?: number | null;
  sectionLabel?: string | null;
  pageCurrent?: number | null;
  pageTotal?: number | null;
}

/**
 * Normalizes the live Foliate relocation snapshot before it crosses the chat
 * boundary. Empty values are omitted so the Agent never receives a misleading
 * placeholder as if it were a real EPUB location.
 */
export function createVisibleReadingPosition(
  input: VisibleReadingPositionInput,
): VisibleReadingPosition {
  const position: VisibleReadingPosition = {};
  const location = input.location?.trim();
  const sectionLabel = input.sectionLabel?.trim();

  if (location) position.location = location;
  if (Number.isInteger(input.sectionIndex) && input.sectionIndex! >= 0) {
    position.sectionIndex = input.sectionIndex!;
  }
  if (sectionLabel) position.sectionLabel = sectionLabel;
  if (Number.isInteger(input.pageCurrent) && input.pageCurrent! >= 0) {
    position.pageCurrent = input.pageCurrent!;
  }
  if (Number.isInteger(input.pageTotal) && input.pageTotal! > 0) {
    position.pageTotal = input.pageTotal!;
  }

  return position;
}

/** Formats a live position for explicit inclusion in the Agent system prompt. */
export function formatVisibleReadingPosition(
  position?: VisibleReadingPosition,
): string {
  if (!position) return "";

  const parts: string[] = [];
  if (position.sectionLabel) parts.push(`章节：${position.sectionLabel}`);
  if (position.sectionIndex != null) {
    parts.push(`EPUB section index：${position.sectionIndex}`);
  }
  if (position.pageCurrent != null && position.pageTotal != null) {
    parts.push(`当前页：${position.pageCurrent + 1}/${position.pageTotal}`);
  } else if (position.pageCurrent != null) {
    parts.push(`当前页：${position.pageCurrent + 1}`);
  }
  if (position.location) parts.push(`EPUB CFI：${position.location}`);

  return parts.join("；");
}

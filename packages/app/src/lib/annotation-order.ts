import type { BookNote } from "../types/book.ts";
import * as CFI from "foliate-js/epubcfi.js";

export interface ReadingLocation {
  sectionIndex?: number | null;
  cfi?: string | null;
}

function validSectionIndex(value: number | null | undefined): number | null {
  return Number.isInteger(value) && value! >= 0 ? value! : null;
}

function parsedCfiHasSteps(parsed: unknown): boolean {
  if (Array.isArray(parsed)) {
    return parsed.some(
      (path) =>
        Array.isArray(path) &&
        path.some(
          (step) =>
            typeof step === "object" &&
            step != null &&
            Number.isFinite((step as { index?: number }).index),
        ),
    );
  }
  if (typeof parsed !== "object" || parsed == null) return false;
  const range = parsed as { parent?: unknown; start?: unknown; end?: unknown };
  return (
    parsedCfiHasSteps(range.parent) ||
    parsedCfiHasSteps(range.start) ||
    parsedCfiHasSteps(range.end)
  );
}

export function normalizeReadingCfi(value: string | null | undefined): string | null {
  const cfi = value?.trim();
  if (!cfi || !/^epubcfi\(\s*\//.test(cfi)) return null;
  try {
    return parsedCfiHasSteps(CFI.parse(cfi)) ? cfi : null;
  } catch {
    return null;
  }
}

/**
 * Compares only real reading-location metadata. Returns null when the two
 * locations cannot be ordered, so callers can apply an explicit stable fallback.
 */
export function compareReadingLocations(
  left: ReadingLocation,
  right: ReadingLocation,
): number | null {
  const leftSection = validSectionIndex(left.sectionIndex);
  const rightSection = validSectionIndex(right.sectionIndex);
  if (leftSection != null && rightSection != null && leftSection !== rightSection) {
    return leftSection - rightSection;
  }

  const leftCfi = normalizeReadingCfi(left.cfi);
  const rightCfi = normalizeReadingCfi(right.cfi);
  if (leftCfi && rightCfi) {
    try {
      return Math.sign(CFI.compare(leftCfi, rightCfi));
    } catch {
      return null;
    }
  }

  if (leftSection != null && rightSection != null) return 0;
  return null;
}

export function hasReadingLocation(location: ReadingLocation): boolean {
  return (
    validSectionIndex(location.sectionIndex) != null ||
    normalizeReadingCfi(location.cfi) != null
  );
}

/** Front-to-back book order; timestamps and ids are stable fallbacks only. */
export function compareAnnotationsByReadingOrder(
  left: BookNote,
  right: BookNote,
): number {
  const position = compareReadingLocations(left, right);
  if (position != null && position !== 0) return position;

  const leftHasLocation = hasReadingLocation(left);
  const rightHasLocation = hasReadingLocation(right);
  if (leftHasLocation !== rightHasLocation) return leftHasLocation ? -1 : 1;

  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

export function sortAnnotationsByReadingOrder(notes: BookNote[]): BookNote[] {
  return [...notes].sort(compareAnnotationsByReadingOrder);
}

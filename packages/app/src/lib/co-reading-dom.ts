import { splitTextOffsets } from "@/lib/co-reading-core";
import { clipCharacterRange, countUnicodeCharacters, unicodeOffsetToUtf16 } from "@/lib/co-reading-range";
import type { CoReadingBlockUpsert } from "@/types/co-reading";
import type { FoliateView } from "@/types/view";
import { md5 } from "js-md5";

const BLOCK_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, figcaption";
const REJECTED_SELECTOR = "script, style, noscript";

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

function textSegments(root: Node): { text: string; segments: TextSegment[] } {
  const doc = root.ownerDocument ?? (root as Document);
  if (root.nodeType === Node.TEXT_NODE) {
    const node = root as Text;
    const text = node.nodeValue ?? "";
    return {
      text,
      segments: text ? [{ node, start: 0, end: text.length }] : [],
    };
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(REJECTED_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const segments: TextSegment[] = [];
  let text = "";
  let node = walker.nextNode() as Text | null;
  while (node) {
    const value = node.nodeValue ?? "";
    if (value) {
      const start = text.length;
      text += value;
      segments.push({ node, start, end: text.length });
    }
    node = walker.nextNode() as Text | null;
  }
  return { text, segments };
}

function rangeFromOffsets(doc: Document, segments: TextSegment[], start: number, end: number): Range | null {
  const startSegment = segments.find((segment) => start >= segment.start && start < segment.end);
  const endSegment = segments.find((segment) => end > segment.start && end <= segment.end);
  if (!startSegment || !endSegment) return null;

  const range = doc.createRange();
  range.setStart(startSegment.node, start - startSegment.start);
  range.setEnd(endSegment.node, end - endSegment.start);
  return range;
}

function elementRange(element: Element): Range {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  return range;
}

function intersectRanges(base: Range, visible: Range): Range | null {
  if (!visible.intersectsNode(base.commonAncestorContainer)) return null;
  const intersection = base.cloneRange();
  if (intersection.compareBoundaryPoints(Range.START_TO_START, visible) < 0) {
    intersection.setStart(visible.startContainer, visible.startOffset);
  }
  if (intersection.compareBoundaryPoints(Range.END_TO_END, visible) > 0) {
    intersection.setEnd(visible.endContainer, visible.endOffset);
  }
  return intersection.collapsed ? null : intersection;
}

function isVisibleEnough(full: Range, visible: Range, element: Element): boolean {
  const intersection = intersectRanges(full, visible);
  if (!intersection) return false;
  const fullLength = full.toString().trim().length;
  if (fullLength === 0) return false;
  const ratio = intersection.toString().trim().length / fullLength;
  const isHeading = /^H[1-6]$/u.test(element.tagName);
  return ratio >= (isHeading || fullLength <= 80 ? 0.8 : 0.5);
}

function candidateElements(doc: Document, visibleRange: Range): Element[] {
  return Array.from(doc.querySelectorAll(BLOCK_SELECTOR)).filter((element) => {
    if (!visibleRange.intersectsNode(element)) return false;
    const parentBlock = element.parentElement?.closest(BLOCK_SELECTOR);
    return !parentBlock;
  });
}

export function extractVisibleCoReadingBlocks(
  bookId: string,
  view: FoliateView,
  visibleRange: Range,
  sectionLabel: string,
): CoReadingBlockUpsert[] {
  const doc = visibleRange.startContainer.ownerDocument;
  if (!doc) return [];
  const content = view.renderer.getContents().find((item) => item.doc === doc);
  if (content?.index == null) return [];

  const blocks: CoReadingBlockUpsert[] = [];
  for (const element of candidateElements(doc, visibleRange)) {
    const { text, segments } = textSegments(element);
    if (!text.trim()) continue;

    for (const { start, end } of splitTextOffsets(text)) {
      const range = rangeFromOffsets(doc, segments, start, end);
      if (!range || !isVisibleEnough(range, visibleRange, element)) continue;
      const fragmentText = range.toString();
      if (!fragmentText.trim()) continue;

      const cfi = view.getCFI(content.index, range);
      const textHash = md5(fragmentText);
      const blockKey = md5(`${bookId}:${content.index}:${cfi}:${textHash}`);
      blocks.push({
        id: blockKey,
        bookId,
        blockKey,
        sectionIndex: content.index,
        sectionLabel,
        cfi,
        text: fragmentText,
        textHash,
        dwellMs: 0,
        status: "tracking",
        unlockedAt: null,
      });
    }
  }
  return blocks;
}
export function getDocumentCoReadingText(doc: Document): string {
  return textSegments(doc.body ?? doc.documentElement).text;
}

export function getDocumentCoReadingTextLength(doc: Document): number {
  return countUnicodeCharacters(getDocumentCoReadingText(doc));
}

export function getCoReadingCodePointOffset(doc: Document, container: Node, offset: number): number | null {
  const root = doc.body ?? doc.documentElement;
  if (container.ownerDocument !== doc || !root.contains(container)) return null;
  const { text, segments } = textSegments(root);
  if (container.nodeType === Node.TEXT_NODE) {
    const segment = segments.find((item) => item.node === container);
    if (!segment) return null;
    const utf16Offset = segment.start + Math.max(0, Math.min(offset, segment.end - segment.start));
    return countUnicodeCharacters(text.slice(0, utf16Offset));
  }

  try {
    const prefix = doc.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(container, offset);
    const fragment = prefix.cloneContents();
    return countUnicodeCharacters(textSegments(fragment).text);
  } catch {
    return null;
  }
}

export function extractDocumentCoReadingBlocks(
  bookId: string,
  view: FoliateView,
  doc: Document,
  sectionIndex: number,
  sectionLabel: string,
  charBoundary?: { start: number; end: number },
): CoReadingBlockUpsert[] {
  const blocks: CoReadingBlockUpsert[] = [];
  const root = doc.body ?? doc.documentElement;
  const documentSegments = textSegments(root);
  const documentText = documentSegments.text;
  const boundaryStart = unicodeOffsetToUtf16(documentText, charBoundary?.start ?? 0);
  const boundaryEnd = unicodeOffsetToUtf16(documentText, charBoundary?.end ?? countUnicodeCharacters(documentText));
  let elementStart = 0;
  const elements = Array.from(doc.querySelectorAll(BLOCK_SELECTOR)).filter(
    (element) => !element.parentElement?.closest(BLOCK_SELECTOR),
  );
  for (const element of elements) {
    const { text, segments } = textSegments(element);
    if (!text.trim()) continue;
    elementStart = documentSegments.segments.find((segment) => segment.node === segments[0]?.node)?.start ?? 0;
    for (const offsets of splitTextOffsets(text)) {
      const clipped = clipCharacterRange(
        elementStart + offsets.start,
        elementStart + offsets.end,
        boundaryStart,
        boundaryEnd,
      );
      if (!clipped) continue;
      const range = rangeFromOffsets(doc, segments, clipped.start - elementStart, clipped.end - elementStart);
      if (!range) continue;
      const fragmentText = range.toString();
      if (!fragmentText.trim()) continue;
      const cfi = view.getCFI(sectionIndex, range);
      const textHash = md5(fragmentText);
      const blockKey = md5(`${bookId}:${sectionIndex}:${cfi}:${textHash}`);
      blocks.push({
        id: blockKey,
        bookId,
        blockKey,
        sectionIndex,
        sectionLabel,
        cfi,
        text: fragmentText,
        textHash,
        dwellMs: 0,
        status: "tracking",
        unlockedAt: null,
      });
    }
  }
  return blocks;
}

export function locateExactQuoteRange(baseRange: Range, quote: string): Range | null {
  const { text, segments } = textSegments(baseRange.commonAncestorContainer);
  const baseText = baseRange.toString();
  const quoteIndex = baseText.indexOf(quote);
  if (quoteIndex < 0) return null;
  const prefix = baseRange.cloneRange();
  prefix.selectNodeContents(baseRange.commonAncestorContainer);
  prefix.setEnd(baseRange.startContainer, baseRange.startOffset);
  const ancestorTextStart = prefix.toString().length;
  if (ancestorTextStart + baseText.length > text.length) return null;
  return rangeFromOffsets(
    baseRange.startContainer.ownerDocument ?? document,
    segments,
    ancestorTextStart + quoteIndex,
    ancestorTextStart + quoteIndex + quote.length,
  );
}

export function contextAroundRange(range: Range, length = 50): { before: string; after: string } {
  const element =
    (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement
    )?.closest(BLOCK_SELECTOR) ?? range.commonAncestorContainer.parentElement;
  const text = element?.textContent ?? range.toString();
  const quote = range.toString();
  const index = text.indexOf(quote);
  if (index < 0) return { before: "", after: "" };
  return {
    before: text.slice(Math.max(0, index - length), index).replace(/\s+/gu, " "),
    after: text.slice(index + quote.length, index + quote.length + length).replace(/\s+/gu, " "),
  };
}

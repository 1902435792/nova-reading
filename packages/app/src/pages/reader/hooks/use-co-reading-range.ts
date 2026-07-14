import { validateCoReadingBatchDecision } from "@/lib/co-reading-core";
import {
  contextAroundRange,
  extractDocumentCoReadingBlocks,
  getDocumentCoReadingTextLength,
  locateExactQuoteRange,
} from "@/lib/co-reading-dom";
import {
  buildCoReadingRangeOptions,
  classifyRangeCandidate,
  getCoReadingSectionLabel,
  normalizeSelectedBlockKeys,
} from "@/lib/co-reading-range";
import { createBookNote, getBookNotes } from "@/services/book-note-service";
import { requestCoReadingBatchDecision, requestCoReadingSelection } from "@/services/co-reading-ai-service";
import {
  advanceCoReadingRangeTask,
  getCoReadingRangeSnapshot,
  getCoReadingSnapshot,
  updateCoReadingRangeTask,
  updateCoReadingSettings,
  upsertCoReadingFootprints,
} from "@/services/co-reading-service";
import type { CoReadingBlock, CoReadingFootprintUpsert, CoReadingRangeTask } from "@/types/co-reading";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useReaderStore, useReaderStoreApi } from "../components/reader-provider";

function toDecisionBlock(block: CoReadingFootprintUpsert): CoReadingBlock {
  const now = Date.now();
  return {
    id: block.id,
    bookId: block.bookId,
    blockKey: block.blockKey,
    sectionIndex: block.sectionIndex,
    sectionLabel: block.sectionLabel,
    cfi: block.cfi,
    text: block.text,
    textHash: block.textHash,
    dwellMs: 0,
    status: "processing",
    decision: null,
    annotationId: null,
    error: null,
    unlockedAt: now,
    processedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function useCoReadingRange(bookId: string): void {
  const store = useReaderStoreApi();
  const view = useReaderStore((state) => state.view);
  const bookData = useReaderStore((state) => state.bookData);
  const queryClient = useQueryClient();
  const runningRef = useRef(false);
  const cancelledRef = useRef(false);

  const refresh = useCallback(async () => {
    const [next, followSnapshot] = await Promise.all([getCoReadingRangeSnapshot(bookId), getCoReadingSnapshot(bookId)]);
    store.getState().setCoReadingSnapshot?.(followSnapshot);
    window.dispatchEvent(
      new CustomEvent("deepreader:reading-map-updated", {
        detail: { bookId, snapshot: next },
      }),
    );
    return next;
  }, [bookId, store]);

  const createAnnotation = useCallback(
    async (block: CoReadingBlock, quote: string, comment: string) => {
      if (!view) throw new Error("阅读视图尚未就绪");
      const resolved = view.resolveCFI(block.cfi);
      const section = view.book.sections?.[resolved.index];
      const doc = await section?.createDocument?.();
      if (!doc) throw new Error("无法载入范围阅读章节");
      const baseRange = resolved.anchor(doc);
      const quoteRange = locateExactQuoteRange(baseRange, quote);
      if (!quoteRange || quoteRange.toString() !== quote) throw new Error("无法精确定位 Nova 引文");
      const cfi = view.getCFI(resolved.index, quoteRange);
      const existing = (await getBookNotes(bookId)).find(
        (note) => note.author === "ai" && note.cfi === cfi && note.text === quote,
      );
      if (existing) return existing;
      const note = await createBookNote({
        bookId,
        type: "annotation",
        cfi,
        text: quote,
        style: "underline",
        color: "blue",
        author: "ai",
        note: comment,
        context: contextAroundRange(quoteRange),
      });
      const notes = store.getState().config?.booknotes ?? [];
      const config = store.getState().updateBooknotes([...notes, note]);
      view.addAnnotation(note);
      if (config) await store.getState().saveConfig(config);
      await queryClient.invalidateQueries({
        queryKey: ["annotations", bookId],
      });
      return note;
    },
    [bookId, queryClient, store, view],
  );

  const runTask = useCallback(
    async (task: CoReadingRangeTask) => {
      if (runningRef.current || !view || !bookData?.bookDoc?.sections) return;
      runningRef.current = true;
      cancelledRef.current = false;
      try {
        let current = task;
        while (!cancelledRef.current && current.status === "running" && current.cursorIndex <= current.endIndex) {
          if (current.scannedCount >= current.candidateLimit || current.requestCount >= current.requestLimit) {
            await updateCoReadingRangeTask(current.id, "completed");
            break;
          }
          const sectionIndex = current.cursorIndex;
          const section = bookData.bookDoc.sections[sectionIndex];
          const doc = await section?.createDocument?.();
          if (!doc) throw new Error(`无法载入${current.rangeKind === "page" ? "第" : "章节 "}${sectionIndex + 1}`);
          const sectionLabel = getCoReadingSectionLabel(
            buildCoReadingRangeOptions(bookData.bookDoc, bookData.book.format),
            sectionIndex,
            bookData.book.format,
          );
          const isPercentageTask = current.startCharOffset != null && current.endCharOffset != null;
          const sectionTextLength = getDocumentCoReadingTextLength(doc);
          const charBoundary = isPercentageTask
            ? {
                start: sectionIndex === current.startIndex ? current.startCharOffset! : 0,
                end: sectionIndex === current.endIndex ? current.endCharOffset! : sectionTextLength,
              }
            : undefined;
          const extracted = extractDocumentCoReadingBlocks(bookId, view, doc, sectionIndex, sectionLabel, charBoundary);
          const seen = new Set<string>();
          const remainingBudget = Math.max(0, current.candidateLimit - current.scannedCount);
          const footprints: CoReadingFootprintUpsert[] = extracted.slice(0, remainingBudget).map((block) => {
            const classified = classifyRangeCandidate(block, seen);
            return {
              ...block,
              taskId: current.id,
              status: classified.status,
              reason: classified.reason,
              summary: null,
              comment: null,
              annotationId: null,
              processedAt: null,
            };
          });
          await upsertCoReadingFootprints(footprints);
          const candidates = footprints.filter((item) => item.status === "candidate").map(toDecisionBlock);
          let selected: CoReadingBlock[] = [];
          let requestDelta = 0;
          if (candidates.length > 0 && current.requestCount < current.requestLimit) {
            const selectedKeys = normalizeSelectedBlockKeys(
              await requestCoReadingSelection(candidates, (await getCoReadingSnapshot(bookId)).settings),
              candidates,
              current.perSectionLimit,
            );
            requestDelta++;
            selected = candidates.filter((block) => selectedKeys.includes(block.blockKey));
            await upsertCoReadingFootprints(
              footprints
                .filter((item) => selectedKeys.includes(item.blockKey))
                .map((item) => ({ ...item, status: "selected" as const })),
            );
          }
          if (selected.length > 0 && current.requestCount + requestDelta < current.requestLimit) {
            try {
              const settings = (await getCoReadingSnapshot(bookId)).settings;
              const recentFootprints = (await getCoReadingRangeSnapshot(bookId)).footprints
                .filter((item) => item.processedAt && item.sectionIndex < sectionIndex)
                .slice(-6)
                .map(toDecisionBlock);
              const recentAnnotations = (await getBookNotes(bookId))
                .filter((note) => note.author === "ai")
                .slice(-8)
                .map((note) => `“${note.text ?? ""}” ${note.note}`);
              const decision = await requestCoReadingBatchDecision(
                {
                  newBlocks: selected,
                  recentBlocks: recentFootprints,
                  rollingSummary: settings.rollingSummary,
                  annotations: recentAnnotations,
                  estimatedInputTokens: 0,
                },
                settings,
              );
              requestDelta++;
              const validated = validateCoReadingBatchDecision(decision, selected, current.perSectionLimit);
              const annotationsByBlock = new Map(validated.annotations.map((item) => [item.block.blockKey, item]));
              const updates: CoReadingFootprintUpsert[] = [];
              for (const block of selected) {
                const base = footprints.find((item) => item.blockKey === block.blockKey)!;
                const annotation = annotationsByBlock.get(block.blockKey);
                if (!annotation) {
                  updates.push({
                    ...base,
                    status: "silent",
                    summary: validated.summary,
                    processedAt: Date.now(),
                  });
                  continue;
                }
                const note = await createAnnotation(block, annotation.quote, annotation.comment);
                updates.push({
                  ...base,
                  status: "annotated",
                  summary: validated.summary,
                  comment: annotation.comment,
                  annotationId: note.id,
                  processedAt: Date.now(),
                });
              }
              await upsertCoReadingFootprints(updates);
              await updateCoReadingSettings({
                bookId,
                status: settings.status,
                dwellSeconds: settings.dwellSeconds,
                rollingSummary: validated.summary,
              });
            } catch (error) {
              await upsertCoReadingFootprints(
                selected.map((block) => {
                  const base = footprints.find((item) => item.blockKey === block.blockKey)!;
                  return {
                    ...base,
                    status: "failed" as const,
                    reason: error instanceof Error ? error.message : String(error),
                    processedAt: Date.now(),
                  };
                }),
              );
            }
          }
          current = await advanceCoReadingRangeTask({
            taskId: current.id,
            cursorIndex: sectionIndex + 1,
            scannedDelta: footprints.length,
            selectedDelta: selected.length,
            processedDelta: selected.length,
            requestDelta,
          });
          await refresh();
        }
        if (!cancelledRef.current && current.status === "running" && current.cursorIndex > current.endIndex) {
          await updateCoReadingRangeTask(current.id, "completed");
        }
      } catch (error) {
        await updateCoReadingRangeTask(task.id, "failed", error instanceof Error ? error.message : String(error));
      } finally {
        runningRef.current = false;
        await refresh();
      }
    },
    [bookData?.book.format, bookData?.bookDoc, bookId, createAnnotation, refresh, view],
  );

  useEffect(() => {
    let active = true;
    const check = () =>
      refresh().then((snapshot) => {
        if (!active) return;
        const running = snapshot.tasks.find((task) => task.status === "running");
        if (running) void runTask(running);
      });
    void check();
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ bookId: string }>).detail;
      if (detail?.bookId === bookId) void check();
    };
    window.addEventListener("deepreader:range-task-changed", handler);
    return () => {
      active = false;
      cancelledRef.current = true;
      window.removeEventListener("deepreader:range-task-changed", handler);
    };
  }, [bookId, refresh, runTask]);
}

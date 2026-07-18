import {
  getCoReadingErrorInfo,
  validateCoReadingItemResult,
} from "@/lib/co-reading-core";
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
} from "@/lib/co-reading-range";
import {
  coordinateRangeWorkerLease,
  isRangeWorkerLifecycleCurrent,
} from "@/lib/co-reading-run-state";
import { getBookNotes } from "@/services/book-note-service";
import { requestCoReadingItem } from "@/services/co-reading-ai-service";
import {
  failCoReadingRangeSection,
  getCoReadingRangeSnapshot,
  getCoReadingSnapshot,
  persistCoReadingRangeSection,
  updateCoReadingRangeTask,
} from "@/services/co-reading-service";
import type {
  CoReadingBlock,
  CoReadingFootprintUpsert,
  CoReadingNoteCreateData,
  CoReadingRangeTask,
} from "@/types/co-reading";
import { useQueryClient } from "@tanstack/react-query";
import { md5 } from "js-md5";
import { useCallback, useEffect, useRef } from "react";
import {
  useReaderStore,
  useReaderStoreApi,
} from "../components/reader-provider";

function toDecisionBlock(block: CoReadingFootprintUpsert): CoReadingBlock {
  const now = Date.now();
  return {
    id: block.id,
    bookId: block.bookId,
    blockKey: block.blockKey,
    focusKey: `range:${block.taskId}:${block.sectionIndex}`,
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

class RangeTaskCancelledError extends Error {
  constructor() {
    super("范围阅读任务已被用户暂停、停止或终结");
    this.name = "RangeTaskCancelledError";
  }
}

export function useCoReadingRange(bookId: string): void {
  const store = useReaderStoreApi();
  const view = useReaderStore((state) => state.view);
  const bookData = useReaderStore((state) => state.bookData);
  const queryClient = useQueryClient();
  const runningRef = useRef(false);
  const mountedRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const activeRunRef = useRef<{
    generation: number;
    controller: AbortController;
    taskId: string;
    expectedUpdatedAt: number;
  } | null>(null);
  const runTaskRef = useRef<
    ((task: CoReadingRangeTask, generation: number) => Promise<void>) | null
  >(null);

  const isLifecycleCurrent = useCallback(
    (generation: number) =>
      isRangeWorkerLifecycleCurrent({
        mounted: mountedRef.current,
        cancelled: false,
        generation,
        currentGeneration: lifecycleGenerationRef.current,
      }),
    []
  );

  const refresh = useCallback(
    async (generation: number) => {
      const [next, followSnapshot] = await Promise.all([
        getCoReadingRangeSnapshot(bookId),
        getCoReadingSnapshot(bookId),
      ]);
      if (!isLifecycleCurrent(generation)) return next;
      store.getState().setCoReadingSnapshot?.(followSnapshot);
      window.dispatchEvent(
        new CustomEvent("deepreader:reading-map-updated", {
          detail: { bookId, snapshot: next },
        })
      );
      return next;
    },
    [bookId, isLifecycleCurrent, store]
  );

  const prepareAnnotation = useCallback(
    async (
      task: CoReadingRangeTask,
      block: CoReadingBlock,
      quote: string,
      comment: string
    ): Promise<CoReadingNoteCreateData> => {
      if (!view) throw new Error("阅读视图尚未就绪");
      const resolved = view.resolveCFI(block.cfi);
      const section = view.book.sections?.[resolved.index];
      const doc = await section?.createDocument?.();
      if (!doc) throw new Error("无法载入范围阅读章节");
      const baseRange = resolved.anchor(doc);
      const quoteRange = locateExactQuoteRange(baseRange, quote);
      if (!quoteRange || quoteRange.toString() !== quote)
        throw new Error("无法精确定位 Nova 引文");
      return {
        id: md5(`${bookId}:range:${task.id}:${block.blockKey}:${quote}`),
        blockKey: block.blockKey,
        type: "annotation",
        cfi: view.getCFI(resolved.index, quoteRange),
        text: quote,
        style: "underline",
        color: "blue",
        note: comment,
        context: contextAroundRange(quoteRange),
      };
    },
    [bookId, view]
  );

  const runTask = useCallback(
    async (task: CoReadingRangeTask, generation: number) => {
      if (
        runningRef.current ||
        !isLifecycleCurrent(generation) ||
        !view ||
        !bookData?.book ||
        !bookData.bookDoc?.sections
      )
        return;
      const book = bookData.book;
      const bookDoc = bookData.bookDoc;
      const sections = bookDoc.sections!;
      const controller = new AbortController();
      runningRef.current = true;
      activeRunRef.current = {
        generation,
        controller,
        taskId: task.id,
        expectedUpdatedAt: task.updatedAt,
      };
      let current = task;
      let sectionFailureAttempted = false;
      let activeSectionIndex = task.cursorIndex;
      let activeSectionFootprints: CoReadingFootprintUpsert[] = [];
      let activeRequestDelta = 0;
      let activePreparedNotes: CoReadingNoteCreateData[] = [];
      const updateActiveLease = (updatedTask: CoReadingRangeTask) => {
        const activeRun = activeRunRef.current;
        if (
          activeRun?.generation === generation &&
          activeRun.controller === controller &&
          activeRun.taskId === updatedTask.id
        ) {
          activeRun.expectedUpdatedAt = updatedTask.updatedAt;
        }
      };
      const assertLifecycle = () => {
        if (!isLifecycleCurrent(generation) || controller.signal.aborted) {
          throw new RangeTaskCancelledError();
        }
      };
      const getCurrentLeaseSnapshot = async () => {
        assertLifecycle();
        const snapshot = await getCoReadingRangeSnapshot(bookId);
        assertLifecycle();
        const latest = snapshot.tasks.find(
          (candidate) => candidate.id === current.id
        );
        if (
          !latest ||
          latest.status !== "running" ||
          latest.updatedAt !== current.updatedAt
        ) {
          throw new RangeTaskCancelledError();
        }
        return snapshot;
      };
      const assertRangeTaskRunning = async (): Promise<void> => {
        assertLifecycle();
        await getCurrentLeaseSnapshot();
        assertLifecycle();
      };
      try {
        const seenTextHashes = new Set(
          (await getCurrentLeaseSnapshot()).footprints
            .filter(
              (item) =>
                item.taskId === task.id && item.sectionIndex < task.cursorIndex
            )
            .map((item) => item.textHash)
        );
        while (
          isLifecycleCurrent(generation) &&
          !controller.signal.aborted &&
          current.status === "running" &&
          current.cursorIndex <= current.endIndex
        ) {
          activeSectionIndex = current.cursorIndex;
          activeSectionFootprints = [];
          activeRequestDelta = 0;
          activePreparedNotes = [];
          if (current.requestCount >= current.requestLimit) {
            throw new Error("范围阅读请求预算不足，已保留当前位置以便继续");
          }
          const sectionIndex = current.cursorIndex;
          const section = sections[sectionIndex];
          const doc = await section?.createDocument?.();
          if (!doc)
            throw new Error(
              `无法载入${current.rangeKind === "page" ? "第" : "章节 "}${
                sectionIndex + 1
              }`
            );
          const sectionLabel = getCoReadingSectionLabel(
            buildCoReadingRangeOptions(bookDoc, book.format),
            sectionIndex,
            book.format
          );
          const isPercentageTask =
            current.startCharOffset != null && current.endCharOffset != null;
          const sectionTextLength = getDocumentCoReadingTextLength(doc);
          const charBoundary = isPercentageTask
            ? {
                start:
                  sectionIndex === current.startIndex
                    ? current.startCharOffset!
                    : 0,
                end:
                  sectionIndex === current.endIndex
                    ? current.endCharOffset!
                    : sectionTextLength,
              }
            : undefined;
          const extracted = extractDocumentCoReadingBlocks(
            bookId,
            view,
            doc,
            sectionIndex,
            sectionLabel,
            charBoundary
          );
          const footprints: CoReadingFootprintUpsert[] = extracted.map(
            (block) => {
              const classified = classifyRangeCandidate(block, seenTextHashes);
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
            }
          );
          activeSectionFootprints = footprints;
          const selected = footprints
            .filter((item) => item.status === "candidate")
            .map(toDecisionBlock);
          let requestDelta = 0;
          await assertRangeTaskRunning();
          const settings = (await getCoReadingSnapshot(bookId)).settings;
          assertLifecycle();
          if (
            selected.length > 0 &&
            current.requestCount + requestDelta < current.requestLimit
          ) {
            const recentFootprints = (
              await getCurrentLeaseSnapshot()
            ).footprints
              .filter(
                (item) =>
                  item.taskId === current.id &&
                  item.processedAt &&
                  item.sectionIndex < sectionIndex
              )
              .slice(-6)
              .map(toDecisionBlock);
            const recentAnnotations = (await getBookNotes(bookId))
              .filter((note) => note.author === "ai")
              .slice(-8)
              .map((note) => `“${note.text ?? ""}” ${note.note}`);
            await assertRangeTaskRunning();
            requestDelta++;
            activeRequestDelta = requestDelta;
            try {
              const decision = await requestCoReadingItem(
                {
                  newBlocks: selected,
                  recentBlocks: recentFootprints,
                  rollingSummary: settings.rollingSummary,
                  annotations: recentAnnotations,
                  estimatedInputTokens: 0,
                },
                settings,
                controller.signal
              );
              await assertRangeTaskRunning();
              const validated = validateCoReadingItemResult(decision, selected);
              const annotationsByBlock = new Map<
                string,
                typeof validated.annotations
              >();
              for (const annotation of validated.annotations) {
                const blockAnnotations =
                  annotationsByBlock.get(annotation.block.blockKey) ?? [];
                blockAnnotations.push(annotation);
                annotationsByBlock.set(
                  annotation.block.blockKey,
                  blockAnnotations
                );
              }
              const processedAt = Date.now();
              const updates: CoReadingFootprintUpsert[] = footprints
                .filter((item) => item.status === "filtered")
                .map((item) => ({
                  ...item,
                  annotationId: null,
                  comment: null,
                  processedAt,
                }));
              const preparedNotes: CoReadingNoteCreateData[] = [];
              activePreparedNotes = preparedNotes;
              for (const block of selected) {
                const base = footprints.find(
                  (item) => item.blockKey === block.blockKey
                )!;
                const blockAnnotations =
                  annotationsByBlock.get(block.blockKey) ?? [];
                if (blockAnnotations.length === 0) {
                  updates.push({
                    ...base,
                    status: "silent",
                    summary: validated.summary,
                    processedAt,
                  });
                  continue;
                }
                let representativeNoteId: string | null = null;
                for (const annotation of blockAnnotations) {
                  await assertRangeTaskRunning();
                  const note = await prepareAnnotation(
                    current,
                    block,
                    annotation.quote,
                    annotation.comment
                  );
                  preparedNotes.push(note);
                  representativeNoteId ??= note.id;
                }
                const representative = blockAnnotations[0]!;
                updates.push({
                  ...base,
                  status: "annotated",
                  summary: validated.summary,
                  comment: representative.comment,
                  annotationId: representativeNoteId!,
                  processedAt,
                });
              }
              await assertRangeTaskRunning();
              const persisted = await persistCoReadingRangeSection({
                taskId: current.id,
                expectedUpdatedAt: current.updatedAt,
                cursorIndex: sectionIndex + 1,
                scannedDelta: footprints.length,
                selectedDelta: selected.length,
                processedDelta: selected.length,
                requestDelta,
                notes: preparedNotes,
                footprints: updates,
                rollingSummary: validated.summary,
              });
              assertLifecycle();
              current = persisted.task;
              updateActiveLease(current);
              if (persisted.notes.length > 0) {
                try {
                  const existingNotes =
                    store.getState().config?.booknotes ?? [];
                  const persistedIds = new Set(
                    persisted.notes.map((note) => note.id)
                  );
                  const config = store
                    .getState()
                    .updateBooknotes([
                      ...existingNotes.filter(
                        (note) => !persistedIds.has(note.id)
                      ),
                      ...persisted.notes,
                    ]);
                  for (const note of persisted.notes) view.addAnnotation(note);
                  if (config) await store.getState().saveConfig(config);
                  await queryClient.invalidateQueries({
                    queryKey: ["annotations", bookId],
                  });
                } catch (uiError) {
                  console.error("范围书评已保存，但阅读视图同步失败", uiError);
                }
              }
            } catch (error) {
              if (error instanceof RangeTaskCancelledError) throw error;
              const info = getCoReadingErrorInfo(error);
              const failedAt = Date.now();
              const failedFootprints = footprints.map((base) => ({
                ...base,
                status:
                  base.status === "filtered"
                    ? ("filtered" as const)
                    : ("failed" as const),
                reason: base.status === "filtered" ? base.reason : info.message,
                summary: null,
                comment: null,
                annotationId: null,
                processedAt: failedAt,
              }));
              await assertRangeTaskRunning();
              sectionFailureAttempted = true;
              current = (
                await failCoReadingRangeSection({
                  taskId: current.id,
                  expectedUpdatedAt: current.updatedAt,
                  requestDelta,
                  error: info.message,
                  footprints: failedFootprints,
                })
              ).task;
              updateActiveLease(current);
              return;
            }
          } else {
            await assertRangeTaskRunning();
            const processedAt = Date.now();
            const finalFiltered = footprints.map((item) => ({
              ...item,
              status: "filtered" as const,
              annotationId: null,
              comment: null,
              processedAt,
            }));
            const persisted = await persistCoReadingRangeSection({
              taskId: current.id,
              expectedUpdatedAt: current.updatedAt,
              cursorIndex: sectionIndex + 1,
              scannedDelta: footprints.length,
              selectedDelta: 0,
              processedDelta: 0,
              requestDelta: 0,
              notes: [],
              footprints: finalFiltered,
              rollingSummary: settings.rollingSummary,
            });
            assertLifecycle();
            current = persisted.task;
            updateActiveLease(current);
          }
          await refresh(generation);
        }
        if (
          isLifecycleCurrent(generation) &&
          !controller.signal.aborted &&
          current.status === "running" &&
          current.cursorIndex > current.endIndex
        ) {
          current = await updateCoReadingRangeTask(
            current.id,
            "completed",
            undefined,
            current.updatedAt
          );
          updateActiveLease(current);
        }
      } catch (error) {
        if (sectionFailureAttempted) {
          console.error("保存范围阅读失败状态失败", error);
          return;
        }
        if (
          error instanceof RangeTaskCancelledError ||
          !isLifecycleCurrent(generation)
        ) {
          return;
        }
        let latest: CoReadingRangeTask | undefined;
        try {
          latest = (await getCoReadingRangeSnapshot(bookId)).tasks.find(
            (candidate) => candidate.id === current.id
          );
        } catch (snapshotError) {
          console.error("校验范围阅读任务租约失败", snapshotError);
          return;
        }
        if (
          !latest ||
          latest.status !== "running" ||
          latest.updatedAt !== current.updatedAt
        ) {
          // A persist may have committed even if its IPC response was lost. The newer
          // revision owns the ledger; this stale worker must never fail or rebind it.
          if (
            latest?.id === current.id &&
            latest.cursorIndex > activeSectionIndex
          ) {
            const preparedIds = new Set(
              activePreparedNotes.map((note) => note.id)
            );
            if (preparedIds.size > 0) {
              try {
                const persistedNotes = (await getBookNotes(bookId)).filter(
                  (note) => preparedIds.has(note.id)
                );
                if (
                  persistedNotes.length > 0 &&
                  isLifecycleCurrent(generation)
                ) {
                  const existingNotes =
                    store.getState().config?.booknotes ?? [];
                  const config = store
                    .getState()
                    .updateBooknotes([
                      ...existingNotes.filter(
                        (note) => !preparedIds.has(note.id)
                      ),
                      ...persistedNotes,
                    ]);
                  for (const note of persistedNotes) view.addAnnotation(note);
                  if (config) await store.getState().saveConfig(config);
                  await queryClient.invalidateQueries({
                    queryKey: ["annotations", bookId],
                  });
                }
              } catch (uiError) {
                console.error("范围章节已提交，但书评 UI 对账失败", uiError);
              }
            }
          }
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        try {
          const failedAt = Date.now();
          const failureFootprints = activeSectionFootprints.map((base) => ({
            ...base,
            status:
              base.status === "filtered"
                ? ("filtered" as const)
                : ("failed" as const),
            reason: base.status === "filtered" ? base.reason : message,
            summary: null,
            comment: null,
            annotationId: null,
            processedAt: failedAt,
          }));
          sectionFailureAttempted = true;
          current = (
            await failCoReadingRangeSection({
              taskId: current.id,
              expectedUpdatedAt: current.updatedAt,
              requestDelta: activeRequestDelta,
              error: message,
              footprints: failureFootprints,
            })
          ).task;
          updateActiveLease(current);
        } catch (transitionError) {
          try {
            const refreshed = (
              await getCoReadingRangeSnapshot(bookId)
            ).tasks.find((candidate) => candidate.id === current.id);
            if (
              !refreshed ||
              refreshed.status !== "running" ||
              refreshed.updatedAt !== current.updatedAt
            ) {
              return;
            }
          } catch (snapshotError) {
            console.error("校验范围阅读失败转换租约失败", snapshotError);
            return;
          }
          console.error("标记范围阅读任务失败", transitionError);
        }
      } finally {
        const ownsRun =
          activeRunRef.current?.generation === generation &&
          activeRunRef.current.controller === controller;
        if (!ownsRun) return;
        activeRunRef.current = null;
        runningRef.current = false;
        if (!isLifecycleCurrent(generation)) return;
        try {
          const snapshot = await refresh(generation);
          if (!isLifecycleCurrent(generation)) return;
          const next = snapshot.tasks.find((item) => item.status === "running");
          if (next) {
            window.setTimeout(() => {
              if (!isLifecycleCurrent(generation)) return;
              void runTaskRef.current?.(next, generation).catch((runError) => {
                console.error("启动范围阅读任务失败", runError);
              });
            }, 0);
          }
        } catch (refreshError) {
          if (isLifecycleCurrent(generation))
            console.error("刷新范围阅读任务失败", refreshError);
        }
      }
    },
    [
      bookData?.book?.format,
      bookData?.bookDoc,
      bookId,
      isLifecycleCurrent,
      prepareAnnotation,
      queryClient,
      refresh,
      store,
      view,
    ]
  );
  runTaskRef.current = runTask;

  useEffect(() => {
    mountedRef.current = true;
    const generation = ++lifecycleGenerationRef.current;
    let active = true;
    const check = async () => {
      try {
        const snapshot = await refresh(generation);
        if (!active || !isLifecycleCurrent(generation)) return;
        const activeRun = activeRunRef.current;
        if (activeRun?.generation === generation) {
          const directive = coordinateRangeWorkerLease(
            {
              taskId: activeRun.taskId,
              expectedUpdatedAt: activeRun.expectedUpdatedAt,
            },
            snapshot.tasks
          );
          if (directive.shouldAbort) activeRun.controller.abort();
        }
        const running = snapshot.tasks.find(
          (task) => task.status === "running"
        );
        if (running) await runTask(running, generation);
      } catch (error) {
        if (active && isLifecycleCurrent(generation))
          console.error("检查范围阅读任务失败", error);
      }
    };
    void check();
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ bookId: string }>).detail;
      if (detail?.bookId === bookId) void check();
    };
    window.addEventListener("deepreader:range-task-changed", handler);
    return () => {
      active = false;
      mountedRef.current = false;
      lifecycleGenerationRef.current += 1;
      if (activeRunRef.current?.generation === generation) {
        activeRunRef.current.controller.abort();
        activeRunRef.current = null;
        runningRef.current = false;
      }
      window.removeEventListener("deepreader:range-task-changed", handler);
    };
  }, [bookId, isLifecycleCurrent, refresh, runTask]);
}

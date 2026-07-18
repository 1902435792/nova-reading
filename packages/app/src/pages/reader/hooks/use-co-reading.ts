import {
  buildCoReadingBatch,
  mergeTrackedCoReadingState,
  sanitizeCoReadingError,
  validateCoReadingItemResult,
} from "@/lib/co-reading-core";
import {
  contextAroundRange,
  extractVisibleCoReadingFocus,
  locateExactQuoteRange,
  resolveVisibleCoReadingRanges,
} from "@/lib/co-reading-dom";
import { resolveCoReadingModel } from "@/lib/co-reading-model";
import {
  CoReadingFocusCancelledError,
  identifyVisibleFocus,
  isClaimedFocusCommitted,
  isCoReadingFocusCancellation,
  isRangeTakeoverCancellation,
  sameVisibleFocus,
  selectVisibleQueuedFocus,
  shouldDrainCoReadingQueue,
  type VisibleQueuedFocus,
} from "@/lib/co-reading-run-state";
import { requestCoReadingItem } from "@/services/co-reading-ai-service";
import {
  claimCoReadingBlocks,
  completeCoReadingBatch,
  getCoReadingSnapshot,
  persistCoReadingFocus,
  releaseCoReadingFocus,
  upsertCoReadingBlocks,
} from "@/services/co-reading-service";
import { useProviderStore } from "@/store/provider-store";
import type {
  CoReadingBlock,
  CoReadingBlockUpsert,
  CoReadingNoteCreateData,
} from "@/types/co-reading";
import { useQueryClient } from "@tanstack/react-query";
import { md5 } from "js-md5";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useReaderStore,
  useReaderStoreApi,
} from "../components/reader-provider";

const TICK_MS = 1_000;
const FLUSH_MS = 5_000;

interface TrackedBlock extends CoReadingBlockUpsert {
  status: "tracking" | "queued";
}

interface OrdinaryCoReadingRun {
  generation: number;
  controller: AbortController;
  focus: VisibleQueuedFocus;
}

export function useCoReading(bookId: string, isVisible: boolean): void {
  const store = useReaderStoreApi();
  const view = useReaderStore((state) => state.view);
  const progress = useReaderStore((state) => state.progress);
  const snapshot = useReaderStore((state) => state.coReadingSnapshot);
  const selectedModel = useProviderStore((state) => state.selectedModel);
  const modelProviders = useProviderStore((state) => state.modelProviders);
  const coReadingModel = resolveCoReadingModel(
    snapshot?.settings,
    selectedModel,
    modelProviders
  );
  const queryClient = useQueryClient();
  const [samplingTick, setSamplingTick] = useState(0);

  const visibleBlocksRef = useRef<TrackedBlock[]>([]);
  const visibleFocusRef = useRef<VisibleQueuedFocus | null>(null);
  const trackedRef = useRef(new Map<string, TrackedBlock>());
  const observedAtRef = useRef(new Map<string, number>());
  const dirtyRef = useRef(new Set<string>());
  const processingRef = useRef(false);
  const runBlockedRef = useRef(false);
  const samplingGenerationRef = useRef(0);
  const workerGenerationRef = useRef(0);
  const activeRunRef = useRef<OrdinaryCoReadingRun | null>(null);
  const blockedFocusKeyRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await getCoReadingSnapshot(bookId);
    if (mountedRef.current) store.getState().setCoReadingSnapshot(nextSnapshot);
    return nextSnapshot;
  }, [bookId, store]);

  const updateRuntime = useCallback(() => {
    const leading = visibleBlocksRef.current[0];
    const visibleFocus = visibleFocusRef.current;
    const visibleKeys = new Set(visibleFocus?.blockKeys ?? []);
    const persistedVisible =
      store
        .getState()
        .coReadingSnapshot?.blocks.filter((block) =>
          visibleKeys.has(block.blockKey)
        ) ?? [];
    store.getState().setCoReadingRuntime({
      visibleBlockCount: visibleFocus?.blockKeys.length ?? 0,
      visibleQueuedBlockCount: visibleBlocksRef.current.filter(
        (block) => block.status === "queued"
      ).length,
      visibleFailedBlockCount: persistedVisible.filter(
        (block) => block.status === "failed"
      ).length,
      leadingBlockKey: leading?.blockKey ?? visibleFocus?.blockKeys[0] ?? null,
      leadingBlockDwellMs: leading?.dwellMs ?? 0,
      focusKey: visibleFocus?.focusKey ?? null,
      runBlocked:
        runBlockedRef.current &&
        blockedFocusKeyRef.current === visibleFocus?.focusKey,
    });
  }, [store]);

  const getVisibleQueuedBlocks = useCallback(
    (nextSnapshot = store.getState().coReadingSnapshot): CoReadingBlock[] => {
      if (!nextSnapshot) return [];
      const visibleFocus = visibleFocusRef.current;
      const pendingFocus = identifyVisibleFocus(visibleBlocksRef.current);
      if (
        !visibleFocus ||
        !pendingFocus ||
        pendingFocus.focusKey !== visibleFocus.focusKey
      )
        return [];
      const blocksByKey = new Map(
        nextSnapshot.blocks.map((block) => [block.blockKey, block])
      );
      const matched = pendingFocus.blockKeys
        .map((blockKey) => blocksByKey.get(blockKey))
        .filter((block): block is CoReadingBlock => Boolean(block));
      const queuedFocus = selectVisibleQueuedFocus(matched);
      return sameVisibleFocus(pendingFocus, queuedFocus) ? matched : [];
    },
    [store]
  );

  const cancelRunOutsideFocus = useCallback(
    (nextFocus: VisibleQueuedFocus | null) => {
      const active = activeRunRef.current;
      if (
        !active ||
        (nextFocus?.focusKey === active.focus.focusKey &&
          active.focus.blockKeys.every((key) =>
            nextFocus.blockKeys.includes(key)
          ))
      )
        return;
      const reason = new CoReadingFocusCancelledError();
      active.controller.abort(reason);
      // Release immediately as well as in the worker catch. This closes the small window
      // between navigation and the aborted model promise unwinding; the Rust API is idempotent.
      void releaseCoReadingFocus({
        bookId,
        blockKeys: active.focus.blockKeys,
      }).catch(() => {
        // The worker performs the authoritative release/commit check after it unwinds.
      });
    },
    [bookId]
  );

  const flush = useCallback(async () => {
    const blocks = Array.from(dirtyRef.current)
      .map((blockKey) => trackedRef.current.get(blockKey))
      .filter((block): block is TrackedBlock => Boolean(block));
    if (blocks.length === 0) return;

    dirtyRef.current.clear();
    try {
      const saved = await upsertCoReadingBlocks(blocks);
      for (const block of saved) {
        if (block.status !== "tracking" && block.status !== "queued") continue;
        const tracked = trackedRef.current.get(block.blockKey);
        if (!tracked) continue;
        Object.assign(tracked, mergeTrackedCoReadingState(tracked, block));
      }
      updateRuntime();
      const nextSnapshot = await getCoReadingSnapshot(bookId);
      if (mountedRef.current)
        store.getState().setCoReadingSnapshot(nextSnapshot);
    } catch (error) {
      for (const block of blocks) dirtyRef.current.add(block.blockKey);
      store.getState().setCoReadingRuntime({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [bookId, store, updateRuntime]);

  const prepareAiAnnotation = useCallback(
    async (
      block: CoReadingBlock,
      quote: string,
      comment: string
    ): Promise<CoReadingNoteCreateData> => {
      if (!view) throw new Error("阅读视图尚未就绪");
      const resolved = view.resolveCFI(block.cfi);
      const content = view.renderer
        .getContents()
        .find((item) => item.index === resolved.index);
      const section = view.book.sections?.[resolved.index];
      const doc = content?.doc ?? (await section?.createDocument?.());
      if (!doc) throw new Error("无法载入批注对应的已解锁章节");

      const baseRange = resolved.anchor(doc);
      const quoteRange = locateExactQuoteRange(baseRange, quote);
      if (!quoteRange || quoteRange.toString() !== quote) {
        throw new Error("无法在已解锁原文中精确定位模型引文");
      }
      const cfi = view.getCFI(resolved.index, quoteRange);
      const id = md5(
        `${bookId}:${block.focusKey ?? block.blockKey}:${
          block.blockKey
        }:${quote}`
      );
      return {
        id,
        blockKey: block.blockKey,
        type: "annotation",
        cfi,
        text: quote,
        style: "underline",
        color: "blue",
        note: comment,
        context: contextAroundRange(quoteRange),
      };
    },
    [bookId, view]
  );

  const failClaimedBlocks = useCallback(
    async (claimed: CoReadingBlock[], error: unknown) => {
      const message = sanitizeCoReadingError(error);
      let lastError: unknown = error;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await completeCoReadingBatch({
            bookId,
            blockKeys: claimed.map((block) => block.blockKey),
            status: "failed",
            error: message,
          });
          store.getState().setCoReadingRuntime({ error: message });
          return;
        } catch (cleanupError) {
          lastError = cleanupError;
          if (attempt === 0) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
          }
        }
      }
      throw lastError;
    },
    [bookId, store]
  );

  const drainQueue = useCallback(async () => {
    const currentSnapshot = store.getState().coReadingSnapshot;
    if (!currentSnapshot) return;
    const queued = getVisibleQueuedBlocks(currentSnapshot);
    const focus = selectVisibleQueuedFocus(queued);
    const currentFocusBlocked =
      runBlockedRef.current && blockedFocusKeyRef.current === focus?.focusKey;
    if (
      !focus ||
      !shouldDrainCoReadingQueue({
        status: currentSnapshot.settings.status,
        queuedCount: queued.length,
        modelReady: Boolean(coReadingModel),
        runBlocked: currentFocusBlocked,
        processing: processingRef.current,
      })
    )
      return;

    const generation = ++workerGenerationRef.current;
    const controller = new AbortController();
    activeRunRef.current = { generation, controller, focus };
    processingRef.current = true;

    const ownsRun = () => {
      const active = activeRunRef.current;
      return (
        mountedRef.current &&
        active?.generation === generation &&
        active.controller === controller
      );
    };
    const assertCurrentFocus = () => {
      if (
        !ownsRun() ||
        controller.signal.aborted ||
        visibleFocusRef.current?.focusKey !== focus.focusKey ||
        !focus.blockKeys.every((key) =>
          visibleFocusRef.current?.blockKeys.includes(key)
        )
      ) {
        throw new CoReadingFocusCancelledError();
      }
    };

    store.getState().setCoReadingRuntime({
      isProcessing: true,
      processingStartedAt: Date.now(),
      runBlocked: false,
      error: null,
    });
    let claimed: CoReadingBlock[] = [];
    try {
      assertCurrentFocus();
      const recent = currentSnapshot.blocks
        .filter(
          (block) => block.status === "silent" || block.status === "annotated"
        )
        .sort((a, b) => (b.processedAt ?? 0) - (a.processedAt ?? 0));
      const aiNotes = (store.getState().config?.booknotes ?? [])
        .filter((note) => note.author === "ai")
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((note) => `“${note.text ?? ""}” ${note.note}`);
      const batch = buildCoReadingBatch({
        queued,
        recent,
        rollingSummary: currentSnapshot.settings.rollingSummary,
        annotations: aiNotes,
      });
      // One complete visible page/spread remains the indivisible request and failure unit.
      batch.newBlocks = queued;
      if (batch.newBlocks.length === 0)
        throw new Error("当前可见页面没有待处理正文");

      claimed = await claimCoReadingBlocks(bookId, focus.blockKeys);
      if (claimed.length === 0) return;
      assertCurrentFocus();
      store.getState().setCoReadingRuntime({
        processingBlockCount: claimed.length,
        focusKey: focus.focusKey,
      });

      try {
        const decision = await requestCoReadingItem(
          { ...batch, newBlocks: claimed },
          currentSnapshot.settings,
          controller.signal
        );
        assertCurrentFocus();
        const validated = validateCoReadingItemResult(decision, claimed);
        const preparedNotes = await Promise.all(
          validated.annotations.map((annotation) =>
            prepareAiAnnotation(
              annotation.block,
              annotation.quote,
              annotation.comment
            )
          )
        );
        assertCurrentFocus();
        const persisted = await persistCoReadingFocus({
          bookId,
          blockKeys: claimed.map((block) => block.blockKey),
          notes: preparedNotes,
          rollingSummary: validated.summary,
        });
        if (persisted.notes.length > 0) {
          try {
            const existingNotes = store.getState().config?.booknotes ?? [];
            const persistedIds = new Set(
              persisted.notes.map((note) => note.id)
            );
            const updatedConfig = store
              .getState()
              .updateBooknotes([
                ...existingNotes.filter((note) => !persistedIds.has(note.id)),
                ...persisted.notes,
              ]);
            if (sameVisibleFocus(focus, visibleFocusRef.current)) {
              for (const note of persisted.notes) view?.addAnnotation(note);
            }
            if (updatedConfig) await store.getState().saveConfig(updatedConfig);
            await queryClient.invalidateQueries({
              queryKey: ["annotations", bookId],
            });
          } catch (error) {
            store.getState().setCoReadingRuntime({
              error: `书评已保存，但阅读视图刷新失败：${sanitizeCoReadingError(
                error
              )}`,
            });
          }
        }
      } catch (error) {
        const navigationCancelled =
          isCoReadingFocusCancellation(error) ||
          (controller.signal.aborted &&
            isCoReadingFocusCancellation(controller.signal.reason));
        if (navigationCancelled) {
          if (claimed.length > 0) {
            await releaseCoReadingFocus({
              bookId,
              blockKeys: claimed.map((block) => block.blockKey),
            });
          }
          await refreshSnapshot();
          return;
        }
        if (isRangeTakeoverCancellation(error)) {
          await refreshSnapshot();
          store.getState().setCoReadingRuntime({
            runBlocked: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        const message = sanitizeCoReadingError(error);
        let committedAfterResponseLoss = false;
        try {
          const latest = await refreshSnapshot();
          committedAfterResponseLoss = isClaimedFocusCommitted(
            claimed.map((block) => block.blockKey),
            latest.blocks
          );
        } catch {
          // If the verification read also fails, preserve the normal failure path.
        }

        if (committedAfterResponseLoss) {
          store.getState().setCoReadingRuntime({
            error: "当前页面已保存，但客户端未收到持久化响应；已避免重复写入",
          });
        } else {
          let finalMessage = message;
          try {
            await failClaimedBlocks(claimed, error);
          } catch (cleanupError) {
            finalMessage = `${message}；失败状态写入失败：${sanitizeCoReadingError(
              cleanupError
            )}`;
          }
          runBlockedRef.current = true;
          blockedFocusKeyRef.current = focus.focusKey;
          store.getState().setCoReadingRuntime({
            runBlocked: true,
            error: finalMessage,
          });
        }
      }
    } catch (error) {
      const navigationCancelled =
        isCoReadingFocusCancellation(error) ||
        (controller.signal.aborted &&
          isCoReadingFocusCancellation(controller.signal.reason));
      if (navigationCancelled && claimed.length > 0) {
        await releaseCoReadingFocus({
          bookId,
          blockKeys: claimed.map((block) => block.blockKey),
        });
        await refreshSnapshot();
      } else if (!navigationCancelled) {
        store.getState().setCoReadingRuntime({
          error: sanitizeCoReadingError(error),
        });
      }
    } finally {
      if (!ownsRun()) return;
      activeRunRef.current = null;
      processingRef.current = false;
      store.getState().setCoReadingRuntime({
        isProcessing: false,
        processingBlockCount: 0,
        processingStartedAt: null,
        runBlocked:
          runBlockedRef.current &&
          blockedFocusKeyRef.current === visibleFocusRef.current?.focusKey,
      });
      try {
        const latest = await refreshSnapshot();
        const nextQueued = getVisibleQueuedBlocks(latest);
        const nextFocus = selectVisibleQueuedFocus(nextQueued);
        if (
          shouldDrainCoReadingQueue({
            status: latest.settings.status,
            queuedCount: nextQueued.length,
            modelReady: Boolean(coReadingModel),
            runBlocked:
              runBlockedRef.current &&
              blockedFocusKeyRef.current === nextFocus?.focusKey,
            processing: processingRef.current,
          })
        ) {
          window.setTimeout(() => void drainQueue(), 0);
        }
      } catch (error) {
        store.getState().setCoReadingRuntime({
          error: sanitizeCoReadingError(error),
        });
      }
    }
  }, [
    bookId,
    coReadingModel,
    failClaimedBlocks,
    getVisibleQueuedBlocks,
    prepareAiAnnotation,
    refreshSnapshot,
    store,
    view,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    refreshSnapshot().catch((error) => {
      store.getState().setCoReadingRuntime({
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return () => {
      mountedRef.current = false;
      const active = activeRunRef.current;
      if (active && !active.controller.signal.aborted) {
        active.controller.abort(
          new CoReadingFocusCancelledError("阅读器已关闭")
        );
      }
    };
  }, [refreshSnapshot, store]);

  useEffect(() => {
    const handleRetry = (event: Event) => {
      const detail = (event as CustomEvent<{ bookId?: string }>).detail;
      if (detail?.bookId !== bookId) return;
      runBlockedRef.current = false;
      blockedFocusKeyRef.current = null;
      samplingGenerationRef.current += 1;
      store.getState().setCoReadingRuntime({ runBlocked: false, error: null });
      // Failed blocks become queued in SQLite before this event. Resample the actual current
      // page first; off-screen retried history remains queued until the user revisits it.
      setSamplingTick((value) => value + 1);
      void refreshSnapshot().catch((error) => {
        runBlockedRef.current = true;
        blockedFocusKeyRef.current = visibleFocusRef.current?.focusKey ?? null;
        store.getState().setCoReadingRuntime({
          runBlocked: true,
          error: sanitizeCoReadingError(error),
        });
      });
    };
    window.addEventListener("deepreader:co-reading-retry", handleRetry);
    return () =>
      window.removeEventListener("deepreader:co-reading-retry", handleRetry);
  }, [bookId, refreshSnapshot, store]);

  useEffect(() => {
    if (
      !view ||
      !progress ||
      snapshot?.settings.status !== "active" ||
      !isVisible
    ) {
      visibleFocusRef.current = null;
      cancelRunOutsideFocus(null);
      visibleBlocksRef.current = [];
      observedAtRef.current.clear();
      updateRuntime();
      return;
    }

    let cancelled = false;
    const generation = ++samplingGenerationRef.current;
    const visibleRanges = resolveVisibleCoReadingRanges(view, progress);
    if (visibleRanges.length === 0) {
      visibleFocusRef.current = null;
      cancelRunOutsideFocus(null);
      visibleBlocksRef.current = [];
      store.getState().setCoReadingRuntime({
        error: "当前可见页尚未稳定，正在等待阅读视图完成布局",
      });
      updateRuntime();
      return;
    }
    const extracted = extractVisibleCoReadingFocus(
      bookId,
      view,
      visibleRanges,
      progress.sectionLabel
    );
    const extractedFocus = identifyVisibleFocus(extracted);
    if (
      blockedFocusKeyRef.current &&
      blockedFocusKeyRef.current !== extractedFocus?.focusKey
    ) {
      runBlockedRef.current = false;
      blockedFocusKeyRef.current = null;
      store.getState().setCoReadingRuntime({ runBlocked: false, error: null });
    }
    visibleFocusRef.current = extractedFocus;
    cancelRunOutsideFocus(extractedFocus);

    upsertCoReadingBlocks(extracted)
      .then((saved) => {
        if (cancelled || generation !== samplingGenerationRef.current) return;
        const visible: TrackedBlock[] = [];
        for (const block of saved) {
          if (block.status !== "tracking" && block.status !== "queued")
            continue;
          const existing = trackedRef.current.get(block.blockKey);
          const tracked: TrackedBlock = {
            id: block.id,
            bookId: block.bookId,
            blockKey: block.blockKey,
            focusKey: block.focusKey ?? block.blockKey,
            sectionIndex: block.sectionIndex,
            sectionLabel: block.sectionLabel,
            cfi: block.cfi,
            text: block.text,
            textHash: block.textHash,
            dwellMs: Math.max(existing?.dwellMs ?? 0, block.dwellMs),
            status: existing?.status === "queued" ? "queued" : block.status,
            unlockedAt: existing?.unlockedAt ?? block.unlockedAt,
          };
          trackedRef.current.set(block.blockKey, tracked);
          visible.push(tracked);
        }
        visibleBlocksRef.current = visible;
        const now = performance.now();
        const visibleKeys = new Set(visible.map((block) => block.blockKey));
        for (const key of observedAtRef.current.keys()) {
          if (!visibleKeys.has(key)) observedAtRef.current.delete(key);
        }
        for (const block of visible) {
          if (!observedAtRef.current.has(block.blockKey))
            observedAtRef.current.set(block.blockKey, now);
        }
        updateRuntime();
      })
      .catch((error) => {
        store.getState().setCoReadingRuntime({
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
      const now = performance.now();
      if (isVisible && document.visibilityState === "visible") {
        for (const block of visibleBlocksRef.current) {
          if (block.status !== "tracking") continue;
          const observedAt = observedAtRef.current.get(block.blockKey) ?? now;
          block.dwellMs += Math.round(
            Math.max(0, Math.min(now - observedAt, TICK_MS * 1.5))
          );
          observedAtRef.current.set(block.blockKey, now);
          dirtyRef.current.add(block.blockKey);
        }
        void flush();
      }
      visibleBlocksRef.current = [];
      updateRuntime();
    };
  }, [
    bookId,
    cancelRunOutsideFocus,
    flush,
    isVisible,
    progress,
    snapshot?.settings.status,
    samplingTick,
    store,
    updateRuntime,
    view,
  ]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const currentSnapshot = store.getState().coReadingSnapshot;
      const now = performance.now();
      if (
        currentSnapshot?.settings.status !== "active" ||
        !isVisible ||
        document.visibilityState !== "visible"
      ) {
        for (const block of visibleBlocksRef.current)
          observedAtRef.current.set(block.blockKey, now);
        return;
      }

      const threshold = currentSnapshot.settings.dwellSeconds * 1_000;
      let unlocked = false;
      const focusBlocks = visibleBlocksRef.current.filter(
        (block) => block.status === "tracking"
      );
      let focusDwellMs = Number.POSITIVE_INFINITY;
      for (const block of focusBlocks) {
        const observedAt = observedAtRef.current.get(block.blockKey) ?? now;
        const elapsed = Math.max(0, Math.min(now - observedAt, TICK_MS * 1.5));
        observedAtRef.current.set(block.blockKey, now);
        block.dwellMs += Math.round(elapsed);
        focusDwellMs = Math.min(focusDwellMs, block.dwellMs);
        dirtyRef.current.add(block.blockKey);
      }
      if (focusBlocks.length > 0 && focusDwellMs >= threshold) {
        const unlockedAt = Date.now();
        for (const block of focusBlocks) {
          block.status = "queued";
          block.unlockedAt ??= unlockedAt;
          dirtyRef.current.add(block.blockKey);
        }
        unlocked = true;
      }
      updateRuntime();
      if (unlocked) {
        void flush()
          .then(() => drainQueue())
          .catch((error) => {
            runBlockedRef.current = true;
            blockedFocusKeyRef.current =
              visibleFocusRef.current?.focusKey ?? null;
            store.getState().setCoReadingRuntime({
              runBlocked: true,
              error: sanitizeCoReadingError(error),
            });
          });
      }
    }, TICK_MS);
    return () => window.clearInterval(interval);
  }, [drainQueue, flush, isVisible, store, updateRuntime]);

  useEffect(() => {
    const interval = window.setInterval(() => void flush(), FLUSH_MS);
    return () => {
      window.clearInterval(interval);
      void flush();
    };
  }, [flush]);

  useEffect(() => {
    const visibleQueued = getVisibleQueuedBlocks(snapshot);
    const visibleFocus = selectVisibleQueuedFocus(visibleQueued);
    if (
      shouldDrainCoReadingQueue({
        status: snapshot?.settings.status,
        queuedCount: visibleQueued.length,
        modelReady: Boolean(coReadingModel),
        runBlocked:
          runBlockedRef.current &&
          blockedFocusKeyRef.current === visibleFocus?.focusKey,
        processing: processingRef.current,
      })
    ) {
      void drainQueue().catch((error) => {
        runBlockedRef.current = true;
        blockedFocusKeyRef.current = visibleFocusRef.current?.focusKey ?? null;
        store.getState().setCoReadingRuntime({
          runBlocked: true,
          error: sanitizeCoReadingError(error),
        });
      });
    }
  }, [
    coReadingModel,
    drainQueue,
    getVisibleQueuedBlocks,
    samplingTick,
    snapshot,
    store,
  ]);

  useEffect(() => {
    if (!view || snapshot?.settings.status !== "active" || !isVisible) return;
    let timer: number | undefined;
    const resample = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setSamplingTick((value) => value + 1);
      }, 250);
    };
    view.addEventListener("load", resample);
    view.addEventListener("relocate", resample);
    window.addEventListener("foliate-layout-stable", resample);
    resample();
    return () => {
      if (timer) window.clearTimeout(timer);
      view.removeEventListener("load", resample);
      view.removeEventListener("relocate", resample);
      window.removeEventListener("foliate-layout-stable", resample);
    };
  }, [isVisible, snapshot?.settings.status, store, view]);
}

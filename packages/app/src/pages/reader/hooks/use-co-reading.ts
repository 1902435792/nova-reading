import {
  buildCoReadingBatch,
  mergeTrackedCoReadingState,
  sanitizeCoReadingError,
  validateCoReadingBatchDecision,
} from "@/lib/co-reading-core";
import { contextAroundRange, extractVisibleCoReadingBlocks, locateExactQuoteRange } from "@/lib/co-reading-dom";
import { resolveCoReadingModel } from "@/lib/co-reading-model";
import { createBookNote, getBookNotes } from "@/services/book-note-service";
import { requestCoReadingBatchDecision } from "@/services/co-reading-ai-service";
import {
  claimCoReadingBlocks,
  completeCoReadingBatch,
  getCoReadingSnapshot,
  getQueuedCoReadingBlocks,
  upsertCoReadingBlocks,
} from "@/services/co-reading-service";
import { useProviderStore } from "@/store/provider-store";
import type { BookNote } from "@/types/book";
import type { CoReadingBlock, CoReadingBlockUpsert } from "@/types/co-reading";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useReaderStore, useReaderStoreApi } from "../components/reader-provider";

const TICK_MS = 1_000;
const FLUSH_MS = 5_000;

interface TrackedBlock extends CoReadingBlockUpsert {
  status: "tracking" | "queued";
}

export function useCoReading(bookId: string, isVisible: boolean): void {
  const store = useReaderStoreApi();
  const view = useReaderStore((state) => state.view);
  const progress = useReaderStore((state) => state.progress);
  const snapshot = useReaderStore((state) => state.coReadingSnapshot);
  const selectedModel = useProviderStore((state) => state.selectedModel);
  const modelProviders = useProviderStore((state) => state.modelProviders);
  const coReadingModel = resolveCoReadingModel(snapshot?.settings, selectedModel, modelProviders);
  const queryClient = useQueryClient();

  const visibleBlocksRef = useRef<TrackedBlock[]>([]);
  const trackedRef = useRef(new Map<string, TrackedBlock>());
  const observedAtRef = useRef(new Map<string, number>());
  const dirtyRef = useRef(new Set<string>());
  const processingRef = useRef(false);
  const mountedRef = useRef(true);

  const refreshSnapshot = useCallback(async () => {
    const nextSnapshot = await getCoReadingSnapshot(bookId);
    if (mountedRef.current) store.getState().setCoReadingSnapshot(nextSnapshot);
    return nextSnapshot;
  }, [bookId, store]);

  const updateRuntime = useCallback(() => {
    const leading = visibleBlocksRef.current[0];
    store.getState().setCoReadingRuntime({
      visibleBlockCount: visibleBlocksRef.current.length,
      leadingBlockKey: leading?.blockKey ?? null,
      leadingBlockDwellMs: leading?.dwellMs ?? 0,
    });
  }, [store]);

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
      if (mountedRef.current) store.getState().setCoReadingSnapshot(nextSnapshot);
    } catch (error) {
      for (const block of blocks) dirtyRef.current.add(block.blockKey);
      store.getState().setCoReadingRuntime({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [bookId, store, updateRuntime]);

  const createAiAnnotation = useCallback(
    async (block: CoReadingBlock, quote: string, comment: string): Promise<BookNote> => {
      if (!view) throw new Error("阅读视图尚未就绪");
      const resolved = view.resolveCFI(block.cfi);
      const content = view.renderer.getContents().find((item) => item.index === resolved.index);
      const section = view.book.sections?.[resolved.index];
      const doc = content?.doc ?? (await section?.createDocument?.());
      if (!doc) throw new Error("无法载入批注对应的已解锁章节");

      const baseRange = resolved.anchor(doc);
      const quoteRange = locateExactQuoteRange(baseRange, quote);
      if (!quoteRange || quoteRange.toString() !== quote) {
        throw new Error("无法在已解锁原文中精确定位模型引文");
      }
      const cfi = view.getCFI(resolved.index, quoteRange);
      const existingNotes = await getBookNotes(bookId);
      const existing = existingNotes.find((note) => note.author === "ai" && note.cfi === cfi && note.text === quote);
      if (existing) return existing;

      const context = contextAroundRange(quoteRange);
      const note = await createBookNote({
        bookId,
        type: "annotation",
        cfi,
        text: quote,
        style: "underline",
        color: "blue",
        author: "ai",
        note: comment,
        context,
      });

      const currentNotes = store.getState().config?.booknotes ?? [];
      const updatedConfig = store.getState().updateBooknotes([...currentNotes, note]);
      view.addAnnotation(note);
      if (updatedConfig) await store.getState().saveConfig(updatedConfig);
      await queryClient.invalidateQueries({
        queryKey: ["annotations", bookId],
      });
      return note;
    },
    [bookId, queryClient, store, view],
  );

  const failClaimedBlocks = useCallback(
    async (claimed: CoReadingBlock[], error: unknown) => {
      const message = sanitizeCoReadingError(error);
      await completeCoReadingBatch({
        bookId,
        blockKeys: claimed.map((block) => block.blockKey),
        status: "failed",
        error: message,
      });
      store.getState().setCoReadingRuntime({ error: message });
    },
    [bookId, store],
  );

  const drainQueue = useCallback(async () => {
    if (processingRef.current || !coReadingModel) return;
    const currentSnapshot = store.getState().coReadingSnapshot;
    if (currentSnapshot?.settings.status !== "active") return;

    processingRef.current = true;
    store.getState().setCoReadingRuntime({ isProcessing: true, error: null });
    try {
      const queued = await getQueuedCoReadingBlocks(bookId, 20);
      if (queued.length === 0) return;

      const recent = currentSnapshot.blocks
        .filter((block) => block.status === "silent" || block.status === "annotated")
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
      if (batch.newBlocks.length === 0) throw new Error("待处理文本块超过共读上下文预算");

      const claimed = await claimCoReadingBlocks(
        bookId,
        batch.newBlocks.map((block) => block.blockKey),
      );
      if (claimed.length === 0) return;

      try {
        const decision = await requestCoReadingBatchDecision(
          { ...batch, newBlocks: claimed },
          currentSnapshot.settings,
        );
        const validated = validateCoReadingBatchDecision(decision, claimed);
        const noteByBlock = new Map<string, BookNote>();
        for (const annotation of validated.annotations) {
          noteByBlock.set(
            annotation.block.blockKey,
            await createAiAnnotation(annotation.block, annotation.quote, annotation.comment),
          );
        }
        for (const block of claimed) {
          const note = noteByBlock.get(block.blockKey);
          await completeCoReadingBatch(
            note
              ? {
                  bookId,
                  blockKeys: [block.blockKey],
                  status: "annotated",
                  decision: "annotate",
                  annotationId: note.id,
                  annotatedBlockKey: block.blockKey,
                  rollingSummary: validated.summary,
                }
              : {
                  bookId,
                  blockKeys: [block.blockKey],
                  status: "silent",
                  decision: "silent",
                  rollingSummary: validated.summary,
                },
          );
        }
      } catch (error) {
        await failClaimedBlocks(claimed, error);
      }
    } catch (error) {
      store.getState().setCoReadingRuntime({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      processingRef.current = false;
      store.getState().setCoReadingRuntime({ isProcessing: false });
      try {
        const latest = await refreshSnapshot();
        if (latest.settings.status === "active" && latest.stats.queued > 0 && coReadingModel) {
          window.setTimeout(() => void drainQueue(), 0);
        }
      } catch (error) {
        store.getState().setCoReadingRuntime({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }, [bookId, coReadingModel, createAiAnnotation, failClaimedBlocks, refreshSnapshot, store]);

  useEffect(() => {
    mountedRef.current = true;
    refreshSnapshot().catch((error) => {
      store.getState().setCoReadingRuntime({
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return () => {
      mountedRef.current = false;
    };
  }, [refreshSnapshot, store]);

  useEffect(() => {
    if (!view || !progress?.range || snapshot?.settings.status !== "active" || !isVisible) {
      visibleBlocksRef.current = [];
      observedAtRef.current.clear();
      updateRuntime();
      return;
    }

    let cancelled = false;
    const extracted = extractVisibleCoReadingBlocks(bookId, view, progress.range, progress.sectionLabel);
    upsertCoReadingBlocks(extracted)
      .then((saved) => {
        if (cancelled) return;
        const visible: TrackedBlock[] = [];
        for (const block of saved) {
          if (block.status !== "tracking" && block.status !== "queued") continue;
          const existing = trackedRef.current.get(block.blockKey);
          const tracked: TrackedBlock = {
            id: block.id,
            bookId: block.bookId,
            blockKey: block.blockKey,
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
          if (!observedAtRef.current.has(block.blockKey)) observedAtRef.current.set(block.blockKey, now);
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
          block.dwellMs += Math.round(Math.max(0, Math.min(now - observedAt, TICK_MS * 1.5)));
          observedAtRef.current.set(block.blockKey, now);
          dirtyRef.current.add(block.blockKey);
        }
        void flush();
      }
      visibleBlocksRef.current = [];
      updateRuntime();
    };
  }, [bookId, flush, isVisible, progress, snapshot?.settings.status, store, updateRuntime, view]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      const currentSnapshot = store.getState().coReadingSnapshot;
      const now = performance.now();
      if (currentSnapshot?.settings.status !== "active" || !isVisible || document.visibilityState !== "visible") {
        for (const block of visibleBlocksRef.current) observedAtRef.current.set(block.blockKey, now);
        return;
      }

      const threshold = currentSnapshot.settings.dwellSeconds * 1_000;
      let unlocked = false;
      for (const block of visibleBlocksRef.current) {
        if (block.status !== "tracking") continue;
        const observedAt = observedAtRef.current.get(block.blockKey) ?? now;
        const elapsed = Math.max(0, Math.min(now - observedAt, TICK_MS * 1.5));
        observedAtRef.current.set(block.blockKey, now);
        block.dwellMs += Math.round(elapsed);
        if (block.dwellMs >= threshold) {
          block.status = "queued";
          block.unlockedAt ??= Date.now();
          unlocked = true;
        }
        dirtyRef.current.add(block.blockKey);
      }
      updateRuntime();
      if (unlocked) {
        void flush().then(() => drainQueue());
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
    if (snapshot?.settings.status === "active" && snapshot.stats.queued > 0 && coReadingModel) {
      void drainQueue();
    }
  }, [coReadingModel, drainQueue, snapshot?.settings.status, snapshot?.stats.queued]);
}

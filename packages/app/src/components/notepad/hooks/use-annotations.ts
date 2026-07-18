import { validateCoReadingReviewResult } from "@/lib/co-reading-core";
import {
  createBookNote,
  deleteBookNote,
  getBookNotes,
  updateBookNote,
} from "@/services/book-note-service";
import { useReaderStoreApi } from "@/pages/reader/components/reader-provider";
import { requestCoReadingReview } from "@/services/co-reading-ai-service";
import { getCoReadingSnapshot } from "@/services/co-reading-service";
import type { BookNote } from "@/types/book";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

interface UseAnnotationsProps {
  bookId?: string;
}

export const useAnnotations = ({ bookId }: UseAnnotationsProps = {}) => {
  const queryClient = useQueryClient();
  const readerStore = useReaderStoreApi();

  // 获取当前书籍的所有标注
  const {
    data: annotations,
    error,
    isLoading,
    status,
  } = useQuery({
    queryKey: ["annotations", bookId],
    queryFn: async () => {
      if (!bookId) return [];
      const bookNotes = await getBookNotes(bookId);
      // 过滤出类型为 annotation 且未删除的笔记，并按创建时间倒序排列
      return bookNotes
        .filter((note) => note.type === "annotation" && !note.deletedAt)
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
    },
    enabled: !!bookId,
  });

  const handleGenerateAiReview = useCallback(
    async (source: BookNote): Promise<BookNote> => {
      if (!bookId) throw new Error("当前书籍尚未就绪");
      if (
        source.author === "ai" ||
        source.style !== "underline" ||
        !source.text?.trim()
      ) {
        throw new Error("AI 书评仅适用于用户手动创建的下划线");
      }
      const [settingsSnapshot, notes] = await Promise.all([
        getCoReadingSnapshot(bookId),
        getBookNotes(bookId),
      ]);
      const existing = notes.find(
        (note) => note.author === "ai" && note.sourceNoteId === source.id
      );
      const readerState = readerStore.getState();
      const readerIsCurrentBook = readerState.bookId === bookId;
      const recentAiAnnotations = notes
        .filter((note) => note.author === "ai" && note.id !== existing?.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 8)
        .map((note) => `“${note.text ?? ""}” ${note.note}`);
      const result = await requestCoReadingReview(
        {
          text: source.text,
          contextBefore: source.context?.before ?? "",
          contextAfter: source.context?.after ?? "",
          humanNote: source.note ?? "",
          rollingSummary: settingsSnapshot.settings.rollingSummary,
          recentAiAnnotations,
        },
        settingsSnapshot.settings
      );
      const review = validateCoReadingReviewResult(result);
      const saved = existing
        ? await updateBookNote(existing.id, { note: review })
        : await createBookNote({
            bookId,
            type: "annotation",
            cfi: source.cfi,
            text: source.text,
            style: "underline",
            color: "blue",
            author: "ai",
            sourceNoteId: source.id,
            note: review,
            context: source.context,
          });
      if (readerIsCurrentBook) {
        const view = readerStore.getState().view;
        const currentNotes = readerStore.getState().config?.booknotes ?? notes;
        const hasCurrentSaved = currentNotes.some(
          (note) => note.id === saved.id
        );
        const nextNotes = hasCurrentSaved
          ? currentNotes.map((note) => (note.id === saved.id ? saved : note))
          : [...currentNotes, saved];
        if (existing) await view?.addAnnotation(existing, true);
        await view?.addAnnotation(saved);
        const updatedConfig = readerStore.getState().updateBooknotes(nextNotes);
        if (updatedConfig)
          await readerStore.getState().saveConfig(updatedConfig);
      }
      await queryClient.invalidateQueries({
        queryKey: ["annotations", bookId],
      });
      toast.success(existing ? "AI 书评已重新生成" : "AI 书评已生成");
      return saved;
    },
    [bookId, queryClient, readerStore]
  );

  // 删除标注
  const handleDeleteAnnotation = useCallback(
    async (annotationId: string) => {
      try {
        const readerState = readerStore.getState();
        const readerIsCurrentBook = readerState.bookId === bookId;
        const currentNotes = readerIsCurrentBook
          ? readerState.config?.booknotes ??
            (bookId ? await getBookNotes(bookId) : [])
          : [];
        const removed = currentNotes.filter(
          (note) =>
            note.id === annotationId || note.sourceNoteId === annotationId
        );
        await deleteBookNote(annotationId);
        if (readerIsCurrentBook) {
          const view = readerStore.getState().view;
          for (const note of removed) view?.addAnnotation(note, true);
          const nextNotes = currentNotes.filter(
            (note) =>
              note.id !== annotationId && note.sourceNoteId !== annotationId
          );
          const updatedConfig = readerStore
            .getState()
            .updateBooknotes(nextNotes);
          if (updatedConfig)
            await readerStore.getState().saveConfig(updatedConfig);
        }
        toast.success("标注删除成功");

        // 刷新标注列表
        await queryClient.invalidateQueries({
          queryKey: ["annotations", bookId],
        });
      } catch (error) {
        console.error("删除标注失败:", error);
        toast.error("删除标注失败");
        throw error;
      }
    },
    [bookId, queryClient, readerStore]
  );

  return {
    annotations: annotations ?? [],
    error,
    isLoading,
    status,
    handleDeleteAnnotation,
    handleGenerateAiReview,
  };
};

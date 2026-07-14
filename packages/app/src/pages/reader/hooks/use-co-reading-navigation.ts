import { navigateToReadingSource } from "@/components/side-chat/co-reading-backlink";
import { useEffect } from "react";
import { toast } from "sonner";
import { useReaderStore, useReaderStoreApi } from "../components/reader-provider";

export function useCoReadingNavigation(bookId: string): void {
  const store = useReaderStoreApi();
  const view = useReaderStore((state) => state.view);
  const pendingSource = useReaderStore((state) => state.pendingCoReadingSource);

  useEffect(() => {
    if (!view || !pendingSource || pendingSource.bookId !== bookId) return;
    let cancelled = false;

    void navigateToReadingSource(view, pendingSource).then((result) => {
      if (cancelled) return;
      if (result.precision === "exact") toast.success(result.message);
      else if (result.precision === "fallback") toast.warning(result.message);
      else toast.error(result.message);
      store.getState().setPendingCoReadingSource(null);
    });

    return () => {
      cancelled = true;
    };
  }, [bookId, pendingSource, store, view]);
}

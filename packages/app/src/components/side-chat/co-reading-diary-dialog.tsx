import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  CO_READING_DIARY_COUNT_PRESETS,
  CO_READING_DIARY_DEFAULT_COUNT,
  CO_READING_DIARY_MAX_COUNT,
  CO_READING_DIARY_MIN_COUNT,
  buildCoReadingDiaryPayload,
  getCoReadingDiarySelectionState,
} from "@/lib/co-reading-diary";
import { createCoReadingDiary } from "@/services/co-reading-diary-service";
import { getCoReadingRangeSnapshot } from "@/services/co-reading-service";
import type { CoReadingFootprint, CoReadingSettings } from "@/types/co-reading";
import { LoaderCircle, NotebookPen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

interface CoReadingDiaryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookId: string;
  bookTitle: string;
  settings: Pick<CoReadingSettings, "modelProviderId" | "modelId">;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CoReadingDiaryDialog({ open, onOpenChange, bookId, bookTitle, settings }: CoReadingDiaryDialogProps) {
  const [requestedCount, setRequestedCount] = useState(CO_READING_DIARY_DEFAULT_COUNT);
  const [footprints, setFootprints] = useState<CoReadingFootprint[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoading(true);
    setFeedback(null);
    getCoReadingRangeSnapshot(bookId)
      .then((snapshot) => {
        if (!cancelled) setFootprints(snapshot.footprints);
      })
      .catch((error) => {
        if (!cancelled) setFeedback({ kind: "error", message: errorMessage(error) });
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, open]);

  const selection = useMemo(
    () => getCoReadingDiarySelectionState(footprints, requestedCount),
    [footprints, requestedCount],
  );
  const { eligibleCount, selectedCount, validCount } = selection;

  const handleSubmit = async () => {
    try {
      setIsSubmitting(true);
      setFeedback(null);
      const payload = buildCoReadingDiaryPayload(bookTitle, footprints, requestedCount);
      const message = await createCoReadingDiary(payload, settings);
      const successMessage = message.trim() || `已将 ${payload.selectedCount} 条共读记录写入今日日记`;
      setFeedback({ kind: "success", message: successMessage });
      toast.success(successMessage);
    } catch (error) {
      const message = errorMessage(error);
      setFeedback({ kind: "error", message });
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !isSubmitting && onOpenChange(nextOpen)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NotebookPen className="size-5 text-primary" />
            共读日记
          </DialogTitle>
          <DialogDescription className="px-0">
            严格按时间选择《{bookTitle}》最近的 Nova 共读记录，交给专用日记服务整理。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 p-4">
          <div>
            <p className="mb-2 font-medium text-sm">最近记录条数</p>
            <div className="flex flex-wrap gap-2">
              {CO_READING_DIARY_COUNT_PRESETS.map((count) => (
                <Button
                  key={count}
                  type="button"
                  size="xs"
                  variant={requestedCount === count ? "default" : "outline"}
                  onClick={() => setRequestedCount(count)}
                  disabled={isSubmitting}
                >
                  {count}
                </Button>
              ))}
              <label className="flex items-center gap-2 text-muted-foreground text-xs">
                自定义
                <Input
                  className="h-7 w-20"
                  type="number"
                  min={CO_READING_DIARY_MIN_COUNT}
                  max={CO_READING_DIARY_MAX_COUNT}
                  step={1}
                  value={requestedCount}
                  onChange={(event) => setRequestedCount(Number(event.target.value))}
                  disabled={isSubmitting}
                  aria-label="自定义共读记录条数"
                />
              </label>
            </div>
            {!validCount && (
              <p className="mt-2 text-destructive text-xs">
                请输入 {CO_READING_DIARY_MIN_COUNT}–{CO_READING_DIARY_MAX_COUNT} 的整数。
              </p>
            )}
          </div>

          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            {isLoading ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                正在读取 AI 共读记录…
              </p>
            ) : eligibleCount === 0 ? (
              <p className="text-muted-foreground">还没有可写入的 AI 共读记录，请先完成一次 Nova 共读。</p>
            ) : eligibleCount < requestedCount ? (
              <p>现有 {eligibleCount} 条记录，将全部写入。</p>
            ) : (
              <p>将按最新时间写入 {selectedCount} 条记录。</p>
            )}
          </div>

          {feedback && (
            <p
              role="status"
              className={
                feedback.kind === "success"
                  ? "rounded-lg border border-border bg-muted/50 p-3 text-foreground text-sm"
                  : "rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive text-sm"
              }
            >
              {feedback.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            取消
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isLoading || isSubmitting || !selection.canSubmit}
          >
            {isSubmitting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                正在写入…
              </>
            ) : (
              `写入今日日记 (${selectedCount})`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
import { getCoReadingDiarySources } from "@/services/co-reading-service";
import type { CoReadingDiarySourceRecord } from "@/types/co-reading";
import { LoaderCircle, NotebookPen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

interface CoReadingDiaryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookId: string;
  bookTitle: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CoReadingDiaryDialog({
  open,
  onOpenChange,
  bookId,
  bookTitle,
}: CoReadingDiaryDialogProps) {
  const [requestedCount, setRequestedCount] = useState(
    CO_READING_DIARY_DEFAULT_COUNT
  );
  const [sources, setSources] = useState<CoReadingDiarySourceRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  const loadSources = useCallback(async () => {
    setIsLoading(true);
    try {
      setSources(await getCoReadingDiarySources(bookId));
    } finally {
      setIsLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFeedback(null);
    setIsLoading(true);
    getCoReadingDiarySources(bookId)
      .then((records) => {
        if (!cancelled) setSources(records);
      })
      .catch((error) => {
        if (!cancelled) {
          setFeedback({ kind: "error", message: errorMessage(error) });
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId, open]);

  const selection = useMemo(
    () => getCoReadingDiarySelectionState(sources, requestedCount),
    [requestedCount, sources]
  );
  const {
    totalCount,
    activeExistingCount,
    eligibleCount,
    unwrittenCount,
    alreadyWrittenCount,
    selectedCount,
    validCount,
  } = selection;

  const handleSubmit = async () => {
    try {
      setIsSubmitting(true);
      setFeedback(null);
      const payload = buildCoReadingDiaryPayload(
        bookTitle,
        sources,
        requestedCount
      );
      const result = await createCoReadingDiary(bookId, payload);
      const successMessage =
        result.message ||
        `VCP 已将 ${result.writtenCount} 条共读记录写入今日日记`;
      setFeedback({ kind: "success", message: successMessage });
      toast.success(successMessage);
      await loadSources();
    } catch (error) {
      const message = errorMessage(error);
      setFeedback({ kind: "error", message });
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !isSubmitting && onOpenChange(nextOpen)}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NotebookPen className="size-5 text-primary" />
            Agent
          </DialogTitle>
          <DialogDescription className="px-0">
            从《{bookTitle}》尚未写入的共读记录中选取最近一段阅读脉络，使用问答
            Agent 当前模型交给 VCP 后端整理并写入日记。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 p-4">
          <div>
            <p className="mb-2 font-medium text-sm">本次最多写入</p>
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
                  onChange={(event) =>
                    setRequestedCount(Number(event.target.value))
                  }
                  disabled={isSubmitting}
                  aria-label="自定义 Agent 记录条数"
                />
              </label>
            </div>
            {!validCount && (
              <p className="mt-2 text-destructive text-xs">
                请输入 {CO_READING_DIARY_MIN_COUNT}–{CO_READING_DIARY_MAX_COUNT}{" "}
                的整数。
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground text-xs">全部共读来源</p>
              <p className="mt-1 font-semibold">{totalCount}</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground text-xs">现存唯一记录</p>
              <p className="mt-1 font-semibold">{activeExistingCount}</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground text-xs">符合写入条件</p>
              <p className="mt-1 font-semibold">{eligibleCount}</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground text-xs">尚未写入</p>
              <p className="mt-1 font-semibold">{unwrittenCount}</p>
            </div>
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-muted-foreground text-xs">已经写入</p>
              <p className="mt-1 font-semibold">{alreadyWrittenCount}</p>
            </div>
          </div>

          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            {isLoading ? (
              <p className="flex items-center gap-2 text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                正在读取共读记录…
              </p>
            ) : activeExistingCount === 0 ? (
              <p className="text-muted-foreground">
                当前没有现存的 AI 共读记录。
              </p>
            ) : unwrittenCount === 0 ? (
              <p className="text-muted-foreground">
                当前符合条件的记录都已经写入日记。
              </p>
            ) : (
              <p>
                本次将选取 {selectedCount}{" "}
                条尚未写入记录，并按阅读位置正序提交：前页/前段在前，后页/后段在后。
              </p>
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
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
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
                VCP 正在写入…
              </>
            ) : (
              `交给 VCP 写入 (${selectedCount})`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

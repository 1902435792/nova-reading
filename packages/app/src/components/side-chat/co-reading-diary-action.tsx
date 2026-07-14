import { Button } from "@/components/ui/button";
import type { CoReadingSettings } from "@/types/co-reading";
import { NotebookPen } from "lucide-react";
import { useState } from "react";
import { CoReadingDiaryDialog } from "./co-reading-diary-dialog";

interface CoReadingDiaryActionProps {
  bookId: string;
  bookTitle: string;
  settings: Pick<CoReadingSettings, "modelProviderId" | "modelId">;
}

export function CoReadingDiaryAction({ bookId, bookTitle, settings }: CoReadingDiaryActionProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <section className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold text-sm">
            <NotebookPen className="size-4 text-primary" />
            共读日记
          </p>
          <p className="mt-1 text-muted-foreground text-xs">选择最近的 AI 共读记录，写入今日日记。</p>
        </div>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          创建日记
        </Button>
      </section>
      <CoReadingDiaryDialog
        open={open}
        onOpenChange={setOpen}
        bookId={bookId}
        bookTitle={bookTitle}
        settings={settings}
      />
    </>
  );
}

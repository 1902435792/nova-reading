import { Button } from "@/components/ui/button";
import { NotebookPen } from "lucide-react";
import { useState } from "react";
import { CoReadingDiaryDialog } from "./co-reading-diary-dialog";

interface CoReadingDiaryActionProps {
  bookId: string;
  bookTitle: string;
}

export function CoReadingDiaryAction({
  bookId,
  bookTitle,
}: CoReadingDiaryActionProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <section className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold text-sm">
            <NotebookPen className="size-4 text-primary" />
            Agent
          </p>
          <p className="mt-1 text-muted-foreground text-xs">
            选择尚未写入的共读记录，交给 VCP 后端整理并写入日记。
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => setOpen(true)}>
          Agent
        </Button>
      </section>
      <CoReadingDiaryDialog
        open={open}
        onOpenChange={setOpen}
        bookId={bookId}
        bookTitle={bookTitle}
      />
    </>
  );
}

import { EMPTY_BOOK_NOTES, selectBookNotes } from "@/components/side-chat/co-reading-panel-state";
import ModelSelector from "@/components/side-chat/model-selector";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { isBookCoReadingModelOverride, resolveCoReadingModel } from "@/lib/co-reading-model";
import { useReaderStore } from "@/pages/reader/components/reader-provider";
import { getCoReadingSnapshot, retryCoReadingBlocks, updateCoReadingSettings } from "@/services/co-reading-service";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { type SelectedModel, useProviderStore } from "@/store/provider-store";
import type { CoReadingStatus } from "@/types/co-reading";
import { Bot, CirclePause, CirclePlay, Clock3, LoaderCircle, RotateCcw, Settings, Square } from "lucide-react";
import { useMemo, useState } from "react";

interface CoReadingPanelProps {
  bookId: string;
}

const STATUS_LABELS: Record<CoReadingStatus, string> = {
  off: "尚未开启",
  active: "正在陪读",
  paused: "已暂停",
};

export function CoReadingPanel({ bookId }: CoReadingPanelProps) {
  const snapshot = useReaderStore((state) => state.coReadingSnapshot);
  const runtime = useReaderStore((state) => state.coReadingRuntime);
  const setSnapshot = useReaderStore((state) => state.setCoReadingSnapshot);
  const setRuntime = useReaderStore((state) => state.setCoReadingRuntime);
  const view = useReaderStore((state) => state.view);
  const notes = useReaderStore(selectBookNotes) ?? EMPTY_BOOK_NOTES;
  const selectedModel = useProviderStore((state) => state.selectedModel);
  const modelProviders = useProviderStore((state) => state.modelProviders);
  const { toggleSettingsDialog } = useAppSettingsStore();
  const [isUpdating, setIsUpdating] = useState(false);
  const [retryingKey, setRetryingKey] = useState<string | null>(null);
  const coReadingModel = resolveCoReadingModel(snapshot?.settings, selectedModel, modelProviders);
  const hasBookModelOverride = isBookCoReadingModelOverride(snapshot?.settings);

  const aiNotes = useMemo(
    () =>
      notes
        .filter((note) => note.author === "ai")
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 8),
    [notes],
  );
  const failedBlocks = snapshot?.blocks.filter((block) => block.status === "failed").slice(0, 5) ?? [];
  const syncedCount = (snapshot?.stats.silent ?? 0) + (snapshot?.stats.annotated ?? 0);
  const queueCount = (snapshot?.stats.queued ?? 0) + (snapshot?.stats.processing ?? 0);
  const dwellMs = (snapshot?.settings.dwellSeconds ?? 15) * 1_000;
  const remainingSeconds = runtime?.leadingBlockKey
    ? Math.max(0, Math.ceil((dwellMs - runtime.leadingBlockDwellMs) / 1_000))
    : null;

  const refresh = async () => {
    const next = await getCoReadingSnapshot(bookId);
    setSnapshot?.(next);
  };

  const changeSettings = async (
    status: CoReadingStatus,
    dwellSeconds = snapshot?.settings.dwellSeconds ?? 15,
    modelPreference?: { modelProviderId?: string; modelId?: string },
  ) => {
    setIsUpdating(true);
    try {
      await updateCoReadingSettings({
        bookId,
        status,
        dwellSeconds,
        modelProviderId: modelPreference?.modelProviderId,
        modelId: modelPreference?.modelId,
      });
      await refresh();
    } catch (error) {
      setRuntime?.({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const changeModel = async (model: SelectedModel) => {
    await changeSettings(snapshot?.settings.status ?? "off", snapshot?.settings.dwellSeconds ?? 15, {
      modelProviderId: model.providerId,
      modelId: model.modelId,
    });
  };

  const clearBookModel = async () => {
    await changeSettings(snapshot?.settings.status ?? "off", snapshot?.settings.dwellSeconds ?? 15, {
      modelProviderId: "",
      modelId: "",
    });
  };

  const changeDwell = async (value: number) => {
    const dwellSeconds = Math.min(60, Math.max(5, Math.round(value)));
    await changeSettings(snapshot?.settings.status ?? "off", dwellSeconds);
  };

  const retryBlock = async (blockKey: string) => {
    setRetryingKey(blockKey);
    try {
      await retryCoReadingBlocks(bookId, [blockKey]);
      await refresh();
    } catch (error) {
      setRuntime?.({
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRetryingKey(null);
    }
  };

  if (!snapshot || !runtime) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        <LoaderCircle className="mr-2 size-4 animate-spin" />
        正在恢复共读进度
      </div>
    );
  }

  const status = snapshot.settings.status;
  const isActive = status === "active";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`size-2 rounded-full ${
                  isActive ? "bg-emerald-500" : status === "paused" ? "bg-amber-500" : "bg-neutral-400"
                }`}
              />
              <span className="font-medium text-sm">{STATUS_LABELS[status]}</span>
            </div>
            <p className="mt-1 truncate text-muted-foreground text-xs">
              {coReadingModel?.modelName ?? "尚未选择模型"}
              {hasBookModelOverride ? " · 本书" : coReadingModel ? " · 全局" : ""}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {status === "off" ? (
              <Button size="sm" className="h-8" disabled={isUpdating} onClick={() => void changeSettings("active")}>
                {isUpdating ? <LoaderCircle className="animate-spin" /> : <CirclePlay />}
                开始
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={isUpdating}
                  onClick={() => void changeSettings(isActive ? "paused" : "active")}
                >
                  {isActive ? <CirclePause /> : <CirclePlay />}
                  {isActive ? "暂停" : "继续"}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8"
                  disabled={isUpdating}
                  title="关闭共读"
                  onClick={() => void changeSettings("off")}
                >
                  <Square />
                </Button>
              </>
            )}
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <ModelSelector
              selectedModel={coReadingModel}
              onModelSelect={(model) => void changeModel(model)}
              className="min-w-0 flex-1"
            />
            {hasBookModelOverride && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 shrink-0 px-2 text-xs"
                disabled={isUpdating}
                title="清除本书模型，改用全局"
                onClick={() => void clearBookModel()}
              >
                跟随全局
              </Button>
            )}
          </div>
          {!coReadingModel && status !== "off" && (
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border border-amber-300/70 bg-amber-50 px-2.5 py-2 text-left text-amber-900 text-xs dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-200"
              onClick={toggleSettingsDialog}
            >
              <span>尚未可用模型时，可在设置中配置 Provider 与 API Key</span>
              <Settings className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 border-b px-3 py-3">
        <div>
          <p className="text-[11px] text-muted-foreground">当前可视</p>
          <p className="mt-0.5 font-medium text-sm">{runtime.visibleBlockCount} 块</p>
        </div>
        <div className="border-l pl-3">
          <p className="text-[11px] text-muted-foreground">已同步</p>
          <p className="mt-0.5 font-medium text-sm">{syncedCount} 块</p>
        </div>
        <div className="border-l pl-3">
          <p className="text-[11px] text-muted-foreground">待处理</p>
          <p className="mt-0.5 font-medium text-sm">{queueCount} 块</p>
        </div>
      </div>

      <div className="border-b px-3 py-3">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Clock3 className="size-3.5" />
            停留阈值
          </span>
          <label className="flex items-center gap-1">
            <input
              type="number"
              min={5}
              max={60}
              className="h-7 w-12 rounded border bg-transparent px-1.5 text-right text-xs outline-none focus:ring-1 focus:ring-ring"
              value={snapshot.settings.dwellSeconds}
              disabled={isUpdating}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (next >= 5 && next <= 60) void changeDwell(next);
              }}
            />
            <span className="text-muted-foreground">秒</span>
          </label>
        </div>
        <Slider
          min={5}
          max={60}
          step={1}
          value={[snapshot.settings.dwellSeconds]}
          disabled={isUpdating}
          onValueCommit={(value) => void changeDwell(value[0] ?? 15)}
        />
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{remainingSeconds == null ? "等待可视正文" : `${remainingSeconds} 秒后同步`}</span>
          {runtime.isProcessing && (
            <span className="flex items-center gap-1 text-primary">
              <LoaderCircle className="size-3 animate-spin" />
              AI 正在阅读
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {runtime.error && (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-red-800 text-xs dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
            {runtime.error}
          </div>
        )}

        {failedBlocks.length > 0 && (
          <section className="mb-4">
            <h3 className="mb-2 font-medium text-xs">需要重试</h3>
            <div className="space-y-2">
              {failedBlocks.map((block) => (
                <div key={block.blockKey} className="flex items-start gap-2 rounded-md border px-2.5 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs">{block.sectionLabel || "未命名章节"}</p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{block.error || "处理失败"}</p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    title="重试此文本块"
                    disabled={retryingKey === block.blockKey}
                    onClick={() => void retryBlock(block.blockKey)}
                  >
                    <RotateCcw className={retryingKey === block.blockKey ? "animate-spin" : ""} />
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-medium text-xs">最近批注</h3>
            <span className="text-[11px] text-muted-foreground">{aiNotes.length} 条</span>
          </div>
          {aiNotes.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-xs">
              <Bot className="mx-auto mb-2 size-5 opacity-60" />
              AI 还没有留下批注
            </div>
          ) : (
            <div className="space-y-2">
              {aiNotes.map((note) => (
                <button
                  type="button"
                  key={note.id}
                  className="w-full rounded-md border-border border-l-2 bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted"
                  onClick={() => view?.goTo(note.cfi)}
                >
                  <p className="line-clamp-2 text-muted-foreground text-xs">“{note.text}”</p>
                  <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed">{note.note}</p>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

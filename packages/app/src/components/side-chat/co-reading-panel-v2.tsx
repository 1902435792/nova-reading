import ModelSelector from "@/components/side-chat/model-selector";
import { Button } from "@/components/ui/button";
import {
  getCoReadingErrorInfo,
  groupCoReadingFailures,
} from "@/lib/co-reading-core";
import {
  isBookCoReadingModelOverride,
  resolveCoReadingModel,
} from "@/lib/co-reading-model";
import { useReaderStore } from "@/pages/reader/components/reader-provider";
import {
  getCoReadingRangeSnapshot,
  getCoReadingSnapshot,
  retryCoReadingBlocks,
  updateCoReadingSettings,
} from "@/services/co-reading-service";
import { type SelectedModel, useProviderStore } from "@/store/provider-store";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  ListChecks,
  MapIcon,
  Pause,
  Play,
  Settings2,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CoReadingAccordion as Accordion,
  CoReadingAccordionContent as AccordionContent,
  CoReadingAccordionItem as AccordionItem,
  CoReadingAccordionTrigger as AccordionTrigger,
} from "./co-reading-accordion";
import type { ReadingFootprintTarget } from "./co-reading-backlink";
import { CoReadingDiaryAction } from "./co-reading-diary-action";
import { CoReadingRangeMap } from "./co-reading-range-map";

interface CoReadingPanelV2Props {
  bookId: string;
  readingFootprintTarget?: ReadingFootprintTarget | null;
}

export function CoReadingPanelV2({
  bookId,
  readingFootprintTarget,
}: CoReadingPanelV2Props) {
  const snapshot = useReaderStore((state) => state.coReadingSnapshot);
  const runtime = useReaderStore((state) => state.coReadingRuntime);
  const bookTitle =
    useReaderStore((state) => state.bookData?.book?.title) ?? "未命名书籍";
  const setSnapshot = useReaderStore((state) => state.setCoReadingSnapshot)!;
  const selectedModel = useProviderStore((state) => state.selectedModel);
  const providers = useProviderStore((state) => state.modelProviders);
  const storageKey = `deepreader:co-reading-expanded:${bookId}`;
  const [expanded, setExpanded] = useState(
    () => window.localStorage.getItem(storageKey) === "true"
  );
  const [section, setSection] = useState<React.Key | null>("activity");
  const [dwellSeconds, setDwellSeconds] = useState(20);
  const [retryingFailed, setRetryingFailed] = useState(false);
  const [processingElapsedSeconds, setProcessingElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!runtime.isProcessing || !runtime.processingStartedAt) {
      setProcessingElapsedSeconds(0);
      return;
    }
    const updateElapsed = () =>
      setProcessingElapsedSeconds(
        Math.max(
          0,
          Math.floor((Date.now() - runtime.processingStartedAt!) / 1_000)
        )
      );
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [runtime.isProcessing, runtime.processingStartedAt]);

  useEffect(
    () => window.localStorage.setItem(storageKey, String(expanded)),
    [expanded, storageKey]
  );
  useEffect(() => {
    if (snapshot) setDwellSeconds(snapshot.settings.dwellSeconds);
  }, [snapshot]);
  useEffect(() => {
    if (!readingFootprintTarget || readingFootprintTarget.bookId !== bookId)
      return;
    setExpanded(true);
    setSection("map");
  }, [bookId, readingFootprintTarget]);
  if (!snapshot)
    return (
      <div className="p-4 text-muted-foreground text-xs">正在载入 AI 共读…</div>
    );

  const panel = {
    label:
      snapshot.settings.status === "off"
        ? "已关闭"
        : snapshot.settings.status === "paused"
        ? "已暂停"
        : runtime.isProcessing
        ? "Agent 正在阅读当前页"
        : runtime.runBlocked || runtime.visibleFailedBlockCount > 0
        ? "当前页面失败，等待重试"
        : runtime.visibleQueuedBlockCount > 0
        ? `当前页已就绪，等待 Agent（${runtime.visibleQueuedBlockCount} 段正文）`
        : runtime.visibleBlockCount > 0
        ? `Agent 正在跟随当前页（${runtime.visibleBlockCount} 段正文）`
        : "等待捕获当前可见页",
    progress: `${snapshot.stats.annotated} 条边注`,
    lastMessage:
      runtime.error ||
      (runtime.isProcessing
        ? `正在完整阅读当前页的 ${runtime.processingBlockCount} 段正文（已等待 ${processingElapsedSeconds} 秒）`
        : "跟随当前可见页；整页读完后自主留下 0–3 条书评"),
  };
  const model = resolveCoReadingModel(
    snapshot.settings,
    selectedModel,
    providers
  );
  const hasBookModelOverride = isBookCoReadingModelOverride(snapshot.settings);
  const failed = snapshot.blocks.filter((block) => block.status === "failed");
  const failedGroups = groupCoReadingFailures(failed);
  const failedFocusCount = new Set(
    failed.map((block) => block.focusKey?.trim() || block.blockKey)
  ).size;
  const modelLabel = model
    ? `${model.providerName} / ${model.modelName}`
    : "尚未选择可用模型";
  const hasUnresolvedRangeTask = async () => {
    const rangeSnapshot = await getCoReadingRangeSnapshot(bookId);
    return rangeSnapshot.tasks.some((task) =>
      ["running", "paused", "failed"].includes(task.status)
    );
  };

  const retryAllFailed = async () => {
    if (retryingFailed || failed.length === 0) return;
    if (!model) {
      toast.error("请先选择可用模型，再重试共读失败项。");
      return;
    }
    setRetryingFailed(true);
    try {
      if (await hasUnresolvedRangeTask()) {
        toast.info("请先续跑或停止当前范围阅读任务，再恢复普通跟读。");
        return;
      }
      const retried = await retryCoReadingBlocks(
        bookId,
        failed.map((block) => block.blockKey)
      );
      if (retried === 0) {
        setSnapshot(await getCoReadingSnapshot(bookId));
        toast.info("没有仍处于失败状态的文本块需要重试。");
        return;
      }
      if (snapshot.settings.status !== "active") {
        await updateCoReadingSettings({
          bookId,
          status: "active",
          dwellSeconds: snapshot.settings.dwellSeconds,
        });
      }
      window.dispatchEvent(
        new CustomEvent("deepreader:co-reading-retry", { detail: { bookId } })
      );
      const latest = await getCoReadingSnapshot(bookId);
      setSnapshot(latest);
      toast.success(`已重新排队 ${retried} 个文本块，并恢复普通跟读。`);
    } catch (error) {
      toast.error(getCoReadingErrorInfo(error).message);
      try {
        setSnapshot(await getCoReadingSnapshot(bookId));
      } catch {
        // Keep the existing snapshot when the database itself is unavailable.
      }
    } finally {
      setRetryingFailed(false);
    }
  };
  const changeSettings = async (
    updates: Partial<{
      status: "off" | "active" | "paused";
      dwellSeconds: number;
      modelProviderId: string;
      modelId: string;
    }>
  ) => {
    try {
      if (
        updates.status != null &&
        updates.status !== "paused" &&
        (await hasUnresolvedRangeTask())
      ) {
        toast.info("范围阅读进行、暂停或等待续跑期间，普通跟读必须保持暂停。");
        return;
      }
      const settings = await updateCoReadingSettings({
        bookId,
        status: updates.status ?? snapshot.settings.status,
        dwellSeconds: updates.dwellSeconds ?? snapshot.settings.dwellSeconds,
        modelProviderId: updates.modelProviderId,
        modelId: updates.modelId,
      });
      setSnapshot({ ...snapshot, settings });
    } catch (error) {
      toast.error(getCoReadingErrorInfo(error).message);
    }
  };
  const saveStatus = (status: "off" | "active" | "paused") =>
    changeSettings({ status });
  const saveDwell = () => changeSettings({ dwellSeconds });
  const changeModel = (next: SelectedModel) =>
    changeSettings({ modelProviderId: next.providerId, modelId: next.modelId });
  const clearBookModel = () =>
    changeSettings({ modelProviderId: "", modelId: "" });

  const header = (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-xl border bg-gradient-to-r from-primary/5 to-background p-3 text-left shadow-sm transition hover:border-primary/40"
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      <span className="rounded-lg bg-primary/10 p-2 text-primary">
        <Sparkles className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <strong className="text-sm">Agent 共读</strong>
          <i
            className={`size-2 rounded-full ${
              snapshot.settings.status === "active"
                ? "bg-emerald-500"
                : snapshot.settings.status === "paused"
                ? "bg-amber-500"
                : "bg-neutral-400"
            }`}
          />
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {panel.label} · {panel.progress}
        </span>
      </span>
      {expanded ? (
        <ChevronDown className="size-4 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-4 text-muted-foreground" />
      )}
    </button>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {header}
      {expanded && (
        <div className="mt-2 space-y-2">
          <section
            className={`rounded-xl border p-3 ${
              snapshot.settings.status === "active"
                ? "border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/20"
                : snapshot.settings.status === "paused"
                ? "border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/20"
                : "bg-card"
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-sm">普通跟读</p>
                <p
                  className={`text-xs ${
                    snapshot.settings.status === "active"
                      ? "text-emerald-700 dark:text-emerald-300"
                      : snapshot.settings.status === "paused"
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-muted-foreground"
                  }`}
                >
                  {snapshot.settings.status === "active"
                    ? "● 正在跟随你当前阅读的位置"
                    : snapshot.settings.status === "paused"
                    ? "Ⅱ 已暂停，不会继续读取当前页面"
                    : "○ 已关闭"}
                </p>
              </div>
              {snapshot.settings.status === "active" ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-amber-400 bg-background"
                  onClick={() => void saveStatus("paused")}
                >
                  <Pause className="mr-1 size-3" />
                  暂停
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={!model}
                  onClick={() => void saveStatus("active")}
                >
                  <Play className="mr-1 size-3" />
                  {snapshot.settings.status === "paused"
                    ? "恢复跟读"
                    : "开始跟读"}
                </Button>
              )}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <ModelSelector
                selectedModel={model}
                onModelSelect={(next) => void changeModel(next)}
                className="min-w-0 flex-1"
              />
              {hasBookModelOverride && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 shrink-0 px-2 text-xs"
                  onClick={() => void clearBookModel()}
                >
                  跟随全局
                </Button>
              )}
            </div>
            <div className="mt-3 flex items-center gap-3 rounded-lg bg-background/70 px-2.5 py-2">
              <Clock3 className="size-4 text-primary" />
              <label className="flex flex-1 items-center gap-2 text-xs">
                <span className="shrink-0">
                  停留 {dwellSeconds} 秒后交给 Agent
                </span>
                <input
                  type="range"
                  min={5}
                  max={60}
                  step={5}
                  value={dwellSeconds}
                  onChange={(event) =>
                    setDwellSeconds(Number(event.target.value))
                  }
                  onPointerUp={() => void saveDwell()}
                  className="min-w-0 flex-1"
                />
              </label>
            </div>
            {snapshot.settings.status !== "off" && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-7 px-1 text-muted-foreground text-xs"
                onClick={() => void saveStatus("off")}
              >
                关闭普通跟读
              </Button>
            )}
          </section>
          {!model && (
            <p className="rounded bg-amber-50 p-2 text-amber-800 text-xs dark:bg-amber-950/30">
              请先选择模型。范围阅读和普通跟读共用这个模型。
            </p>
          )}
          <CoReadingDiaryAction
            bookId={bookId}
            bookTitle={bookTitle}
            settings={snapshot.settings}
          />
          <Accordion
            expandedValue={section}
            onValueChange={setSection}
            className="divide-y rounded-xl border bg-card"
          >
            <AccordionItem value="activity">
              <AccordionTrigger className="flex w-full items-center gap-2 px-3 py-2 text-sm">
                <Clock3 className="size-4 text-primary" />
                当前活动
                <span className="ml-auto text-muted-foreground text-xs">
                  {panel.lastMessage}
                </span>
              </AccordionTrigger>
              <AccordionContent className="px-3 pb-3 text-xs">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded bg-muted p-2">
                    <b className="block text-base">{snapshot.stats.queued}</b>
                    历史待处理
                  </div>
                  <div className="rounded bg-muted p-2">
                    <b className="block text-base">
                      {snapshot.stats.annotated}
                    </b>
                    边注
                  </div>
                  <div className="rounded bg-muted p-2">
                    <b className="block text-base">{snapshot.stats.silent}</b>
                    静默
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="range">
              <AccordionTrigger className="flex w-full items-center gap-2 px-3 py-2 text-sm">
                <Sparkles className="size-4 text-primary" />
                范围阅读
              </AccordionTrigger>
              <AccordionContent className="px-3 pb-3">
                <CoReadingRangeMap bookId={bookId} mode="range" />
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="map">
              <AccordionTrigger className="flex w-full items-center gap-2 px-3 py-2 text-sm">
                <MapIcon className="size-4 text-primary" />
                阅读地图
              </AccordionTrigger>
              <AccordionContent className="px-3 pb-3">
                <CoReadingRangeMap
                  bookId={bookId}
                  mode="map"
                  readingFootprintTarget={readingFootprintTarget}
                />
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="failures">
              <AccordionTrigger className="flex w-full items-center gap-2 px-3 py-2 text-sm">
                <ListChecks className="size-4" />
                统计与失败
                <span className="ml-auto text-xs">
                  {failedFocusCount} 页 / {failed.length} 段
                </span>
              </AccordionTrigger>
              <AccordionContent className="space-y-2 px-3 pb-3">
                {failed.length === 0 ? (
                  <p className="text-muted-foreground text-xs">没有失败项。</p>
                ) : (
                  <>
                    <p className="rounded bg-muted px-2 py-1.5 text-muted-foreground text-xs">
                      历史失败共 {failedFocusCount} 个页面焦点、{failed.length}{" "}
                      段正文；每个页面焦点对应一次模型请求。当前模型：
                      {modelLabel}
                    </p>
                    <div className="space-y-1.5">
                      {failedGroups.map((group) => (
                        <div
                          key={`${group.kind}:${group.message}`}
                          className={`rounded border px-2 py-1.5 text-xs ${
                            group.fatal
                              ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200"
                              : "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
                          }`}
                        >
                          <CircleAlert className="mr-1 inline size-3" />
                          {group.focusCount} 个页面焦点（{group.blockCount}{" "}
                          段正文） · {group.message}
                        </div>
                      ))}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      disabled={retryingFailed || !model}
                      onClick={() => void retryAllFailed()}
                    >
                      {retryingFailed ? "正在恢复…" : "重试全部并恢复跟读"}
                    </Button>
                  </>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}
    </div>
  );
}

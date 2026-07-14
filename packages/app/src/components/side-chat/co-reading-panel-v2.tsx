import ModelSelector from "@/components/side-chat/model-selector";
import { Button } from "@/components/ui/button";
import {
  isBookCoReadingModelOverride,
  resolveCoReadingModel,
} from "@/lib/co-reading-model";
import { useReaderStore } from "@/pages/reader/components/reader-provider";
import {
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
        ? "Nova 正在阅读"
        : snapshot.stats.queued > 0
        ? `${snapshot.stats.queued} 个文本块待处理`
        : runtime.visibleBlockCount > 0
        ? `正在跟读 ${runtime.visibleBlockCount} 个文本块`
        : "等待阅读内容",
    progress: `${snapshot.stats.annotated} 条边注`,
    lastMessage:
      runtime.error ||
      (runtime.isProcessing ? "正在生成共读决策" : "跟随当前阅读进度"),
  };
  const model = resolveCoReadingModel(
    snapshot.settings,
    selectedModel,
    providers
  );
  const hasBookModelOverride = isBookCoReadingModelOverride(snapshot.settings);
  const failed = snapshot.blocks.filter((block) => block.status === "failed");
  const changeSettings = async (
    updates: Partial<{
      status: "off" | "active" | "paused";
      dwellSeconds: number;
      modelProviderId: string;
      modelId: string;
    }>
  ) => {
    const settings = await updateCoReadingSettings({
      bookId,
      status: updates.status ?? snapshot.settings.status,
      dwellSeconds: updates.dwellSeconds ?? snapshot.settings.dwellSeconds,
      modelProviderId: updates.modelProviderId,
      modelId: updates.modelId,
    });
    setSnapshot({ ...snapshot, settings });
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
          <strong className="text-sm">Nova 共读</strong>
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
                  停留 {dwellSeconds} 秒后交给 Nova
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
                    待处理
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
                <span className="ml-auto text-xs">{failed.length}</span>
              </AccordionTrigger>
              <AccordionContent className="space-y-2 px-3 pb-3">
                {failed.length === 0 ? (
                  <p className="text-muted-foreground text-xs">没有失败项。</p>
                ) : (
                  <>
                    <p className="text-red-600 text-xs">
                      <CircleAlert className="mr-1 inline size-3" />
                      {failed[0]?.error}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7"
                      onClick={async () => {
                        await retryCoReadingBlocks(
                          bookId,
                          failed.map((b) => b.blockKey)
                        );
                      }}
                    >
                      重试全部
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

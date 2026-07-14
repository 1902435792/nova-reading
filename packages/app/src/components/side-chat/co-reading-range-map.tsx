import { Button } from "@/components/ui/button";
import {
  getCoReadingCodePointOffset,
  getDocumentCoReadingTextLength,
} from "@/lib/co-reading-dom";
import {
  CO_READING_PERCENTAGE_PRESETS,
  type CoReadingCurrentPosition,
  type CoReadingSectionTextIndex,
  FOOTPRINT_COLORS,
  adjustEndPercentForCurrentPosition,
  buildCoReadingBookTextIndex,
  buildCoReadingRangeOptions,
  getCoReadingDefaultPercentageRange,
  getRangeTaskStatusLabel,
  groupFootprintsBySection,
  mapPercentageToBookRange,
  mapSectionOffsetToCurrentPosition,
} from "@/lib/co-reading-range";
import { useReaderStore } from "@/pages/reader/components/reader-provider";
import {
  createCoReadingRangeTask,
  getCoReadingRangeSnapshot,
  updateCoReadingRangeTask,
} from "@/services/co-reading-service";
import type { BookNote } from "@/types/book";
import type {
  CoReadingFootprint,
  CoReadingRangeSnapshot,
} from "@/types/co-reading";
import {
  ChevronRight,
  ExternalLink,
  MapIcon,
  Pause,
  Play,
  Sparkles,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type ReadingFootprintTarget,
  findFootprintByAnnotationId,
  getAnnotationSourceTarget,
  getFootprintSourceTarget,
  listenForReadingFootprint,
} from "./co-reading-backlink";
interface CoReadingRangeMapProps {
  bookId: string;
  mode?: "range" | "map" | "all";
  readingFootprintTarget?: ReadingFootprintTarget | null;
}

const EMPTY_SNAPSHOT: CoReadingRangeSnapshot = { tasks: [], footprints: [] };

export function CoReadingRangeMap({
  bookId,
  mode = "all",
  readingFootprintTarget,
}: CoReadingRangeMapProps) {
  const bookData = useReaderStore((state) => state.bookData);
  const coReadingSnapshot = useReaderStore((state) => state.coReadingSnapshot);
  const setPendingReadingFootprint = useReaderStore(
    (state) => state.setPendingReadingFootprint
  )!;
  const setPendingCoReadingSource = useReaderStore(
    (state) => state.setPendingCoReadingSource
  )!;
  const progress = useReaderStore((state) => state.progress);
  const view = useReaderStore((state) => state.view);
  const format = bookData?.book?.format;
  const sections = useMemo(
    () => bookData?.bookDoc?.sections ?? [],
    [bookData?.bookDoc]
  );
  const rangeOptions = useMemo(
    () => buildCoReadingRangeOptions(bookData?.bookDoc, format),
    [bookData?.bookDoc, format]
  );
  const supported =
    (format === "EPUB" || format === "PDF") && rangeOptions.length > 0;
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [bookTextIndex, setBookTextIndex] = useState<
    CoReadingSectionTextIndex[]
  >([]);
  const [indexing, setIndexing] = useState(false);
  const [startPercent, setStartPercent] = useState(0);
  const [endPercent, setEndPercent] = useState(10);
  const [currentPosition, setCurrentPosition] =
    useState<CoReadingCurrentPosition | null>(null);
  const [manualRangeBeforeCurrent, setManualRangeBeforeCurrent] = useState<{
    startPercent: number;
    endPercent: number;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const buildIndex = async () => {
      setIndexing(true);
      try {
        const lengths = await Promise.all(
          sections.map(async (section) => {
            const doc = await section.createDocument?.();
            return doc ? getDocumentCoReadingTextLength(doc) : 0;
          })
        );
        if (!active) return;
        const next = buildCoReadingBookTextIndex(lengths, rangeOptions, format);
        setBookTextIndex(next);
        const defaults = getCoReadingDefaultPercentageRange(
          next,
          progress?.sectionIndex ?? 0
        );
        setStartPercent(defaults.startPercent);
        setEndPercent(defaults.endPercent);
      } finally {
        if (active) setIndexing(false);
      }
    };
    void buildIndex();
    return () => {
      active = false;
    };
  }, [format, progress?.sectionIndex, rangeOptions, sections]);
  const [positionSource, setPositionSource] = useState<string | null>(null);
  const [selected, setSelected] = useState<CoReadingFootprint | null>(null);
  const [selectedAnnotation, setSelectedAnnotation] = useState<BookNote | null>(
    null
  );
  const [taskFilter, setTaskFilter] = useState("all");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const next = await getCoReadingRangeSnapshot(bookId);
    setSnapshot(next);
    return next;
  }, [bookId]);

  useEffect(() => {
    void refresh();
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          bookId: string;
          snapshot?: CoReadingRangeSnapshot;
        }>
      ).detail;
      if (detail?.bookId !== bookId) return;
      if (detail.snapshot) setSnapshot(detail.snapshot);
      else void refresh();
    };
    window.addEventListener("deepreader:reading-map-updated", handler);
    return () =>
      window.removeEventListener("deepreader:reading-map-updated", handler);
  }, [bookId, refresh]);

  const applyReadingFootprintTarget = useCallback(
    (target: ReadingFootprintTarget) => {
      if (target.bookId !== bookId) return;
      setTaskFilter("all");
      setSelectedAnnotation(target.annotation);
      void refresh().then((next) => {
        setSelected(
          findFootprintByAnnotationId(next.footprints, target.annotationId)
        );
        setPendingReadingFootprint(null);
      });
    },
    [bookId, refresh, setPendingReadingFootprint]
  );

  useEffect(() => {
    if (!readingFootprintTarget || readingFootprintTarget.bookId !== bookId)
      return;
    applyReadingFootprintTarget(readingFootprintTarget);
  }, [applyReadingFootprintTarget, bookId, readingFootprintTarget]);

  // 仅地图实例监听事件，避免 range 模式重复消费
  useEffect(() => {
    if (mode === "range") return;
    return listenForReadingFootprint(
      window,
      bookId,
      applyReadingFootprintTarget
    );
  }, [applyReadingFootprintTarget, bookId, mode]);

  const activeTask = snapshot.tasks.find(
    (task) => task.status === "running" || task.status === "paused"
  );
  const visibleFootprints = useMemo(
    () =>
      snapshot.footprints.filter(
        (item) => taskFilter === "all" || item.taskId === taskFilter
      ),
    [snapshot.footprints, taskFilter]
  );
  const mapRows = useMemo(
    () => groupFootprintsBySection(visibleFootprints, bookTextIndex),
    [bookTextIndex, visibleFootprints]
  );

  const selectedRange = useMemo(
    () => mapPercentageToBookRange(bookTextIndex, startPercent, endPercent),
    [bookTextIndex, endPercent, startPercent]
  );

  const clearCurrentPosition = (restoreManualRange: boolean) => {
    if (restoreManualRange && manualRangeBeforeCurrent) {
      setStartPercent(manualRangeBeforeCurrent.startPercent);
      setEndPercent(manualRangeBeforeCurrent.endPercent);
    }
    setCurrentPosition(null);
    setPositionSource(null);
    setManualRangeBeforeCurrent(null);
  };

  const setPercentageRange = (start: number, end: number) => {
    clearCurrentPosition(false);
    setStartPercent(Math.max(0, Math.min(100, start)));
    setEndPercent(Math.max(0, Math.min(100, end)));
  };

  const startFromCurrentPosition = () => {
    if (currentPosition) {
      clearCurrentPosition(true);
      toast.success("已取消从当前阅读位置开始");
      return;
    }
    if (format !== "EPUB") {
      toast.error("当前阅读位置精确起点暂仅支持 EPUB");
      return;
    }
    const range = progress?.range;
    const contents = view?.renderer.getContents() ?? [];
    const rangeDoc = range?.startContainer.ownerDocument;
    const content = rangeDoc
      ? contents.find((item) => item.doc === rangeDoc)
      : undefined;
    const sectionIndex = content?.index;
    if (sectionIndex == null || !rangeDoc || !range) {
      toast.error("无法取得当前 EPUB 可见正文位置，请翻页后重试");
      return;
    }

    const selection = rangeDoc.getSelection();
    const anchorRange =
      selection?.rangeCount &&
      !selection.isCollapsed &&
      selection.getRangeAt(0).startContainer.ownerDocument === rangeDoc
        ? selection.getRangeAt(0)
        : range;
    const charOffset = getCoReadingCodePointOffset(
      rangeDoc,
      anchorRange.startContainer,
      anchorRange.startOffset
    );
    if (charOffset == null) {
      toast.error("无法精确映射当前 EPUB 正文位置");
      return;
    }

    const current = mapSectionOffsetToCurrentPosition(
      bookTextIndex,
      sectionIndex,
      charOffset
    );
    if (!current) {
      toast.error("当前位置没有可阅读正文");
      return;
    }
    const nextEnd = adjustEndPercentForCurrentPosition(
      current.startPercent,
      endPercent
    );
    if (nextEnd == null) {
      toast.error("已经到达全书末尾，无法创建空范围");
      return;
    }
    setManualRangeBeforeCurrent({ startPercent, endPercent });
    setCurrentPosition(current);
    setStartPercent(current.startPercent);
    setEndPercent(nextEnd);
    setPositionSource(
      anchorRange === range
        ? "已从当前可见正文的准确位置开始"
        : "已从当前选择区的准确位置开始"
    );
    toast.success("已使用当前 EPUB 正文的准确位置");
  };

  const createTask = async () => {
    if (!supported || sections.length === 0 || !format || !selectedRange)
      return;
    setBusy(true);
    try {
      const kind = format === "PDF" ? "page" : "section";
      const taskRange = currentPosition
        ? {
            ...selectedRange,
            startIndex: currentPosition.sectionIndex,
            startCharOffset: currentPosition.charOffset,
            startPercent: currentPosition.startPercent,
            startLabel: `${currentPosition.startPercent.toFixed(2)}% · ${
              currentPosition.label
            }`,
          }
        : selectedRange;
      if (
        taskRange.endIndex < taskRange.startIndex ||
        (taskRange.endIndex === taskRange.startIndex &&
          taskRange.endCharOffset <= taskRange.startCharOffset)
      ) {
        throw new Error("终点必须位于当前阅读位置之后");
      }
      await createCoReadingRangeTask({
        bookId,
        format,
        rangeKind: kind,
        startIndex: taskRange.startIndex,
        endIndex: taskRange.endIndex,
        startLabel: taskRange.startLabel,
        endLabel: taskRange.endLabel,
        startCharOffset: taskRange.startCharOffset,
        endCharOffset: taskRange.endCharOffset,
        startPercent: taskRange.startPercent,
        endPercent: taskRange.endPercent,
      });
      await refresh();
      window.dispatchEvent(
        new CustomEvent("deepreader:range-task-changed", {
          detail: { bookId },
        })
      );
      toast.success("Nova 已开始范围阅读");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const changeTask = async (status: "running" | "paused" | "stopped") => {
    if (!activeTask) return;
    setBusy(true);
    try {
      await updateCoReadingRangeTask(activeTask.id, status);
      await refresh();
      window.dispatchEvent(
        new CustomEvent("deepreader:range-task-changed", {
          detail: { bookId },
        })
      );
    } finally {
      setBusy(false);
    }
  };

  const estimatedSections = selectedRange
    ? selectedRange.endIndex - selectedRange.startIndex + 1
    : 0;
  return (
    <div className="space-y-3">
      {mode !== "map" && (
        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="mb-2 flex items-center gap-2 font-medium text-sm">
            <Sparkles className="size-4 text-primary" />
            Nova 范围阅读
          </div>
          {!supported ? (
            <p className="text-muted-foreground text-xs">
              首版仅支持 EPUB 章节范围与 PDF 页码范围。
            </p>
          ) : activeTask ? (
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span>
                  {activeTask.startLabel} → {activeTask.endLabel}
                </span>
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                  {getRangeTaskStatusLabel(activeTask.status)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary"
                  style={{
                    width: `${Math.min(
                      100,
                      (activeTask.processedCount /
                        Math.max(1, activeTask.candidateLimit)) *
                        100
                    )}%`,
                  }}
                />
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>
                  扫描 {activeTask.scannedCount} · 选读{" "}
                  {activeTask.selectedCount}
                </span>
                <span>
                  请求 {activeTask.requestCount}/{activeTask.requestLimit}
                </span>
              </div>
              <div className="flex gap-2">
                {activeTask.status === "running" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 flex-1"
                    disabled={busy}
                    onClick={() => changeTask("paused")}
                  >
                    <Pause className="mr-1 size-3" />
                    暂停
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 flex-1"
                    disabled={busy}
                    onClick={() => changeTask("running")}
                  >
                    <Play className="mr-1 size-3" />
                    继续
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 flex-1"
                  disabled={busy}
                  onClick={() => changeTask("stopped")}
                >
                  <Square className="mr-1 size-3" />
                  停止
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {CO_READING_PERCENTAGE_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() =>
                      setPercentageRange(preset.startPercent, preset.endPercent)
                    }
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <Button
                type="button"
                variant={currentPosition ? "default" : "secondary"}
                size="sm"
                className="h-8 w-full text-xs"
                disabled={
                  !currentPosition &&
                  (format !== "EPUB" ||
                    indexing ||
                    !view ||
                    bookTextIndex.length === 0)
                }
                onClick={startFromCurrentPosition}
                aria-pressed={Boolean(currentPosition)}
                title={
                  format === "PDF"
                    ? "PDF 当前页内精确位置尚无可用文本层"
                    : currentPosition
                    ? "再次点击可取消并恢复原范围"
                    : undefined
                }
              >
                {currentPosition
                  ? "已从当前位置开始 · 点击取消"
                  : "从当前阅读位置开始"}
              </Button>
              {positionSource && (
                <p
                  className="rounded bg-primary/10 px-2 py-1.5 text-primary text-xs"
                  role="status"
                >
                  {positionSource}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <label className="text-muted-foreground text-xs">
                  起点百分比
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={startPercent}
                    onChange={(event) => {
                      clearCurrentPosition(false);
                      setStartPercent(Number(event.target.value));
                    }}
                    className="mt-1 h-9 w-full rounded border bg-background px-2 text-xs"
                  />
                </label>
                <label className="text-muted-foreground text-xs">
                  终点百分比
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={endPercent}
                    onChange={(event) => {
                      clearCurrentPosition(false);
                      setEndPercent(Number(event.target.value));
                    }}
                    className="mt-1 h-9 w-full rounded border bg-background px-2 text-xs"
                  />
                </label>
              </div>
              <p className="rounded bg-amber-50 px-2 py-1.5 text-amber-800 text-xs dark:bg-amber-950/30 dark:text-amber-200">
                Nova 按全书实际正文字符计算范围；目录只显示起止位置附近标签。
              </p>
              <div className="text-muted-foreground text-xs">
                {indexing
                  ? "正在计算全书正文长度…"
                  : selectedRange
                  ? `${selectedRange.startLabel} → ${
                      selectedRange.endLabel
                    } · 交叉 ${estimatedSections} ${
                      format === "PDF" ? "页" : "节"
                    }`
                  : "请选择不相同的 0–100% 起止范围"}
              </div>
              <Button
                className="h-8 w-full"
                size="sm"
                disabled={busy || indexing || !selectedRange}
                onClick={createTask}
              >
                让 Nova 开始阅读
              </Button>
            </div>
          )}
        </div>
      )}

      {mode !== "range" && (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-medium text-sm">
              <MapIcon className="size-4 text-primary" />
              阅读地图
            </div>
            <select
              className="h-7 max-w-32 rounded border bg-background px-1 text-xs"
              value={taskFilter}
              onChange={(e) => setTaskFilter(e.target.value)}
            >
              <option value="all">全部任务</option>
              {snapshot.tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.startLabel}–{task.endLabel}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            {Object.entries({
              filtered: "过滤",
              candidate: "候选",
              selected: "选读",
              silent: "静默",
              annotated: "边注",
              failed: "失败",
            }).map(([status, label]) => (
              <span key={status} className="flex items-center gap-1">
                <i
                  className={`size-2 rounded-sm ${
                    FOOTPRINT_COLORS[status as keyof typeof FOOTPRINT_COLORS]
                  }`}
                />
                {label}
              </span>
            ))}
          </div>
          {indexing ? (
            <p className="py-4 text-center text-muted-foreground text-xs">
              正在构建全书章节轨道…
            </p>
          ) : mapRows.length === 0 ? (
            <p className="py-4 text-center text-muted-foreground text-xs">
              暂无可显示章节；Nova 开始范围阅读后会在这里留下足迹。
            </p>
          ) : (
            <div className="max-h-[32rem] space-y-1.5 overflow-y-auto pr-1">
              {mapRows.map((row) => {
                const current = progress?.sectionIndex === row.sectionIndex;
                return (
                  <div
                    key={row.sectionIndex}
                    className={`grid min-h-9 grid-cols-[6rem_1fr] items-center gap-2 rounded px-1.5 py-1 ${
                      current
                        ? "bg-primary/10 ring-1 ring-primary/40"
                        : "bg-muted/25"
                    }`}
                  >
                    <span
                      className="truncate text-[11px] text-muted-foreground"
                      title={row.sectionLabel}
                    >
                      {current ? "当前位置 · " : ""}
                      {row.sectionLabel}
                    </span>
                    <div className="grid min-h-4 grid-cols-12 gap-0.5">
                      {row.footprints.length === 0 ? (
                        <span
                          className="col-span-12 h-2 self-center rounded-full bg-muted"
                          title="本节暂无足迹"
                        />
                      ) : (
                        row.footprints
                          .slice(0, 120)
                          .map((item) => (
                            <button
                              key={item.id}
                              type="button"
                              title={`${item.status} · ${item.text.slice(
                                0,
                                40
                              )}`}
                              className={`h-3 min-w-1 rounded-sm ring-offset-1 hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                FOOTPRINT_COLORS[item.status]
                              }`}
                              onClick={() => setSelected(item)}
                            />
                          ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!selected && selectedAnnotation && (
            <button
              type="button"
              className="w-full rounded-md border bg-muted/30 p-2 text-left text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="定位 Nova 边注原文"
              onClick={() => {
                const block = coReadingSnapshot?.blocks.find(
                  (item) => item.annotationId === selectedAnnotation.id
                );
                setPendingCoReadingSource(
                  getAnnotationSourceTarget(bookId, selectedAnnotation, block)
                );
              }}
            >
              <span className="mb-1 flex items-center justify-between">
                <strong>Nova 边注</strong>
                <span className="text-muted-foreground">普通跟读 · 原文</span>
              </span>
              <span className="line-clamp-3 block text-muted-foreground">
                {selectedAnnotation.text}
              </span>
              {selectedAnnotation.note && (
                <span className="mt-2 block border-border border-l-2 pl-2 text-foreground">
                  {selectedAnnotation.note}
                </span>
              )}
            </button>
          )}
          {selected && (
            <div className="rounded-md bg-muted/50 p-2 text-xs">
              <div className="mb-1 flex items-center justify-between">
                <strong>{selected.sectionLabel}</strong>
                <span>{selected.status}</span>
              </div>
              <p className="line-clamp-3 text-muted-foreground">
                {selected.text}
              </p>
              {selected.comment && (
                <p className="mt-2 border-border border-l-2 pl-2 text-foreground">
                  {selected.comment}
                </p>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="mt-1 h-6 px-1"
                aria-label={`定位${selected.sectionLabel}的原文`}
                onClick={() =>
                  setPendingCoReadingSource(getFootprintSourceTarget(selected))
                }
              >
                <ExternalLink className="mr-1 size-3" />
                原文
                <ChevronRight className="size-3" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

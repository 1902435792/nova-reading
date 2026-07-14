import { openReadingFootprintForAnnotation } from "@/components/side-chat/co-reading-backlink";
import { useReaderStore } from "@/pages/reader/components/reader-provider";
import {
  HIGHLIGHT_COLOR_HEX,
  HIGHLIGHT_COLOR_RGBA,
} from "@/services/constants";
import { useLayoutStore } from "@/store/layout-store";

import type { BookNote } from "@/types/book";
import { Menu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import dayjs from "dayjs";
import { Bot, Lightbulb, X } from "lucide-react";
import { useCallback } from "react";

interface AnnotationItemProps {
  annotation: BookNote;
  selected?: boolean;
  onDelete?: (id: string) => void;
}

export const AnnotationItem = ({
  annotation,
  selected = false,
  onDelete,
}: AnnotationItemProps) => {
  const view = useReaderStore((state) => state.view);
  const bookId = useReaderStore((state) => state.bookId);
  const setPendingReadingFootprint = useReaderStore(
    (state) => state.setPendingReadingFootprint
  );

  const bgColor = annotation.color
    ? HIGHLIGHT_COLOR_RGBA[annotation.color]
    : HIGHLIGHT_COLOR_RGBA.yellow;
  const lineColor = annotation.color
    ? HIGHLIGHT_COLOR_HEX[annotation.color]
    : HIGHLIGHT_COLOR_HEX.yellow;
  const style = annotation.style || "highlight";
  const isAiAnnotation = annotation.author === "ai";

  const handleClick = useCallback(() => {
    // 原文定位始终保留
    if (view) {
      view.goTo(annotation.cfi);
    }
    // AI 批注额外驱动右侧阅读地图；人类批注不触发
    const opened = openReadingFootprintForAnnotation({
      bookId,
      annotation,
      setPendingReadingFootprint,
      eventTarget: typeof window !== "undefined" ? window : undefined,
    });
    if (opened) {
      useLayoutStore.setState({ isChatVisible: true });
    }
  }, [annotation, bookId, setPendingReadingFootprint, view]);
  const handleNativeDelete = useCallback(async () => {
    try {
      const confirmed = await ask(
        `确定要删除这条标注吗？\n\n"${
          annotation.text || ""
        }"\n\n此操作无法撤销。`,
        {
          title: "确认删除",
          kind: "warning",
        }
      );

      if (confirmed && onDelete) {
        await onDelete(annotation.id);
      }
    } catch (error) {
      console.error("删除标注失败:", error);
    }
  }, [annotation, onDelete]);

  const handleMenuClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        const menu = await Menu.new({
          items: [
            {
              id: "delete",
              text: "删除",
              action: () => {
                handleNativeDelete();
              },
            },
          ],
        });

        await menu.popup(new LogicalPosition(e.clientX, e.clientY));
      } catch (error) {
        console.error("显示菜单失败:", error);
      }
    },
    [handleNativeDelete]
  );

  return (
    <div
      data-annotation-id={annotation.id}
      aria-current={selected ? "true" : undefined}
      className={`group relative cursor-pointer rounded-lg p-2 transition-colors ${
        selected
          ? "bg-primary/10 ring-2 ring-primary ring-offset-1"
          : isAiAnnotation
          ? "border-border border-l-2 bg-muted/30"
          : "bg-muted dark:bg-neutral-900"
      }`}
      role="button"
      tabIndex={0}
      aria-label={`跳转到标注原文：${annotation.text ?? ""}`}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleClick();
        }
      }}
      onContextMenu={handleMenuClick}
    >
      {/* hover 删除按钮 */}
      <button
        type="button"
        className="absolute top-1.5 right-1.5 hidden rounded-full p-0.5 text-neutral-400 transition-colors hover:bg-neutral-300 hover:text-neutral-700 group-hover:block dark:hover:bg-neutral-600 dark:hover:text-neutral-200"
        onClick={(e) => {
          e.stopPropagation();
          handleNativeDelete();
        }}
        title="删除"
      >
        <X className="size-3.5" />
      </button>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {isAiAnnotation && (
            <div className="mb-1.5 flex items-center gap-1 text-primary text-xs">
              <Bot className="size-3.5" />
              AI 共读
            </div>
          )}
          {annotation.context && (
            <div className="mb-1 text-sm leading-relaxed">
              <span className="text-neutral-600 dark:text-neutral-200">
                ...{annotation.context.before}
              </span>
              <span
                className="font-medium text-sm"
                style={{
                  backgroundColor:
                    style === "highlight" ? bgColor : "transparent",
                  textDecoration:
                    style === "underline" || style === "squiggly"
                      ? "underline"
                      : "none",
                  textDecorationColor:
                    style !== "highlight" ? lineColor : undefined,
                  textDecorationThickness: "2px",
                  textDecorationStyle: style === "squiggly" ? "wavy" : "solid",
                }}
              >
                {annotation.text}
              </span>
              <span className="text-neutral-600 dark:text-neutral-200">
                {annotation.context.after}...
              </span>
            </div>
          )}

          {!annotation.context && (
            <div className="mb-2">
              <span
                className="font-medium text-sm"
                style={{
                  backgroundColor:
                    style === "highlight" ? bgColor : "transparent",
                  textDecoration:
                    style === "underline" || style === "squiggly"
                      ? "underline"
                      : "none",
                  textDecorationColor:
                    style !== "highlight" ? lineColor : undefined,
                  textDecorationThickness: "2px",
                  textDecorationStyle: style === "squiggly" ? "wavy" : "solid",
                }}
              >
                {annotation.text}
              </span>
            </div>
          )}

          {/* 用户的想法 */}
          {annotation.note && (
            <div
              className={`mt-1.5 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-xs ${
                isAiAnnotation
                  ? "bg-primary/10 text-foreground"
                  : "bg-amber-50 text-amber-900 italic dark:bg-amber-900/20 dark:text-amber-200"
              }`}
            >
              {isAiAnnotation ? (
                <Bot className="mt-0.5 size-3 shrink-0" />
              ) : (
                <Lightbulb className="mt-0.5 size-3 shrink-0" />
              )}
              <span>{annotation.note}</span>
            </div>
          )}

          <div className="mt-2 flex items-center gap-2 text-neutral-500 text-xs dark:text-neutral-500">
            <span>
              {dayjs(annotation.createdAt).format("YYYY-MM-DD HH:mm:ss")}
            </span>
            {isAiAnnotation && (
              <span className="ml-auto text-primary">
                点击定位原文与阅读地图
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

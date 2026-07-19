import { Button } from "@/components/ui/button";
import { useChatState } from "@/hooks/use-chat-state";
import { createVisibleReadingPosition } from "@/lib/reading-position";
import {
  useReaderStore,
  useReaderStoreApi,
} from "@/pages/reader/components/reader-provider";
import { useAppSettingsStore } from "@/store/app-settings-store";
import { useThemeStore } from "@/store/theme-store";
import type { ReadingFootprintTarget } from "@/types/co-reading";
import {
  BookOpenText,
  History,
  MessageCirclePlus,
  MessagesSquare,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ChatContainerRoot } from "../prompt-kit/chat-container";
import { ScrollButton } from "../prompt-kit/scroll-button";
import { MindmapDialog } from "../tools/mindmap-dialog";
import { ChatInputArea } from "./chat-input-area";
import { ChatMessages } from "./chat-messages";
import { ChatThreads } from "./chat-threads";
import { CoReadingPanelV2 } from "./co-reading-panel-v2";
import ModelSelector from "./model-selector";

interface ChatContentProps {
  bookId?: string;
}

function ChatContent({ bookId }: ChatContentProps) {
  const readerStore = useReaderStoreApi();
  const { toggleSettingsDialog } = useAppSettingsStore();
  const { autoScroll } = useThemeStore();
  const [toolDetail, setToolDetail] = useState<any>(null);
  const [showMindmapDialog, setShowMindmapDialog] = useState(false);
  const setActiveContext = useReaderStore((state) => state.setActiveContext)!;
  const progress = useReaderStore((state) => state.progress);
  const activeContext = useReaderStore((state) => state.activeContext)!;
  const currentThread = useReaderStore((state) => state.currentThread);
  const setCurrentThread = useReaderStore((state) => state.setCurrentThread)!;
  const view = useReaderStore((state) => state.view);

  // CTX-01: 提取当前可视页面文本，限制长度并标记截断状态，避免系统提示词过长
  const getCurrentPageText = useCallback((): string => {
    if (!view?.renderer) return "";
    try {
      const contents = view.renderer.getContents?.();
      if (!Array.isArray(contents) || contents.length === 0) return "";
      const visibleDocs = (view.renderer.getVisibleRanges?.() ?? [])
        .map((item) => item.range?.startContainer.ownerDocument)
        .filter((doc): doc is Document => Boolean(doc));
      const docs =
        visibleDocs.length > 0
          ? [...new Set(visibleDocs)]
          : contents
              .map(({ doc }) => doc)
              .filter((doc): doc is Document => Boolean(doc));
      const fullText = docs
        .map((doc) => {
          if (!doc.body) return "";
          return doc.body.innerText || doc.body.textContent || "";
        })
        .join("\n")
        .trim();
      const MAX_PAGE_TEXT_LENGTH = 2000;
      if (fullText.length > MAX_PAGE_TEXT_LENGTH) {
        return `${fullText.slice(0, MAX_PAGE_TEXT_LENGTH)}\n……（已截断）`;
      }
      return fullText;
    } catch {
      return "";
    }
  }, [view]);

  const {
    input,
    references,
    displayError,
    showThreads,
    threadsKey,
    isInit,
    messages,
    status,
    selectedModel,

    stop,
    setInput,
    setSelectedModel,
    handleAskSelection,
    handleRemoveReference,
    handleSubmit,
    handleRetry,
    handleNewThread,
    handleShowThreads,
    handleSelectThread,
    handleBackFromThreads,
    handleReasoningTimesUpdate,
  } = useChatState({
    chatContext: {
      activeBookId: bookId,
      activeContext,
      activeSectionLabel: progress?.sectionLabel,
      activePageText: getCurrentPageText(),
      activeReadingPosition: createVisibleReadingPosition({
        location: progress?.location,
        sectionIndex: progress?.sectionIndex,
        sectionLabel: progress?.sectionLabel,
        pageCurrent: progress?.pageinfo?.current,
        pageTotal: progress?.pageinfo?.total,
      }),
    },
    getLiveChatContext: () => {
      const current = readerStore.getState();
      return {
        activeBookId: bookId,
        activeContext: current.activeContext,
        activeSectionLabel: current.progress?.sectionLabel,
        activePageText: getCurrentPageText(),
        activeReadingPosition: createVisibleReadingPosition({
          location: current.progress?.location ?? current.location,
          sectionIndex: current.progress?.sectionIndex,
          sectionLabel: current.progress?.sectionLabel,
          pageCurrent: current.progress?.pageinfo?.current,
          pageTotal: current.progress?.pageinfo?.total,
        }),
      };
    },
    setActiveBookId: () => {},
    setActiveContext: setActiveContext,
    currentThread: currentThread,
    setCurrentThread: setCurrentThread,
  });

  const handleViewToolDetail = (toolPart: any) => {
    setToolDetail(toolPart);
    setShowMindmapDialog(true);
  };

  const EmptyState = () => (
    <div className="flex h-full w-full flex-col overflow-y-auto p-2 pb-8">
      <div className="flex flex-1 flex-col justify-end gap-3">
        <div className="flex flex-col items-start gap-4 pl-2">
          <div className="rounded-full bg-muted/70 p-3 shadow-md dark:bg-neutral-800/90">
            <img
              className="size-8"
              src="https://www.notion.so/_assets/9ade71d75a1c0e93.png"
              alt=""
            />
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold text-neutral-900 text-xl dark:text-neutral-50">
              AI 阅读助手
            </h3>
            <p className="max-w-md text-sm dark:text-neutral-400">
              直接提问，或使用下方的快捷按钮开始。
            </p>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <div className="ml-1 flex-shrink-0 border-neutral-300 dark:border-neutral-700">
        <div className="flex h-8 items-center justify-between">
          <div className="flex items-center gap-2 pl-0.5">
            <ModelSelector
              selectedModel={selectedModel}
              onModelSelect={setSelectedModel}
              className="z-40 w-[12rem] flex-shrink-0"
            />
          </div>
          <div className="flex items-center gap-0">
            <Button
              variant="ghost"
              size="icon"
              className="z-40 size-7 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700"
              onClick={handleNewThread}
            >
              <MessageCirclePlus className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="z-40 size-7 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700"
              onClick={handleShowThreads}
            >
              <History className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="z-40 size-7 rounded-full hover:bg-neutral-200 dark:hover:bg-neutral-700"
              onClick={toggleSettingsDialog}
            >
              <Settings className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>
      {showThreads && bookId ? (
        <ChatThreads
          key={`threads-${threadsKey}`}
          bookId={bookId}
          onBack={handleBackFromThreads}
          onSelectThread={handleSelectThread}
        />
      ) : messages.length === 0 && isInit.current ? (
        <EmptyState />
      ) : (
        <ChatContainerRoot className="relative flex-1" autoScroll={autoScroll}>
          <ChatMessages
            messages={messages}
            status={status}
            error={displayError}
            autoScroll={autoScroll}
            scrollKey={currentThread?.id ?? "__init__"}
            onReasoningTimesUpdate={handleReasoningTimesUpdate}
            onRetry={handleRetry}
            canRetry={status === "ready" && !!displayError}
            onAskSelection={handleAskSelection}
            onViewToolDetail={handleViewToolDetail}
          />
          <div className="-translate-x-1/2 pointer-events-none absolute bottom-4 left-1/2 flex w-full max-w-3xl justify-end px-5">
            <div className="pointer-events-auto">
              <ScrollButton />
            </div>
          </div>
        </ChatContainerRoot>
      )}

      {!showThreads && bookId && (
        <ChatInputArea
          input={input}
          setInput={setInput}
          references={references}
          onRemoveReference={handleRemoveReference}
          onSubmit={handleSubmit}
          onStop={stop}
          status={status}
          activeBookId={bookId}
          setActiveBookId={() => {}}
        />
      )}

      <MindmapDialog
        open={showMindmapDialog}
        onOpenChange={setShowMindmapDialog}
        toolPart={toolDetail}
      />
    </main>
  );
}

type SideChatMode = "chat" | "co-reading";

export default function SideChat({ bookId }: ChatContentProps) {
  const storageKey = `deepreader:side-chat-mode:${bookId ?? "global"}`;
  const readingFootprintTarget = useReaderStore(
    (state) => state.pendingReadingFootprint
  ) as ReadingFootprintTarget | null;
  const [mode, setMode] = useState<SideChatMode>(() => {
    if (readingFootprintTarget) return "co-reading";
    const saved = window.localStorage.getItem(storageKey);
    return saved === "co-reading" ? "co-reading" : "chat";
  });

  useEffect(() => {
    window.localStorage.setItem(storageKey, mode);
  }, [mode, storageKey]);

  useEffect(() => {
    if (!readingFootprintTarget || readingFootprintTarget.bookId !== bookId)
      return;
    setMode("co-reading");
    window.localStorage.setItem(
      `deepreader:co-reading-expanded:${readingFootprintTarget.bookId}`,
      "true"
    );
  }, [bookId, readingFootprintTarget]);

  return (
    <div
      id="chat-sidebar"
      className="flex h-full flex-col overflow-hidden bg-background"
    >
      <div className="grid grid-cols-2 gap-1 border-b px-2 py-1.5">
        <button
          type="button"
          className={`flex h-7 items-center justify-center gap-1.5 rounded-md text-xs transition-colors ${
            mode === "chat"
              ? "bg-neutral-200 font-medium text-neutral-900 dark:bg-neutral-700 dark:text-neutral-50"
              : "text-muted-foreground hover:bg-muted"
          }`}
          onClick={() => setMode("chat")}
        >
          <MessagesSquare className="size-3.5" />
          问答
        </button>
        <button
          type="button"
          className={`flex h-7 items-center justify-center gap-1.5 rounded-md text-xs transition-colors ${
            mode === "co-reading"
              ? "bg-primary/10 font-medium text-primary"
              : "text-muted-foreground hover:bg-muted"
          }`}
          onClick={() => setMode("co-reading")}
        >
          <BookOpenText className="size-3.5" />
          共读
        </button>
      </div>
      <div className={mode === "chat" ? "min-h-0 flex-1" : "hidden"}>
        <ChatContent bookId={bookId} />
      </div>
      {mode === "co-reading" && bookId && (
        <CoReadingPanelV2
          bookId={bookId}
          readingFootprintTarget={readingFootprintTarget}
        />
      )}
    </div>
  );
}

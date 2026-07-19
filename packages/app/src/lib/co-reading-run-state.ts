import type {
  CoReadingBlock,
  CoReadingRangeTask,
  CoReadingStatus,
} from "@/types/co-reading";

export const RANGE_TAKEOVER_ERROR =
  "范围阅读已接管，当前普通共读焦点已重新排队";

export class CoReadingFocusCancelledError extends Error {
  constructor(message = "阅读位置已变化，已取消旧页面共读") {
    super(message);
    this.name = "CoReadingFocusCancelledError";
  }
}

export interface VisibleQueuedFocus {
  focusKey: string;
  blockKeys: string[];
}

type VisibleFocusIdentityBlock = Pick<CoReadingBlock, "blockKey" | "focusKey">;
type VisibleFocusBlock = Pick<
  CoReadingBlock,
  "blockKey" | "focusKey" | "status"
>;

export function identifyVisibleFocus(
  blocks: VisibleFocusIdentityBlock[]
): VisibleQueuedFocus | null {
  if (blocks.length === 0) return null;
  const focusKey = blocks[0]?.focusKey?.trim();
  if (!focusKey) return null;
  const blockKeys = blocks.map((block) => block.blockKey);
  if (
    new Set(blockKeys).size !== blockKeys.length ||
    blockKeys.some((key) => !key.trim()) ||
    blocks.some((block) => block.focusKey?.trim() !== focusKey)
  ) {
    return null;
  }
  return { focusKey, blockKeys };
}

/** Historical queued focuses stay recoverable but never auto-preempt the visible focus. */
export function selectVisibleQueuedFocus(
  blocks: VisibleFocusBlock[]
): VisibleQueuedFocus | null {
  const focus = identifyVisibleFocus(blocks);
  if (!focus || blocks.some((block) => block.status !== "queued")) return null;
  return focus;
}

export function sameVisibleFocus(
  left: VisibleQueuedFocus | null,
  right: VisibleQueuedFocus | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.focusKey === right.focusKey &&
    left.blockKeys.length === right.blockKeys.length &&
    left.blockKeys.every((key, index) => key === right.blockKeys[index])
  );
}

export function isCoReadingFocusCancellation(error: unknown): boolean {
  return error instanceof CoReadingFocusCancelledError;
}

export interface CoReadingDrainGate {
  status: CoReadingStatus | undefined;
  queuedCount: number;
  modelReady: boolean;
  runBlocked: boolean;
  processing: boolean;
}

export function shouldDrainCoReadingQueue(gate: CoReadingDrainGate): boolean {
  return (
    gate.status === "active" &&
    gate.queuedCount > 0 &&
    gate.modelReady &&
    !gate.runBlocked &&
    !gate.processing
  );
}

export interface CoReadingRuntimeLabelInput {
  status: CoReadingStatus;
  isProcessing: boolean;
  runBlocked: boolean;
  visibleQueuedBlockCount: number;
  visibleBlockCount: number;
  visibleTerminalBlockCount: number;
  visibleFailedBlockCount: number;
  historicalQueuedBlockCount: number;
}

/** Canonical UI vocabulary for runtime state; detail belongs in the secondary message. */
export function getCoReadingRuntimeLabel(
  state: CoReadingRuntimeLabelInput
): string {
  if (state.status !== "active") return "静默";
  if (state.isProcessing) return "AI正在阅读当前页";
  if (state.runBlocked || state.visibleFailedBlockCount > 0) return "静默";
  if (state.visibleQueuedBlockCount > 0) {
    return `当前一页已就绪，等待${state.visibleQueuedBlockCount}个正文`;
  }
  if (state.historicalQueuedBlockCount > 0 && state.visibleBlockCount === 0) {
    return "历史待处理";
  }
  if (
    state.visibleBlockCount > 0 &&
    state.visibleTerminalBlockCount < state.visibleBlockCount
  ) {
    return "正在跟随阅读";
  }
  return "静默";
}

export function isClaimedFocusCommitted(
  blockKeys: string[],
  blocks: Pick<CoReadingBlock, "blockKey" | "status" | "error">[]
): boolean {
  const uniqueKeys = new Set(blockKeys);
  if (uniqueKeys.size === 0 || uniqueKeys.size !== blockKeys.length)
    return false;

  const matched = blocks.filter((block) => uniqueKeys.has(block.blockKey));
  return (
    matched.length === uniqueKeys.size &&
    new Set(matched.map((block) => block.blockKey)).size === uniqueKeys.size &&
    matched.every(
      (block) =>
        (block.status === "silent" || block.status === "annotated") &&
        !block.error
    )
  );
}

export function isRangeTakeoverCancellation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === RANGE_TAKEOVER_ERROR;
}

export interface RangeWorkerLifecycleLease {
  mounted: boolean;
  cancelled: boolean;
  generation: number;
  currentGeneration: number;
}

export function isRangeWorkerLifecycleCurrent(
  lease: RangeWorkerLifecycleLease
): boolean {
  return (
    lease.mounted &&
    !lease.cancelled &&
    lease.generation === lease.currentGeneration
  );
}

export interface RangeWorkerTaskLease {
  taskId: string;
  expectedUpdatedAt: number;
}

export type RangeWorkerLeaseTask = Pick<
  CoReadingRangeTask,
  "id" | "status" | "updatedAt"
>;

export interface RangeWorkerLeaseDirective {
  shouldAbort: boolean;
  repumpTask: RangeWorkerLeaseTask | null;
}

export function coordinateRangeWorkerLease(
  lease: RangeWorkerTaskLease,
  tasks: RangeWorkerLeaseTask[]
): RangeWorkerLeaseDirective {
  const exactLease = tasks.some(
    (task) =>
      task.id === lease.taskId &&
      task.status === "running" &&
      task.updatedAt === lease.expectedUpdatedAt
  );
  if (exactLease) return { shouldAbort: false, repumpTask: null };
  return {
    shouldAbort: true,
    repumpTask: tasks.find((task) => task.status === "running") ?? null,
  };
}

export function combineAbortSignals(
  ...signals: Array<AbortSignal | null | undefined>
): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal =>
    Boolean(signal)
  );
  if (available.length === 0) return new AbortController().signal;
  if (available.length === 1) return available[0]!;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(available);

  const controller = new AbortController();
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of available) {
    if (signal.aborted) abort(signal);
    else signal.addEventListener("abort", () => abort(signal), { once: true });
  }
  return controller.signal;
}

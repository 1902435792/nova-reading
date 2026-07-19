import assert from "node:assert/strict";
import test from "node:test";
import {
  combineAbortSignals,
  coordinateRangeWorkerLease,
  CoReadingFocusCancelledError,
  getCoReadingRuntimeLabel,
  isClaimedFocusCommitted,
  isCoReadingFocusCancellation,
  isRangeTakeoverCancellation,
  isRangeWorkerLifecycleCurrent,
  RANGE_TAKEOVER_ERROR,
  sameVisibleFocus,
  selectVisibleQueuedFocus,
  shouldDrainCoReadingQueue,
} from "./co-reading-run-state";

const gate = {
  status: "active" as const,
  queuedCount: 2,
  modelReady: true,
  runBlocked: false,
  processing: false,
};

test("ordinary co-reading selects only one complete currently visible queued focus", () => {
  const visible = selectVisibleQueuedFocus([
    { blockKey: "b-1", focusKey: "focus-b", status: "queued" },
    { blockKey: "b-2", focusKey: "focus-b", status: "queued" },
  ]);
  assert.deepEqual(visible, {
    focusKey: "focus-b",
    blockKeys: ["b-1", "b-2"],
  });
  assert.equal(
    selectVisibleQueuedFocus([
      { blockKey: "old", focusKey: "focus-a", status: "queued" },
      { blockKey: "current", focusKey: "focus-b", status: "queued" },
    ]),
    null
  );
  assert.equal(
    selectVisibleQueuedFocus([
      { blockKey: "b-1", focusKey: "focus-b", status: "queued" },
      { blockKey: "b-2", focusKey: "focus-b", status: "tracking" },
    ]),
    null
  );
});

test("a visible focus remains indivisible even when it has six queued DOM blocks", () => {
  const visible = selectVisibleQueuedFocus(
    Array.from({ length: 6 }, (_, index) => ({
      blockKey: `block-${index}`,
      focusKey: "page-focus",
      status: "queued" as const,
    }))
  );
  assert.deepEqual(visible, {
    focusKey: "page-focus",
    blockKeys: [
      "block-0",
      "block-1",
      "block-2",
      "block-3",
      "block-4",
      "block-5",
    ],
  });
});

test("ordinary focus leases require the same ordered visible page and use a distinct cancellation", () => {
  const focus = { focusKey: "focus", blockKeys: ["a", "b"] };
  assert.equal(
    sameVisibleFocus(focus, { ...focus, blockKeys: ["a", "b"] }),
    true
  );
  assert.equal(
    sameVisibleFocus(focus, { ...focus, blockKeys: ["b", "a"] }),
    false
  );
  assert.equal(
    sameVisibleFocus(focus, { focusKey: "next", blockKeys: ["a", "b"] }),
    false
  );
  const error = new CoReadingFocusCancelledError();
  assert.equal(isCoReadingFocusCancellation(error), true);
  assert.equal(isCoReadingFocusCancellation(new Error(error.message)), false);
});
test("runtime labels distinguish silent, follow, ready, processing and history states", () => {
  const base = {
    status: "active" as const,
    isProcessing: false,
    runBlocked: false,
    visibleQueuedBlockCount: 0,
    visibleBlockCount: 3,
    visibleTerminalBlockCount: 0,
    visibleFailedBlockCount: 0,
    historicalQueuedBlockCount: 0,
  };
  assert.equal(
    getCoReadingRuntimeLabel({ ...base, isProcessing: true }),
    "AI正在阅读当前页"
  );
  assert.equal(
    getCoReadingRuntimeLabel({ ...base, visibleQueuedBlockCount: 3 }),
    "当前一页已就绪，等待3个正文"
  );
  assert.equal(getCoReadingRuntimeLabel(base), "正在跟随阅读");
  assert.equal(
    getCoReadingRuntimeLabel({
      ...base,
      visibleBlockCount: 0,
      historicalQueuedBlockCount: 2,
    }),
    "历史待处理"
  );
  assert.equal(getCoReadingRuntimeLabel({ ...base, runBlocked: true }), "静默");
  assert.equal(getCoReadingRuntimeLabel({ ...base, status: "paused" }), "静默");
});

test("a failed run remains blocked even when settings are active", () => {
  assert.equal(shouldDrainCoReadingQueue({ ...gate, runBlocked: true }), false);
});

test("explicit retry can reopen the same active queue by clearing runBlocked", () => {
  assert.equal(shouldDrainCoReadingQueue({ ...gate, runBlocked: false }), true);
});

test("drain gate rejects inactive, empty, model-less, or already processing runs", () => {
  assert.equal(shouldDrainCoReadingQueue({ ...gate, status: "paused" }), false);
  assert.equal(shouldDrainCoReadingQueue({ ...gate, queuedCount: 0 }), false);
  assert.equal(
    shouldDrainCoReadingQueue({ ...gate, modelReady: false }),
    false
  );
  assert.equal(shouldDrainCoReadingQueue({ ...gate, processing: true }), false);
});

test("response-loss recovery recognizes a fully committed claimed focus", () => {
  assert.equal(
    isClaimedFocusCommitted(
      ["a", "b"],
      [
        { blockKey: "a", status: "annotated", error: null },
        { blockKey: "b", status: "silent", error: null },
      ]
    ),
    true
  );
});

test("response-loss recovery rejects partial, failed, duplicated, or pending focus state", () => {
  assert.equal(
    isClaimedFocusCommitted(
      ["a", "b"],
      [{ blockKey: "a", status: "annotated", error: null }]
    ),
    false
  );
  assert.equal(
    isClaimedFocusCommitted(
      ["a"],
      [{ blockKey: "a", status: "failed", error: "model failed" }]
    ),
    false
  );
  assert.equal(
    isClaimedFocusCommitted(
      ["a"],
      [{ blockKey: "a", status: "processing", error: null }]
    ),
    false
  );
  assert.equal(
    isClaimedFocusCommitted(
      ["a", "a"],
      [{ blockKey: "a", status: "silent", error: null }]
    ),
    false
  );
});

test("range takeover cancellation uses exact stable error matching", () => {
  assert.equal(
    isRangeTakeoverCancellation(new Error(RANGE_TAKEOVER_ERROR)),
    true
  );
  assert.equal(isRangeTakeoverCancellation(RANGE_TAKEOVER_ERROR), true);
  assert.equal(
    isRangeTakeoverCancellation(new Error(`${RANGE_TAKEOVER_ERROR}。`)),
    false
  );
  assert.equal(
    isRangeTakeoverCancellation(`prefix ${RANGE_TAKEOVER_ERROR}`),
    false
  );
  assert.equal(
    isRangeTakeoverCancellation(new Error("other cancellation")),
    false
  );
});

test("range lifecycle requires mounted, uncancelled, matching generation", () => {
  const lifecycle = {
    mounted: true,
    cancelled: false,
    generation: 4,
    currentGeneration: 4,
  };
  assert.equal(isRangeWorkerLifecycleCurrent(lifecycle), true);
  assert.equal(
    isRangeWorkerLifecycleCurrent({ ...lifecycle, mounted: false }),
    false
  );
  assert.equal(
    isRangeWorkerLifecycleCurrent({ ...lifecycle, cancelled: true }),
    false
  );
  assert.equal(
    isRangeWorkerLifecycleCurrent({ ...lifecycle, currentGeneration: 5 }),
    false
  );
});

test("range lease keeps only the same running task revision", () => {
  const lease = { taskId: "task", expectedUpdatedAt: 10 };
  assert.deepEqual(
    coordinateRangeWorkerLease(lease, [
      { id: "task", status: "running", updatedAt: 10 },
    ]),
    { shouldAbort: false, repumpTask: null }
  );
  assert.deepEqual(
    coordinateRangeWorkerLease(lease, [
      { id: "task", status: "paused", updatedAt: 11 },
    ]),
    { shouldAbort: true, repumpTask: null }
  );
  assert.deepEqual(coordinateRangeWorkerLease(lease, []), {
    shouldAbort: true,
    repumpTask: null,
  });
});

test("a resumed newer revision aborts the old lease and is eligible to repump", () => {
  const newer = { id: "task", status: "running" as const, updatedAt: 11 };
  assert.deepEqual(
    coordinateRangeWorkerLease({ taskId: "task", expectedUpdatedAt: 10 }, [
      newer,
    ]),
    { shouldAbort: true, repumpTask: newer }
  );
});

test("combined abort signal follows either source and preserves its reason", () => {
  const first = new AbortController();
  const second = new AbortController();
  const firstCombined = combineAbortSignals(first.signal, second.signal);
  const secondReason = new Error("second source cancelled");
  second.abort(secondReason);
  assert.equal(firstCombined.aborted, true);
  assert.equal(firstCombined.reason, secondReason);

  const third = new AbortController();
  const fourth = new AbortController();
  const secondCombined = combineAbortSignals(third.signal, fourth.signal);
  const firstReason = { source: "third" };
  third.abort(firstReason);
  assert.equal(secondCombined.aborted, true);
  assert.equal(secondCombined.reason, firstReason);
});

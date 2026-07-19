import { createModelInstance } from "@/ai/providers/factory";
import { getCoReadingErrorInfo } from "@/lib/co-reading-core";
import { resolveCoReadingModel } from "@/lib/co-reading-model";
import { combineAbortSignals } from "@/lib/co-reading-run-state";
import { useProviderStore } from "@/store/provider-store";
import type { CoReadingSettings } from "@/types/co-reading";
import { NoObjectGeneratedError } from "ai";

const STRUCTURED_REQUEST_MAX_ATTEMPTS = 2;
const STRUCTURED_REQUEST_RETRY_DELAY_MS = 800;

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal?.reason));
    const timer = globalThis.setTimeout(() => finish(resolve), delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function createRequestSignal(timeoutMs: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  const controller = new AbortController();
  globalThis.setTimeout(
    () => controller.abort(new Error("Agent 请求超时")),
    timeoutMs,
  );
  return controller.signal;
}

export function resolveCoReadingAgentModel(
  settings?: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null,
) {
  const state = useProviderStore.getState();
  const selectedModel = resolveCoReadingModel(
    settings,
    state.selectedModel,
    state.modelProviders,
  );
  if (!selectedModel) throw new Error("请先配置并选择可用模型");
  return createModelInstance(selectedModel.providerId, selectedModel.modelId);
}

export async function requestCoReadingStructuredObject<T>(
  request: (abortSignal: AbortSignal) => Promise<T>,
  parseFallback: (text: string) => T,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < STRUCTURED_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    externalSignal?.throwIfAborted();
    try {
      return await request(
        combineAbortSignals(createRequestSignal(timeoutMs), externalSignal),
      );
    } catch (error) {
      lastError = error;
      if (externalSignal?.aborted) throw error;
      if (
        NoObjectGeneratedError.isInstance(error) &&
        typeof error.text === "string"
      ) {
        try {
          return parseFallback(error.text);
        } catch {
          // Preserve the SDK error so provider-specific error normalization remains stable.
        }
      }
      const info = getCoReadingErrorInfo(error);
      if (!info.retryable || attempt + 1 >= STRUCTURED_REQUEST_MAX_ATTEMPTS) {
        throw new Error(info.message, { cause: error });
      }
      await wait(STRUCTURED_REQUEST_RETRY_DELAY_MS, externalSignal);
      externalSignal?.throwIfAborted();
    }
  }
  throw lastError;
}

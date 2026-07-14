import type { CoReadingSettings } from "../types/co-reading.ts";

export interface CoReadingModelRef {
  modelId: string;
  providerId: string;
  providerName: string;
  modelName: string;
}

export interface CoReadingProviderLike {
  name: string;
  active: boolean;
  provider: string;
  models: Array<{ id: string; name?: string; active?: boolean }>;
}

/**
 * Resolve the model used for co-reading.
 * Prefer per-book providerId+modelId (ids only, no credentials).
 * Fall back to the global chat selected model when book override is empty or invalid.
 * Credentials are always resolved live from provider store via createModelInstance.
 */
export function resolveCoReadingModel(
  settings: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null | undefined,
  selectedModel: CoReadingModelRef | null,
  modelProviders: CoReadingProviderLike[],
): CoReadingModelRef | null {
  const providerId = settings?.modelProviderId?.trim() ?? "";
  const modelId = settings?.modelId?.trim() ?? "";

  if (providerId && modelId) {
    const provider = modelProviders.find((item) => item.provider === providerId && item.active);
    const model = provider?.models.find((item) => item.id === modelId && item.active !== false);
    if (provider && model) {
      return {
        modelId: model.id,
        providerId: provider.provider,
        providerName: provider.name,
        modelName: model.name || model.id,
      };
    }
  }

  return selectedModel;
}

export function isBookCoReadingModelOverride(
  settings: Pick<CoReadingSettings, "modelProviderId" | "modelId"> | null | undefined,
): boolean {
  return Boolean(settings?.modelProviderId?.trim() && settings?.modelId?.trim());
}

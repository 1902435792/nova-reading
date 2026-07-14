import assert from "node:assert/strict";
import test from "node:test";
import type { CoReadingModelRef, CoReadingProviderLike } from "./co-reading-model.ts";
import { isBookCoReadingModelOverride, resolveCoReadingModel } from "./co-reading-model.ts";

const globalModel: CoReadingModelRef = {
  modelId: "global-model",
  providerId: "openai",
  providerName: "OpenAI",
  modelName: "Global Model",
};

const providers: CoReadingProviderLike[] = [
  {
    name: "OpenAI",
    active: true,
    provider: "openai",
    models: [
      { id: "global-model", name: "Global Model", active: true },
      { id: "gpt-4o-mini", name: "GPT-4o mini", active: true },
      { id: "inactive", name: "Inactive", active: false },
    ],
  },
  {
    name: "Off Provider",
    active: false,
    provider: "off",
    models: [{ id: "m", name: "M", active: true }],
  },
];

test("empty book preference follows global selected model", () => {
  const resolved = resolveCoReadingModel({ modelProviderId: "", modelId: "" }, globalModel, providers);
  assert.deepEqual(resolved, globalModel);
  assert.equal(isBookCoReadingModelOverride({ modelProviderId: "", modelId: "" }), false);
});

test("book preference resolves active provider model by id only", () => {
  const resolved = resolveCoReadingModel({ modelProviderId: "openai", modelId: "gpt-4o-mini" }, globalModel, providers);
  assert.deepEqual(resolved, {
    modelId: "gpt-4o-mini",
    providerId: "openai",
    providerName: "OpenAI",
    modelName: "GPT-4o mini",
  });
  assert.equal(isBookCoReadingModelOverride({ modelProviderId: "openai", modelId: "gpt-4o-mini" }), true);
  assert.equal(JSON.stringify(resolved).includes("secret"), false);
});

test("inactive provider or model falls back to global", () => {
  assert.deepEqual(
    resolveCoReadingModel({ modelProviderId: "off", modelId: "m" }, globalModel, providers),
    globalModel,
  );
  assert.deepEqual(
    resolveCoReadingModel({ modelProviderId: "openai", modelId: "inactive" }, globalModel, providers),
    globalModel,
  );
  assert.deepEqual(
    resolveCoReadingModel({ modelProviderId: "openai", modelId: "missing" }, globalModel, providers),
    globalModel,
  );
});

test("missing global and invalid book preference yields null", () => {
  assert.equal(resolveCoReadingModel({ modelProviderId: "openai", modelId: "missing" }, null, providers), null);
});

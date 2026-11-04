import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiscoveredModelInput, ProviderSettingsView } from "@zcode/provider";
import type { ModelsDevCatalog } from "../src/model-catalog/contract.js";
import { createProviderRuntime } from "../src/model-provider/providerRuntime.js";

const connection = {
  api: { type: "openai-chat-completions" as const, baseUrl: "https://models.example/v1" },
  access: { type: "api-key" as const, apiKey: "test-only-key" },
};
const recommendation = (model: DiscoveredModelInput): DiscoveredModelInput => ({
  ...(typeof model === "string" ? { id: model } : model),
  catalogConfig: { properties: { contextWindow: 32768, inputFormat: { supportsAudio: true } } },
  catalogSource: {
    source: "models.dev",
    providerId: "example",
    modelId: typeof model === "string" ? model : model.id,
    fetchedAt: 1,
    stale: false,
  },
});
const getModel = (view: ProviderSettingsView, id: string) =>
  view.providers.find((p) => p.providerId === id)!.models[0]!;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "uwork-catalog-integration-"));
  const options = {
    zcodeBuiltinFilePath: fileURLToPath(
      new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    personalFilePath: join(dir, "personal.json"),
    personalPollingIntervalMs: false as const,
    watch: false,
  };
  const seed = createProviderRuntime(options);
  await seed.start();
  const created = await seed.providerSettings.createPersonalProvider({
    providerName: "Catalog Test",
    initialConfig: connection,
  });
  await seed.providerSettings.addPersonalModel(created.providerId, "example-model", {}, true);
  seed.dispose();
  return {
    dir,
    options,
    id: created.providerId,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("catalog update was not published");
}

test("startup enriches saved models without querying providers and preserves manual values", async () => {
  const f = await fixture();
  let gatewayRequests = 0;
  const catalog: ModelsDevCatalog = {
    enrich: async (_connection, models) => models.map(recommendation),
    dispose() {},
  };
  const runtime = createProviderRuntime({
    ...f.options,
    modelCatalog: catalog,
    discoverModels: async () => {
      gatewayRequests++;
      return [];
    },
  });
  try {
    await runtime.start();
    await waitFor(
      async () =>
        getModel(await runtime.providerSettings.getView(), f.id).capabilitySource === "catalog",
    );
    assert.equal(
      getModel(await runtime.providerSettings.getView(), f.id).effectiveConfig.properties
        ?.contextWindow,
      32768,
    );
    assert.equal(gatewayRequests, 0);
    await runtime.providerSettings.savePersonalModelDraft({
      providerId: f.id,
      originalModelId: "example-model",
      nextModelId: "example-model",
      personalConfig: { properties: { contextWindow: 16000 } },
      basedOnRevision: (await runtime.providerSettings.getView()).revision,
      useRecommendedConfig: true,
    });
    await runtime.providerSettings.refresh("catalog-check");
    assert.equal(
      getModel(await runtime.providerSettings.getView(), f.id).effectiveConfig.properties
        ?.contextWindow,
      16000,
    );
  } finally {
    runtime.dispose();
    await f.cleanup();
  }
});

test("catalog wins gateway defaults and new-ID previews never change saved membership", async () => {
  const f = await fixture();
  const catalog: ModelsDevCatalog = {
    enrich: async (_connection, models) => models.map(recommendation),
    dispose() {},
  };
  const runtime = createProviderRuntime({
    ...f.options,
    modelCatalog: catalog,
    discoverModels: async () => [
      { id: "example-model", config: { properties: { contextWindow: 8000 } } },
    ],
  });
  try {
    await runtime.start();
    await waitFor(
      async () =>
        getModel(await runtime.providerSettings.getView(), f.id).capabilitySource === "catalog",
    );
    const found = await runtime.providerSettings.discoverModels(f.id);
    assert.equal(getModel(found.view, f.id).effectiveConfig.properties?.contextWindow, 32768);
    const before = await readFile(f.options.personalFilePath, "utf8");
    const preview = await runtime.providerSettings.resolveModelConfig({
      providerId: f.id,
      originalModelId: "example-model",
      modelId: "new-model",
      personalConfig: {},
    });
    assert.equal(preview.capabilitySource, "catalog");
    assert.equal(preview.inheritedConfig.properties?.contextWindow, 32768);
    assert.equal(await readFile(f.options.personalFilePath, "utf8"), before);
    assert.equal(
      (await runtime.providerSettings.getView()).providers.find((p) => p.providerId === f.id)!
        .models.length,
      1,
    );
  } finally {
    runtime.dispose();
    await f.cleanup();
  }
});

test("a catalogue miss uses built-in defaults instead of gateway values and keeps personal overrides", async () => {
  const f = await fixture();
  const catalog: ModelsDevCatalog = {
    enrich: async (_connection, models) =>
      models.map((model) => ({
        ...(typeof model === "string" ? { id: model } : model),
        catalogConfig: null,
        catalogSource: undefined,
      })),
    dispose() {},
  };
  const runtime = createProviderRuntime({
    ...f.options,
    modelCatalog: catalog,
    discoverModels: async () => [
      {
        id: "example-model",
        config: {
          properties: { contextWindow: 4000 },
          optionSpecs: {
            reasoningLevel: { values: ["low"], map: '{"reasoning_effort": reasoningLevel}' },
          },
        },
      },
    ],
  });
  try {
    await runtime.start();
    await runtime.providerSettings.refresh("catalogue-ready");
    const found = await runtime.providerSettings.discoverModels(f.id);
    const automatic = getModel(found.view, f.id);
    assert.equal(automatic.effectiveConfig.properties?.contextWindow, 200_000);
    assert.deepEqual(automatic.effectiveConfig.optionSpecs?.reasoningLevel?.values, [
      "disabled",
      "enabled",
    ]);
    assert.equal(automatic.capabilitySource, "unknown");
    await runtime.providerSettings.savePersonalModelDraft({
      providerId: f.id,
      originalModelId: "example-model",
      nextModelId: "example-model",
      personalConfig: {
        properties: { contextWindow: 16_000 },
        optionSpecs: {
          reasoningLevel: { values: ["low", "high"], map: '{"reasoning_effort": reasoningLevel}' },
        },
      },
      basedOnRevision: found.view.revision,
      useRecommendedConfig: true,
    });
    const refreshed = getModel((await runtime.providerSettings.discoverModels(f.id)).view, f.id);
    assert.equal(refreshed.effectiveConfig.properties?.contextWindow, 16_000);
    assert.deepEqual(refreshed.effectiveConfig.optionSpecs?.reasoningLevel?.values, [
      "low",
      "high",
    ]);
    assert.equal(refreshed.effectiveBuiltinConfig.properties?.contextWindow, 200_000);
    assert.deepEqual(refreshed.effectiveBuiltinConfig.optionSpecs?.reasoningLevel?.values, [
      "disabled",
      "enabled",
    ]);
    const persisted = JSON.parse(await readFile(f.options.personalFilePath, "utf8"));
    const personalRule = persisted.config.modelConfigRules.providerModelRules.find(
      (rule: { providerId: string; modelId: string }) =>
        rule.providerId === f.id && rule.modelId === "example-model",
    );
    assert.equal(personalRule.config.properties.contextWindow, 16_000);
  } finally {
    runtime.dispose();
    await f.cleanup();
  }
});

test("a catalogue refresh failure cannot reverse a committed manual model save", async () => {
  const f = await fixture();
  let rejectCatalogue = false;
  const catalog: ModelsDevCatalog = {
    enrich: async (_connection, models) => {
      if (rejectCatalogue) throw new Error("catalogue fixture unavailable");
      return models.map(recommendation);
    },
    dispose() {},
  };
  const runtime = createProviderRuntime({ ...f.options, modelCatalog: catalog });
  try {
    await runtime.start();
    await waitFor(
      async () =>
        getModel(await runtime.providerSettings.getView(), f.id).capabilitySource === "catalog",
    );
    rejectCatalogue = true;
    const saved = await runtime.providerSettings.savePersonalModelDraft({
      providerId: f.id,
      originalModelId: "example-model",
      nextModelId: "example-model",
      personalConfig: { properties: { contextWindow: 16_000 } },
      basedOnRevision: (await runtime.providerSettings.getView()).revision,
      useRecommendedConfig: true,
    });
    assert.equal(getModel(saved, f.id).effectiveConfig.properties?.contextWindow, 16_000);
    assert.equal(getModel(saved, f.id).effectiveBuiltinConfig.properties?.contextWindow, 32_768);
    const stored = JSON.parse(await readFile(f.options.personalFilePath, "utf8"));
    const override = stored.config.modelConfigRules.providerModelRules.find(
      (rule: { providerId: string; modelId: string }) =>
        rule.providerId === f.id && rule.modelId === "example-model",
    );
    assert.equal(override.config.properties.contextWindow, 16_000);
  } finally {
    runtime.dispose();
    await f.cleanup();
  }
});

test("a late startup catalogue result cannot write after runtime disposal", async () => {
  const f = await fixture();
  let release!: (models: readonly DiscoveredModelInput[]) => void;
  let pendingModels: readonly DiscoveredModelInput[] = [];
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const catalog: ModelsDevCatalog = {
    enrich: async (_connection, models) => {
      if (!models.some((m) => (typeof m === "string" ? m : m.id) === "example-model"))
        return models;
      pendingModels = models;
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    dispose() {},
  };
  const runtime = createProviderRuntime({ ...f.options, modelCatalog: catalog });
  try {
    await runtime.start();
    await Promise.race([
      startedPromise,
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("startup catalogue was not requested")), 500),
      ),
    ]);
    const before = await readFile(f.options.personalFilePath, "utf8");
    runtime.dispose();
    release(pendingModels.map(recommendation));
    await tick();
    await tick();
    assert.equal(await readFile(f.options.personalFilePath, "utf8"), before);
  } finally {
    runtime.dispose();
    await f.cleanup();
  }
});

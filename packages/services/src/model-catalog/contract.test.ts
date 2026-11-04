import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelsDevCatalog, type ModelsDevCatalog } from "./module.js";
import type { DiscoveredModelInput } from "@zcode/provider";

const connection = {
  apiType: "openai-chat-completions" as const,
  baseUrl: "https://gateway.example/v1",
};
const fixture = () => ({
  openai: {
    id: "openai",
    models: {
      "gpt-6.1-sol": {
        id: "gpt-6.1-sol",
        canonical_model_id: "openai/gpt-6.1-sol",
        limit: { context: 1050000, input: 922000, output: 128000 },
        modalities: {
          input: ["text", "image/jpeg", "image/png", "audio/wav", "video/mp4", "application/pdf"],
          output: ["text"],
        },
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["max", "low", "high"] }],
        tool_call: true,
        description: "must not be cached",
        cost: { input: 999 },
      },
      "image-model": {
        id: "image-model",
        canonical_model_id: "openai/image-model",
        limit: { context: 0, output: 0 },
        modalities: { input: ["text"], output: ["image/png"] },
        reasoning: false,
      },
    },
  },
});
const catalogs: ModelsDevCatalog[] = [];
afterEach(() => {
  catalogs.splice(0).forEach((catalog) => catalog.dispose());
});
const track = (catalog: ModelsDevCatalog) => {
  catalogs.push(catalog);
  return catalog;
};
function enriched(model: DiscoveredModelInput | undefined) {
  if (!model || typeof model === "string") throw new Error("Expected enriched model");
  return model;
}

describe("models.dev catalog", () => {
  it("uses canonical exact metadata, normalizes modalities and preserves gateway input", async () => {
    const request = vi.fn(async () => Response.json(fixture()));
    const catalog = track(createModelsDevCatalog({ request, now: () => 1000 }));
    const original = {
      id: " gpt-6.1-sol ",
      config: { properties: { contextWindow: 1234 } },
      preserveCapabilities: true as const,
    };
    const [result] = await catalog.enrich(connection, [original]);
    expect(result).toMatchObject({
      ...original,
      catalogConfig: {
        properties: {
          contextWindow: 1050000,
          inputFormat: {
            supportsText: true,
            supportsImage: true,
            supportsAudio: true,
            supportsVideo: true,
            supportsPdf: true,
          },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
        },
        optionSpecs: {
          maxOutputTokens: { max: 128000 },
          reasoningLevel: { values: ["low", "high", "max"] },
        },
      },
      catalogSource: {
        source: "models.dev",
        providerId: "openai",
        modelId: "gpt-6.1-sol",
        canonicalModelId: "openai/gpt-6.1-sol",
        fetchedAt: 1000,
        stale: false,
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://models.dev/api.json");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain("gateway.example");
  });

  it("does not guess aliases or ambiguous provider IDs and marks image-only output without zero context", async () => {
    const data = {
      ...fixture(),
      first: { id: "first", models: { shared: { id: "shared", limit: { context: 1000 } } } },
      second: { id: "second", models: { shared: { id: "shared", limit: { context: 2000 } } } },
    };
    const catalog = track(createModelsDevCatalog({ request: async () => Response.json(data) }));
    const result = await catalog.enrich(connection, [
      "ucas-gpt-max",
      "gpt-6.1-sol-custom",
      "shared",
      "image-model",
    ]);
    expect(result.slice(0, 3)).toEqual(
      ["ucas-gpt-max", "gpt-6.1-sol-custom", "shared"].map((id) => ({ id, catalogConfig: null })),
    );
    expect(result[3]).toMatchObject({
      id: "image-model",
      catalogConfig: { properties: { outputFormat: { supportsText: false } } },
    });
    expect(enriched(result[3]).catalogConfig?.properties?.contextWindow).toBeNull();
  });

  it("prefers the exact endpoint and does not infer versions or conflicting canonical roots", async () => {
    const data = {
      ...fixture(),
      reseller: {
        id: "reseller",
        api: "https://reseller.example/v1",
        models: {
          "gpt-6.1-sol": {
            id: "gpt-6.1-sol",
            canonical_model_id: "openai/gpt-6.1-sol",
            limit: { context: 32000 },
          },
        },
      },
      rival: {
        id: "rival",
        models: { "gpt-6.1-sol": { id: "gpt-6.1-sol", limit: { context: 16000 } } },
      },
    };
    const catalog = track(createModelsDevCatalog({ request: async () => Response.json(data) }));
    const preferred = await catalog.enrich(
      { ...connection, baseUrl: "https://reseller.example/v1/" },
      ["gpt-6.1-sol"],
    );
    expect(preferred[0]).toMatchObject({
      catalogSource: { providerId: "reseller" },
      catalogConfig: { properties: { contextWindow: 32000 } },
    });
    const canonical = await catalog.enrich(connection, [
      "openai/gpt-6.1-sol",
      "GPT-6.1-SOL",
      "gpt-6.1-sol-20260101",
    ]);
    expect(canonical[0]).toMatchObject({ catalogSource: { providerId: "openai" } });
    expect(canonical[1]).toMatchObject({ catalogSource: { providerId: "openai" } });
    expect(canonical[2]).toMatchObject({ catalogConfig: null });
  });

  it("does not manufacture reasoning levels from budget or toggle or missing capability fields", async () => {
    const data = {
      provider: {
        id: "provider",
        models: {
          budget: {
            id: "budget",
            reasoning: true,
            reasoning_options: [{ type: "budget_tokens", min: 0, max: 10000 }],
          },
          toggle: { id: "toggle", reasoning: true, reasoning_options: [{ type: "toggle" }] },
          unknown: {
            id: "unknown",
            modalities: { input: ["future/format"], output: ["future/format"] },
          },
        },
      },
    };
    const catalog = track(createModelsDevCatalog({ request: async () => Response.json(data) }));
    const results = await catalog.enrich(connection, [
      "provider/budget",
      "provider/toggle",
      "provider/unknown",
    ]);
    for (const result of results) {
      expect(enriched(result).catalogSource?.providerId).toBe("provider");
      expect(enriched(result).catalogConfig?.optionSpecs?.reasoningLevel).toBeUndefined();
    }
    expect(enriched(results[2]).catalogConfig?.properties?.inputFormat).toBeUndefined();
    expect(enriched(results[2]).catalogConfig?.properties?.outputFormat).toBeUndefined();
  });

  it("does not treat a unique reseller alias as a canonical model on a private endpoint", async () => {
    const data = {
      reseller: {
        id: "reseller",
        api: "https://reseller.example/v1",
        models: {
          "shared-alias": { id: "shared-alias", limit: { context: 99999 } },
        },
      },
    };
    const catalog = track(createModelsDevCatalog({ request: async () => Response.json(data) }));
    expect((await catalog.enrich(connection, ["shared-alias"]))[0]).toEqual({
      id: "shared-alias",
      catalogConfig: null,
      catalogSource: undefined,
    });
    expect(
      (
        await catalog.enrich({ ...connection, baseUrl: "https://reseller.example/v1" }, [
          "shared-alias",
        ])
      )[0],
    ).toMatchObject({ catalogConfig: { properties: { contextWindow: 99999 } } });
    expect((await catalog.enrich(connection, ["reseller/shared-alias"]))[0]).toMatchObject({
      catalogConfig: { properties: { contextWindow: 99999 } },
    });
  });
});

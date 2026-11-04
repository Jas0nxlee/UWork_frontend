import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModelsDevCatalog, type ModelsDevCatalog } from "../module.js";

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
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  catalogs.splice(0).forEach((catalog) => catalog.dispose());
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const track = (catalog: ModelsDevCatalog) => {
  catalogs.push(catalog);
  return catalog;
};
describe("models.dev catalog cache", () => {
  it("merges concurrent refreshes and reuses stale last-good on a bounded failure retry", async () => {
    let now = 1000;
    const request = vi.fn(async () => Response.json(fixture()));
    const catalog = track(
      createModelsDevCatalog({ request, now: () => now, ttlMs: 100, retryMs: 50 }),
    );
    await Promise.all([
      catalog.enrich(connection, ["gpt-6.1-sol"]),
      catalog.enrich(connection, ["gpt-6.1-sol"]),
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    now = 1200;
    request.mockRejectedValue(new Error("offline"));
    const [stale] = await catalog.enrich(connection, ["gpt-6.1-sol"]);
    expect(stale).toMatchObject({ catalogSource: { stale: true, fetchedAt: 1000 } });
    await catalog.enrich(connection, ["gpt-6.1-sol"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves a caller recommendation when stale fallback cannot match it, but clears on fresh absence", async () => {
    let now = 1000;
    const request = vi.fn(async () => Response.json(fixture()));
    const catalog = track(
      createModelsDevCatalog({ request, now: () => now, ttlMs: 100, retryMs: 50 }),
    );
    await catalog.enrich(connection, ["gpt-6.1-sol"]);
    now = 1200;
    request.mockRejectedValue(new Error("offline"));
    const model = {
      id: "newer-model",
      config: { properties: { contextWindow: 4321 } },
      catalogConfig: { properties: { contextWindow: 54321 } },
    };
    expect((await catalog.enrich(connection, [model]))[0]).toBe(model);
    now = 1300;
    request.mockResolvedValue(Response.json(fixture()));
    expect((await catalog.enrich(connection, [model]))[0]).toMatchObject({
      id: "newer-model",
      catalogConfig: null,
      config: model.config,
    });
  });

  it("writes a lightweight cache for restart, excluding descriptions and pricing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "models-dev-test-"));
    dirs.push(dir);
    const cachePath = join(dir, "catalog.json");
    const first = track(
      createModelsDevCatalog({
        request: async () => Response.json(fixture()),
        cachePath,
        now: () => 1000,
      }),
    );
    await first.enrich(connection, ["gpt-6.1-sol"]);
    first.dispose();
    const serialized = await readFile(cachePath, "utf8");
    expect(serialized).not.toContain("must not be cached");
    expect(serialized).not.toContain('"cost"');
    const request = vi.fn(async () => {
      throw new Error("offline");
    });
    const second = track(createModelsDevCatalog({ request, cachePath, now: () => 1001 }));
    const [result] = await second.enrich(connection, ["gpt-6.1-sol"]);
    expect(result).toMatchObject({ catalogConfig: { properties: { contextWindow: 1050000 } } });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not clear caller recommendations when the network or its cache is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "models-dev-invalid-"));
    dirs.push(dir);
    const cachePath = join(dir, "catalog.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      cachePath,
      JSON.stringify({
        version: 1,
        source: "https://untrusted.example",
        fetchedAt: 1,
        data: fixture(),
      }),
    );
    const input = [{ id: "gpt-6.1-sol", preserveCapabilities: true as const }];
    const catalog = track(
      createModelsDevCatalog({ request: async () => Response.json({ broken: true }), cachePath }),
    );
    expect(await catalog.enrich(connection, input)).toBe(input);
    expect(JSON.parse(await readFile(cachePath, "utf8")).source).toBe("https://untrusted.example");
  });

  it("rereads a newer validated cache when its in-memory day expires", async () => {
    const dir = await mkdtemp(join(tmpdir(), "models-dev-shared-"));
    dirs.push(dir);
    const cachePath = join(dir, "catalog.json");
    let now = 1000;
    const request = vi.fn(async () => Response.json(fixture()));
    const first = track(createModelsDevCatalog({ request, cachePath, now: () => now, ttlMs: 100 }));
    await first.enrich(connection, ["gpt-6.1-sol"]);
    const secondData = fixture();
    secondData.openai.models["gpt-6.1-sol"].limit.context = 64000;
    const second = track(
      createModelsDevCatalog({
        request: async () => Response.json(secondData),
        cachePath,
        now: () => 1200,
        ttlMs: 100,
      }),
    );
    await second.enrich(connection, ["gpt-6.1-sol"]);
    now = 1201;
    expect((await first.enrich(connection, ["gpt-6.1-sol"]))[0]).toMatchObject({
      catalogConfig: { properties: { contextWindow: 64000 } },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds response bytes and times out even if a request ignores AbortSignal", async () => {
    const oversized = track(
      createModelsDevCatalog({
        request: async () => new Response("{}", { headers: { "content-length": "999" } }),
        maxBytes: 100,
      }),
    );
    const models = ["gpt-6.1-sol"];
    expect(await oversized.enrich(connection, models)).toBe(models);
    vi.useFakeTimers();
    const timeout = track(
      createModelsDevCatalog({ request: () => new Promise(() => {}), timeoutMs: 10 }),
    );
    const pending = timeout.enrich(connection, models);
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toBe(models);
  });

  it("disposal aborts pending loads without returning or persisting a late recommendation", async () => {
    let enter!: () => void, release!: (response: Response) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const request = vi.fn(() => {
      enter();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const catalog = track(createModelsDevCatalog({ request }));
    const models = ["gpt-6.1-sol"];
    const pending = catalog.enrich(connection, models);
    await entered;
    catalog.dispose();
    expect(await pending).toBe(models);
    release(Response.json(fixture()));
    expect(await catalog.enrich(connection, models)).toBe(models);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

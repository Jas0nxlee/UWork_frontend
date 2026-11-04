import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ModelsDevCatalog, ModelsDevCatalogOptions } from "../contract.js";
import { parseCatalog, type CatalogIndex } from "../domain/catalog.js";
import { catalogModelConfig } from "../domain/modelConfig.js";

const CATALOG_URL = "https://models.dev/api.json";
const MAX_BYTES = 12 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
interface Snapshot {
  readonly fetchedAt: number;
  readonly index: CatalogIndex;
}

async function responseJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("Catalog response unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty catalog response");
  const decoder = new TextDecoder();
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error("Catalog response exceeds limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 一个实例对应一个 Host runtime；公开目录请求与供应商请求完全分离。 */
export function createModelsDevCatalog(options: ModelsDevCatalogOptions): ModelsDevCatalog {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? DAY,
    retry = options.retryMs ?? 5 * 60 * 1000;
  const maxBytes = options.maxBytes ?? MAX_BYTES,
    timeoutMs = options.timeoutMs ?? 15000;
  let snapshot: Snapshot | undefined;
  let nextAttemptAt = 0,
    disposed = false;
  let inFlight: Promise<void> | undefined, controller: AbortController | undefined;

  const readCache = async (): Promise<Snapshot | undefined> => {
    if (!options.cachePath) return undefined;
    try {
      if ((await stat(options.cachePath)).size > maxBytes) return undefined;
      const parsed = JSON.parse(await readFile(options.cachePath, "utf8"));
      if (
        parsed?.version !== 1 ||
        parsed?.source !== CATALOG_URL ||
        typeof parsed.fetchedAt !== "number" ||
        !Number.isFinite(parsed.fetchedAt) ||
        parsed.fetchedAt < 0 ||
        parsed.fetchedAt > now() + 60000
      )
        return undefined;
      return { fetchedAt: parsed.fetchedAt, index: parseCatalog(parsed.data) };
    } catch {
      return undefined;
    }
  };
  const persist = async (value: Snapshot): Promise<void> => {
    if (!options.cachePath || disposed) return;
    const temporary = `${options.cachePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(options.cachePath), { recursive: true });
      await writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          source: CATALOG_URL,
          fetchedAt: value.fetchedAt,
          data: value.index.data,
        }),
        { mode: 0o600 },
      );
      if (!disposed) await rename(temporary, options.cachePath);
    } catch {
      /* 缓存失败不撤销已经校验的公开目录，也不阻断模型发现。 */
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  };
  const refresh = async (): Promise<void> => {
    // 每次过期重新验证磁盘快照，复用其他 Host 已经更新的公开目录。
    const cached = await readCache();
    if (disposed) return;
    if (cached && (!snapshot || cached.fetchedAt > snapshot.fetchedAt)) snapshot = cached;
    if (snapshot && now() - snapshot.fetchedAt < ttl) return;
    const activeController = new AbortController();
    controller = activeController;
    const aborted = new Promise<never>((_resolve, reject) => {
      activeController.signal.addEventListener(
        "abort",
        () => reject(new Error("Catalog request aborted")),
        { once: true },
      );
    });
    const timer = setTimeout(() => activeController.abort(), timeoutMs);
    try {
      const response = await Promise.race([
        aborted,
        options.request(CATALOG_URL, {
          method: "GET",
          redirect: "error",
          signal: activeController.signal,
          headers: { Accept: "application/json", "User-Agent": "UWork Model Catalog" },
        }),
      ]);
      const index = parseCatalog(await Promise.race([aborted, responseJson(response, maxBytes)]));
      if (disposed) return;
      snapshot = { fetchedAt: now(), index };
      nextAttemptAt = 0;
      await persist(snapshot);
    } catch {
      if (!disposed) nextAttemptAt = now() + retry;
    } finally {
      clearTimeout(timer);
      controller = undefined;
    }
  };
  const ensure = async (): Promise<Snapshot | undefined> => {
    if (disposed || (snapshot && now() - snapshot.fetchedAt < ttl) || now() < nextAttemptAt)
      return snapshot;
    if (!inFlight) {
      const current = refresh();
      inFlight = current;
      void current.finally(() => {
        if (inFlight === current) inFlight = undefined;
      });
    }
    await inFlight;
    return snapshot;
  };
  return {
    async enrich(connection, models) {
      if (disposed || !models.length) return models;
      const current = await ensure();
      if (disposed || !current) return models;
      const stale = now() - current.fetchedAt >= ttl;
      return models.map((model) => {
        const original = typeof model === "string" ? { id: model } : model;
        const found = current.index.match(connection.baseUrl, original.id);
        if (!found)
          return stale ? model : { ...original, catalogConfig: null, catalogSource: undefined };
        return {
          ...original,
          catalogConfig: catalogModelConfig(found.model),
          catalogSource: {
            source: "models.dev" as const,
            providerId: found.providerId,
            modelId: found.model.id,
            ...(found.model.canonical_model_id
              ? { canonicalModelId: found.model.canonical_model_id }
              : {}),
            fetchedAt: current.fetchedAt,
            stale,
          },
        };
      });
    },
    dispose() {
      disposed = true;
      controller?.abort();
    },
  };
}

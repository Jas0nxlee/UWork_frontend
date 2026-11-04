import type { DiscoveredModelInput, ProviderConfigObject } from "@zcode/provider";
import type { ApiClient } from "@zcode/shared";

export interface ModelsDevConnection {
  readonly apiType: NonNullable<ProviderConfigObject["api"]>["type"];
  readonly baseUrl: string;
}

export interface ModelsDevCatalogOptions {
  /** 仅访问固定公开目录；调用时不附加供应商 Key、headers 或模型请求内容。 */
  readonly request: ApiClient["request"];
  readonly cachePath?: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly retryMs?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface ModelsDevCatalog {
  /**
   * 单个 runtime 实例拥有内存快照与 single-flight。返回保留原 gateway 数据的副本。
   * 成功匹配附加 catalogConfig/source；新鲜目录无匹配以 null 清旧推荐；不可用或 stale 未匹配原样返回。
   * 目录只提供推荐，不证明私有网关的实际限制。方法等待缓存写入尝试，不向外抛网络/缓存失败。
   */
  enrich(
    connection: ModelsDevConnection,
    models: readonly DiscoveredModelInput[],
  ): Promise<readonly DiscoveredModelInput[]>;
  /** 中止在途目录请求；后续 enrich 原样返回，不再发布或持久化迟到结果。 */
  dispose(): void;
}

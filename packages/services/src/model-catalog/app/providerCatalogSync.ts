import type {
  DiscoveredModelInput,
  ProviderConfigObject,
  ProviderSettingsFacade,
  ResolveModelConfigInput,
} from "@zcode/provider";
import type { ModelsDevCatalog } from "../contract.js";

/** Facade 是持久状态唯一写入者；目录只返回当前连接的推荐层。 */
export function createProviderCatalogSync(options: {
  facade: ProviderSettingsFacade;
  catalog?: ModelsDevCatalog;
  isActive: () => boolean;
}) {
  const { facade, catalog, isActive } = options;
  const running = new Map<string, Promise<void>>();
  const enrich = async (config: ProviderConfigObject, models: readonly DiscoveredModelInput[]) => {
    const api = config.api;
    if (!catalog || !api?.type || !api.baseUrl || !models.length) return models;
    return catalog.enrich({ apiType: api.type, baseUrl: api.baseUrl }, models);
  };
  const refreshProvider = (providerId: string): Promise<void> => {
    const pending = running.get(providerId);
    if (pending) return pending;
    const operation = (async () => {
      await facade.waitForProviderOperations(providerId);
      if (!isActive()) return;
      const before = facade.getView();
      const provider = before.providers.find((item) => item.providerId === providerId);
      if (!provider || provider.effectiveConfig.group !== "standard-personal") return;
      const models = await enrich(
        provider.effectiveConfig,
        provider.models.map((model) => ({
          id: model.modelId,
          preserveCapabilities: true as const,
        })),
      );
      // 请求期间的编辑、删除或 Host dispose 都是明确取消边界，不重放旧成员或旧连接。
      if (!isActive() || facade.getView().revision !== before.revision) return;
      if (
        !models.some(
          (model) =>
            typeof model !== "string" &&
            (model.catalogConfig !== undefined || model.config !== undefined),
        )
      )
        return;
      try {
        await facade.addDiscoveredModels(providerId, models, before.revision);
      } catch (error) {
        // 队列内仍可能有其他写入先提交；过期目录是取消，不应把已保存的用户编辑报成失败。
        if (!isActive() || facade.getView().revision !== before.revision) return;
        throw error;
      }
    })();
    running.set(providerId, operation);
    const cleanup = () => {
      if (running.get(providerId) === operation) running.delete(providerId);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  };
  return {
    enrich,
    wait: async (providerId: string) => {
      await running.get(providerId);
    },
    refresh: async (providerId?: string) => {
      if (!catalog || !isActive()) return facade.getView();
      const ids = providerId
        ? [providerId]
        : facade.getView().providers.map((item) => item.providerId);
      // 每次重新取 revision，避免自身上一笔目录事务让后续 Provider 误判为过期。
      for (const id of ids) {
        if (!isActive()) break;
        await refreshProvider(id);
      }
      return facade.getView();
    },
    preview: async (input: ResolveModelConfigInput): Promise<DiscoveredModelInput | undefined> => {
      await running.get(input.providerId);
      const before = facade.getView();
      const provider = before.providers.find((item) => item.providerId === input.providerId);
      if (!provider || !catalog) return undefined;
      const models = await enrich(provider.effectiveConfig, [
        { id: input.modelId, preserveCapabilities: true },
      ]);
      if (!isActive() || facade.getView().revision !== before.revision)
        throw new Error("供应商配置已变化，请重新加载模型");
      return models[0];
    },
  };
}

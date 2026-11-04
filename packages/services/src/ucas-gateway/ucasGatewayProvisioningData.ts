import type { UcasGatewayEndpoint, UcasGatewayUsageRequest, UcasGatewayView } from "@zcode/shared";
import type { DiscoveredModelInput } from "@zcode/provider";
import { UcasGatewayRequestError, type UcasGatewayClient } from "./ucasGatewayClient.js";

/** 企业账号没有 Key 时生成的别名，沿用服务端长度限制。 */
const GATEWAY_KEY_ALIAS = "UWork";

/**
 * 只使用公网 HTTPS 入口。服务端同时下发 `llm_base_url_internal`（明文 http、仅校园网可达），
 * 需要统一走 TLS 且不把内网地址带进客户端，因此既不探测也不写入 Provider 配置。
 */
const resolveEndpoint = (endpoints: { publicBaseUrl: string }): UcasGatewayEndpoint => ({
  baseUrl: endpoints.publicBaseUrl,
  publicBaseUrl: endpoints.publicBaseUrl,
  internalBaseUrl: null,
  source: "public",
});
const ensureKey = async (
  client: UcasGatewayClient,
): Promise<{ key: UcasGatewayView["key"]; apiKey: string; reused: boolean }> => {
  const keys = await client.listKeys();
  const active = keys.find((item) => item.status === "active") ?? keys[0];
  if (active) {
    const apiKey = await client.revealKey(active.id);
    return { key: active, apiKey, reused: true };
  }
  const generated = await client.generateKey(GATEWAY_KEY_ALIAS);
  return { key: generated.key, apiKey: generated.apiKey, reused: false };
};
/** 目录失败与成功的 ID-only 是不同事实：失败只能补成员，不能清掉已确认能力。 */
export const readUcasGatewayModelCatalog = async (
  client: UcasGatewayClient,
  baseUrl: string,
  apiKey: string | undefined,
  modelIds?: readonly string[],
): Promise<{
  ids: readonly string[];
  models: readonly DiscoveredModelInput[];
  error: unknown;
}> => {
  let catalog: readonly DiscoveredModelInput[] = [];
  let error: unknown = apiKey ? null : new UcasGatewayRequestError("invalid");
  // 套餐接口只说明可见性；能力从同一端点的协议目录读取，不按逻辑别名猜测。
  if (apiKey) {
    try {
      catalog = await client.listEndpointModels(baseUrl, apiKey);
    } catch (failure) {
      // 错误能力整包拒绝；网络/旧网关不支持目录时保留既有能力并显示错误。
      if (failure instanceof UcasGatewayRequestError && failure.kind === "invalid") throw failure;
      error = failure;
    }
  }
  const byId = new Map(
    catalog.map((model) => [typeof model === "string" ? model : model.id, model]),
  );
  const ids = modelIds ?? [...byId.keys()];
  return {
    ids,
    models: ids.map((id) => byId.get(id) ?? { id, preserveCapabilities: true }),
    error,
  };
};

/** 模型应用只读取既有 Key，不走账号同步的 list/generate 与端点发现。 */
export async function readUcasGatewayModelsForApplication(
  client: UcasGatewayClient,
  baseUrl: string,
  modelIds: readonly string[],
  keyId?: string,
) {
  let apiKey: string | undefined;
  let keyError: unknown;
  if (keyId) {
    try {
      apiKey = await client.revealKey(keyId);
    } catch (error) {
      keyError = error;
    }
  }
  const catalog = await readUcasGatewayModelCatalog(client, baseUrl, apiKey, modelIds);
  return { ...catalog, error: keyError ?? catalog.error };
}

/** 仅收集 API 数据；身份 admission、本机写入与视图提交由 Gateway Service 唯一持有。 */
export async function readUcasGatewayProvisioningData(
  client: UcasGatewayClient,
  usageRequest: UcasGatewayUsageRequest,
) {
  const keyInfo = await ensureKey(client);
  const endpoint = resolveEndpoint(await client.readGatewayEndpoints());
  const subscription = await client.readPlanModels();
  const catalog = await readUcasGatewayModelCatalog(
    client,
    endpoint.baseUrl,
    keyInfo.apiKey,
    subscription.models.length ? subscription.models : undefined,
  );
  const plan = {
    ...catalog,
    unrestricted: subscription.unrestricted,
    hasSubscription: subscription.hasSubscription,
  };
  const subscriptions = [...(await client.readSubscriptions().catch(() => []))];
  const usage = await client.readUsage(usageRequest).catch(() => null);
  return { keyInfo, endpoint, plan, subscriptions, usage };
}

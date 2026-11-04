import type { Event } from "@zcode/rpc";
import type { DiscoveredModelInput } from "@zcode/provider";
import {
  ServiceChannels,
  type UcasGatewaySyncResult,
  type UcasGatewayUsageRequest,
  type UcasGatewayView,
} from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type {
  UcasGatewayEndpoint,
  UcasGatewayError,
  UcasGatewayKey,
  UcasGatewayModels,
  UcasGatewaySubscription,
  UcasGatewaySyncResult,
  UcasGatewayUsageMetric,
  UcasGatewayUsagePeriod,
  UcasGatewayUsageRequest,
  UcasGatewayUsageStats,
  UcasGatewayUser,
  UcasGatewayView,
} from "@zcode/shared";

/** 企业网关读取与自动配置；视图不含 JWT 与 API Key 明文。 */
export interface IUcasGatewayService {
  getView(): Promise<UcasGatewayView>;
  sync(reason: string): Promise<UcasGatewaySyncResult>;
  refreshUsage(request: UcasGatewayUsageRequest): Promise<UcasGatewayView>;
  refreshModels(): Promise<UcasGatewayView>;
  applyModels(): Promise<UcasGatewaySyncResult>;
  replaceApiKey(): Promise<UcasGatewaySyncResult>;
  onDidChange: Event<UcasGatewayView>;
}
export const IUcasGatewayService = createServiceDescriptor<IUcasGatewayService>(
  ServiceChannels.UcasGateway,
);

/** Node 装配注入的 Provider 写入端口；网关服务不直接依赖 Provider 实现。 */
export interface UcasGatewayProvisioningTarget {
  apply(input: {
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly replaceApiKey?: boolean;
    /** 模型应用只写成员/自动能力，不执行连接或密钥配置。 */
    readonly modelsOnly?: true;
    readonly modelIds?: readonly DiscoveredModelInput[];
  }): Promise<{
    readonly apiKeyApplied: boolean;
    readonly hasApiKey: boolean;
    readonly modelsAdded: number;
    readonly modelsSkipped: number;
  }>;
  /** 读取 UCAS 供应商当前模型 ID，用于计算套餐模型的待追加数量。 */
  listModels(): Promise<readonly string[]>;
}

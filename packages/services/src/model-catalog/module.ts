/**
 * model-catalog 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const modelCatalogModule = {
  id: "model-catalog",
  requires: ["provider", "shared"],
  provides: ["model-catalog"],
  publicEntrypoints: ["module.ts", "contract.ts"],
} as const;

export { createModelsDevCatalog } from "./adapters/modelsDevCatalog.js";
export { createProviderCatalogSync } from "./app/providerCatalogSync.js";
export type { ModelsDevCatalog, ModelsDevCatalogOptions, ModelsDevConnection } from "./contract.js";

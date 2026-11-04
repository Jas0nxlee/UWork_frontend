import { ModelConfig } from "./config/model-config.js";

export const UCAS_PROVIDER_ID = "ucas";
export const UCAS_PROVIDER_TEMPLATE_ID = "ucas";
export const UCAS_PROVIDER_NAME = "ucas";
export const UCAS_BASE_URL = "https://llm.ucas.com.cn:15000/v1";
export const UCAS_API_TYPE = "openai-chat-completions" as const;

export const UCAS_DEFAULT_MODEL_IDS = Object.freeze([
  "ucas-deepseek-flash",
  "ucas-gpt-max",
  "ucas-gpt-mini",
  "ucas-kimi",
  "ucas-glm",
  "ucas-gemini-flash",
]);

export function isUcasLogicalModelAlias(providerId: string, modelId: string): boolean {
  return providerId === UCAS_PROVIDER_ID && /^ucas-/i.test(modelId);
}

export function createUcasDefaultModelConfig(): ModelConfig {
  // UCAS 别名不能证明后端型号能力；仅初始化启用，能力由网关元数据或型号规则提供。
  return new ModelConfig({ enabled: true });
}

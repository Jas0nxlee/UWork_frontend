import { z } from "zod";
import { modelSelectionSchema } from "@zcode/shared/model-selection";
import { completeModelConfigDataSchema, modelConfigDataSchema } from "@zcode/shared/model-config";
import {
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  extractManualModelConfig,
  manualModelConfigSchema,
  UCAS_PROVIDER_ID,
  UCAS_PROVIDER_NAME,
  UCAS_PROVIDER_TEMPLATE_ID,
  type ProviderConfigMap,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";

const CURRENT_SCHEMA_VERSION = 1 as const;

type ProviderConfigFileMigration = (input: unknown) => unknown;

const migrations: ReadonlyMap<number, ProviderConfigFileMigration> = new Map();

const storedProviderConfigSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    config: z
      .object({
        providerOrder: z.array(z.string().min(1)).optional(),
        providerConfigRules: z.unknown(),
        modelConfigRules: z.unknown(),
        defaultModelSelection: modelSelectionSchema.optional(),
      })
      .strict(),
  })
  .strict();

export class UnsupportedProviderConfigVersionError extends Error {
  readonly version: number | null;

  constructor(message: string, version: number | null) {
    super(message);
    this.name = "UnsupportedProviderConfigVersionError";
    this.version = version;
  }
}

export function decodeProviderConfigFile(input: unknown): ProviderConfigLayerUpdate {
  let candidate = input;
  let version = readSchemaVersion(candidate);
  if (version === null) {
    throw new UnsupportedProviderConfigVersionError("Provider Config 缺少 schemaVersion", null);
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedProviderConfigVersionError(
      `Provider Config schemaVersion ${version} 高于当前支持的 ${CURRENT_SCHEMA_VERSION}`,
      version,
    );
  }
  while (version < CURRENT_SCHEMA_VERSION) {
    const migration = migrations.get(version);
    if (!migration) {
      throw new UnsupportedProviderConfigVersionError(
        `缺少 Provider Config schemaVersion ${version} 到 ${version + 1} 的迁移器`,
        version,
      );
    }
    candidate = migration(candidate);
    const nextVersion = requireSchemaVersion(candidate);
    if (nextVersion !== version + 1) {
      throw new Error(
        `Provider Config 迁移器必须从 schemaVersion ${version} 迁移到 ${version + 1}`,
      );
    }
    version = nextVersion;
  }
  const parsed = storedProviderConfigSchema.parse(candidate);
  const providers = parsePersonalProviderConfigMap(parsed.config.providerConfigRules);
  return Object.freeze({
    providers,
    models: parsePersonalModelConfigRules(
      normalizeLegacyManualRules(
        normalizeLegacyUcasRules(parsed.config.modelConfigRules, providers),
      ),
    ),
    providerOrder: parsed.config.providerOrder,
    ...(parsed.config.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: parsed.config.defaultModelSelection }),
  });
}

const legacyCompleteManualSchema = completeModelConfigDataSchema.extend({
  enabled: modelConfigDataSchema.shape.enabled,
});

// 旧编辑器曾把 MFJS 当作手动必填项；隐藏后仅在文件边界识别旧合法形状，
// 提取现行可编辑字段，避免整个个人配置加载失败或继续冻结系统能力。
const legacyEditableManualSchema = manualModelConfigSchema.extend({
  properties: manualModelConfigSchema.shape.properties.extend({
    requiresMfjsToolSchema:
      completeModelConfigDataSchema.shape.properties.shape.requiresMfjsToolSchema,
  }),
});

function normalizeLegacyManualRules(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.manualProviderModelRules)) return input;
  return {
    ...input,
    manualProviderModelRules: input.manualProviderModelRules.map((rule: unknown) => {
      if (!isRecord(rule) || manualModelConfigSchema.safeParse(rule.config).success) return rule;
      // 仅识别旧完整形状，不把未知/损坏配置通过删字段伪装成成功；公共写入入口仍严格拒绝隐藏叶子。
      const legacy = z
        .union([legacyCompleteManualSchema, legacyEditableManualSchema])
        .safeParse(rule.config);
      return legacy.success ? { ...rule, config: extractManualModelConfig(legacy.data) } : rule;
    }),
  };
}

function normalizeLegacyUcasRules(input: unknown, providers: ProviderConfigMap): unknown {
  if (
    !isRecord(input) ||
    "discoveredProviderModelRules" in input ||
    !Array.isArray(input.providerModelRules)
  )
    return input;
  const ucasIds = new Set([
    UCAS_PROVIDER_ID,
    ...providers
      .rules()
      .filter(
        (rule) =>
          rule.templateId === UCAS_PROVIDER_TEMPLATE_ID ||
          (rule.config.group === "standard-personal" &&
            rule.providerName?.trim().toLocaleLowerCase() ===
              UCAS_PROVIDER_NAME.toLocaleLowerCase()),
      )
      .map((rule) => rule.providerId),
  ]);
  return {
    ...input,
    providerModelRules: input.providerModelRules.map((rule: unknown) => {
      if (!isRecord(rule) || !ucasIds.has(String(rule.providerId)) || !isRecord(rule.config))
        return rule;
      const config = rule.config;
      const properties = config.properties;
      const optionSpecs = config.optionSpecs;
      if (
        !isRecord(properties) ||
        !isRecord(properties.inputFormat) ||
        !isRecord(optionSpecs) ||
        !isRecord(optionSpecs.reasoningLevel)
      )
        return rule;
      const inputFormat = properties.inputFormat;
      const reasoning = optionSpecs.reasoningLevel;
      // 旧 UCAS 播种把四组叶子冻结为个人规则；只识别完整签名，保留偏离值和手动规则。
      if (
        !("contextWindow" in properties) ||
        !("supportsText" in inputFormat) ||
        !("supportsImage" in inputFormat) ||
        !Array.isArray(reasoning.values)
      )
        return rule;
      const next = structuredClone(config);
      const nextProperties = next.properties as Record<string, unknown>;
      const nextInput = nextProperties.inputFormat as Record<string, unknown>;
      const nextOptions = next.optionSpecs as Record<string, unknown>;
      const nextReasoning = nextOptions.reasoningLevel as Record<string, unknown>;
      if (nextProperties.contextWindow === 1_000_000) delete nextProperties.contextWindow;
      if (nextInput.supportsText === true) delete nextInput.supportsText;
      if (nextInput.supportsImage === true) delete nextInput.supportsImage;
      if (JSON.stringify(nextReasoning.values) === JSON.stringify(["low", "high", "max"]))
        delete nextReasoning.values;
      if (Object.keys(nextInput).length === 0) delete nextProperties.inputFormat;
      if (Object.keys(nextReasoning).length === 0) delete nextOptions.reasoningLevel;
      if (Object.keys(nextProperties).length === 0) delete next.properties;
      if (Object.keys(nextOptions).length === 0) delete next.optionSpecs;
      return { ...rule, config: next };
    }),
  };
}

export function encodeProviderConfigFile(update: ProviderConfigLayerUpdate) {
  const modelConfigRules = update.models.toPersonalJSON();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    config: {
      ...(update.providerOrder === undefined ? {} : { providerOrder: update.providerOrder }),
      providerConfigRules: { providerRules: update.providers.toJSON() },
      modelConfigRules: {
        ...modelConfigRules,
        discoveredProviderModelRules: modelConfigRules.discoveredProviderModelRules ?? [],
      },
      ...(update.defaultModelSelection === undefined
        ? {}
        : { defaultModelSelection: update.defaultModelSelection }),
    },
  };
}

function readSchemaVersion(input: unknown): number | null {
  if (!isRecord(input) || !("schemaVersion" in input)) return null;
  const version = input.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 0) {
    throw new UnsupportedProviderConfigVersionError(
      "Provider Config schemaVersion 必须是非负整数",
      null,
    );
  }
  return version as number;
}

function requireSchemaVersion(input: unknown): number {
  const version = readSchemaVersion(input);
  if (version === null) {
    throw new UnsupportedProviderConfigVersionError(
      "Provider Config 迁移器必须产生版本化文件",
      null,
    );
  }
  return version;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

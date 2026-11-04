import { describe, expect, it } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelPropertiesConfig,
  parseZCodeBuiltinModelConfigRules,
  parseModelConfig,
  parsePersonalModelConfigRules,
  extractManualModelConfig,
} from "../src/index.js";

const emptyBuiltin = {
  modelRules: [],
  modelApiRules: [],
  providerSiteRules: [],
  templateModelRules: [],
  builtinProviderModelRules: [],
};
const complete = {
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 128000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: { values: ["disabled"], map: "{}" },
    maxOutputTokens: { max: 8192, map: '{"max_tokens":maxOutputTokens}' },
  },
};

describe("ModelConfigRules", () => {
  it("网关按字段优先于models.dev，刷新网关保持目录，明确无匹配只清目录", () => {
    const scope = { apiType: "openai-chat-completions", baseUrl: "https://gateway.example/v1" };
    const input = { providerId: "p", modelId: "m", ...scope };
    const source = {
      source: "models.dev" as const,
      providerId: "openai",
      modelId: "m",
      fetchedAt: 123,
      stale: false,
    };
    const builtin = parseZCodeBuiltinModelConfigRules({
      ...emptyBuiltin,
      modelRules: [{ modelMatch: ".*", config: complete }],
    });
    let personal = ModelConfigRules.empty().setDiscovered(
      "p",
      "m",
      parseModelConfig({
        properties: { contextWindow: 64_000, inputFormat: { supportsImage: true } },
      }),
      scope,
      { config: parseModelConfig({ properties: { contextWindow: 128_000 } }), source },
    );
    let effective = ModelConfigRules.composeEffective(builtin, personal);
    expect(effective.resolve(input).properties).toMatchObject({
      contextWindow: 64_000,
      inputFormat: { supportsImage: true },
    });
    expect(effective.capabilitySource(input)).toBe("gateway");
    personal = personal.setDiscovered(
      "p",
      "m",
      parseModelConfig({ properties: { contextWindow: 256_000 } }),
      scope,
    );
    expect(
      ModelConfigRules.composeEffective(builtin, personal).resolve(input).properties?.contextWindow,
    ).toBe(256_000);
    const roundTrip = parsePersonalModelConfigRules(personal.toPersonalJSON());
    expect(roundTrip.getDiscoveredRule(input)?.catalogSource).toEqual(source);
    personal = personal.setExact(
      "p",
      "m",
      parseModelConfig({ properties: { contextWindow: 32_000 } }),
    );
    expect(
      ModelConfigRules.composeEffective(builtin, personal).resolve(input).properties?.contextWindow,
    ).toBe(32_000);
    personal = personal
      .deleteExact("p", "m")
      .setDiscovered("p", "m", personal.getDiscovered(input)!, scope, null);
    effective = ModelConfigRules.composeEffective(builtin, personal);
    expect(effective.resolve(input).properties?.contextWindow).toBe(256_000);
    expect(effective.capabilitySource(input)).toBe("gateway");
  });

  it("稀疏网关只覆盖明确字段，其余继承目录再内置，个人覆盖仍最高", () => {
    const scope = { apiType: "openai-chat-completions", baseUrl: "https://gateway.example/v1" };
    const input = { providerId: "p", modelId: "m", ...scope };
    const builtin = parseZCodeBuiltinModelConfigRules({
      ...emptyBuiltin,
      modelRules: [{ modelMatch: ".*", config: complete }],
    });
    let personal = ModelConfigRules.empty().setDiscovered(
      "p",
      "m",
      parseModelConfig({
        properties: { contextWindow: 64_000, inputFormat: { supportsImage: false } },
        optionSpecs: {
          reasoningLevel: { values: ["high"], map: '{"reasoning_effort": reasoningLevel}' },
        },
      }),
      scope,
      {
        config: parseModelConfig({
          properties: {
            contextWindow: 128_000,
            inputFormat: { supportsImage: true, supportsAudio: true },
          },
          optionSpecs: {
            reasoningLevel: { values: ["low", "high", "xhigh"] },
            maxOutputTokens: { max: 4096 },
          },
        }),
        source: {
          source: "models.dev",
          providerId: "example",
          modelId: "m",
          fetchedAt: 123,
          stale: false,
        },
      },
    );
    let resolved = ModelConfigRules.composeEffective(builtin, personal).resolve(input);
    expect(resolved.properties).toMatchObject({
      contextWindow: 64_000,
      inputFormat: { supportsImage: false, supportsAudio: true, supportsVideo: false },
    });
    expect(resolved.optionSpecs?.reasoningLevel?.values).toEqual(["high"]);
    expect(resolved.optionSpecs?.maxOutputTokens?.max).toBe(4096);
    personal = personal.setExact(
      "p",
      "m",
      parseModelConfig({
        properties: { contextWindow: 32_000, inputFormat: { supportsAudio: false } },
      }),
    );
    resolved = ModelConfigRules.composeEffective(builtin, personal).resolve(input);
    expect(resolved.properties).toMatchObject({
      contextWindow: 32_000,
      inputFormat: { supportsAudio: false },
    });
  });

  it("UCAS逻辑别名可用明确模板映射，仍不把宽泛型号词匹配当作确认", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*deepseek.*",
        config: parseModelConfig({ properties: { contextWindow: 64_000 } }),
      },
      {
        type: "template-model",
        templateId: "ucas",
        modelId: "ucas-deepseek-flash",
        config: parseModelConfig({ properties: { contextWindow: 128_000 } }),
      },
    ]);
    expect(
      rules.capabilitySource(
        { providerId: "ucas", templateId: "ucas", modelId: "ucas-deepseek-flash" },
        true,
      ),
    ).toBe("builtin");
    expect(
      rules.capabilitySource(
        { providerId: "ucas", templateId: "ucas", modelId: "ucas-deepseek-unknown" },
        true,
      ),
    ).toBe("unknown");
  });

  it("目录禁用推理不发送effort，明确effort仅为空映射补协议而保留复杂型号映射", () => {
    const scope = { apiType: "openai-chat-completions", baseUrl: "https://gateway.example/v1" };
    const input = { providerId: "p", modelId: "m", ...scope };
    const source = {
      source: "models.dev" as const,
      providerId: "openai",
      modelId: "m",
      fetchedAt: 123,
      stale: false,
    };
    const builtin = parseZCodeBuiltinModelConfigRules({
      ...emptyBuiltin,
      modelRules: [{ modelMatch: ".*", config: complete }],
    });
    let personal = ModelConfigRules.empty().setDiscovered("p", "m", parseModelConfig({}), scope, {
      config: parseModelConfig({ optionSpecs: { reasoningLevel: { values: ["low", "high"] } } }),
      source,
    });
    expect(
      ModelConfigRules.composeEffective(builtin, personal).resolve(input).optionSpecs
        ?.reasoningLevel?.map,
    ).toBe('{"reasoning_effort": reasoningLevel}');
    const complex = builtin.rules().map((rule) => ({
      ...rule,
      config: rule.config.overlay(
        parseModelConfig({
          optionSpecs: { reasoningLevel: { map: '{"thinking":{"effort":reasoningLevel}}' } },
        }),
      ),
    }));
    expect(
      ModelConfigRules.composeEffective(new ModelConfigRules(complex), personal).resolve(input)
        .optionSpecs?.reasoningLevel?.map,
    ).toBe('{"thinking":{"effort":reasoningLevel}}');
    personal = personal.setDiscovered("p", "m", parseModelConfig({}), scope, {
      config: parseModelConfig({ optionSpecs: { reasoningLevel: { values: ["disabled"] } } }),
      source,
    });
    expect(
      ModelConfigRules.composeEffective(new ModelConfigRules(complex), personal).resolve(input)
        .optionSpecs?.reasoningLevel?.map,
    ).toBe("{}");
  });

  it("网关能力按连接隔离，刷新只替换自动层，个人覆盖始终优先", () => {
    const builtin = parseZCodeBuiltinModelConfigRules({
      ...emptyBuiltin,
      modelRules: [{ modelMatch: ".*", config: complete }],
    });
    const scope = { apiType: "openai-chat-completions", baseUrl: "https://gateway.example/v1" };
    let personal = ModelConfigRules.empty().setDiscovered(
      "p",
      "m",
      parseModelConfig({ properties: { contextWindow: 400_000 } }),
      scope,
    );
    const input = { providerId: "p", modelId: "m", ...scope };
    expect(
      ModelConfigRules.composeEffective(builtin, personal).resolve(input).properties?.contextWindow,
    ).toBe(400_000);
    personal = personal.setExact(
      "p",
      "m",
      parseModelConfig({ properties: { contextWindow: 64_000 } }),
    );
    personal = personal.setDiscovered(
      "p",
      "m",
      parseModelConfig({ properties: { contextWindow: 800_000 } }),
      scope,
    );
    expect(
      ModelConfigRules.composeEffective(builtin, personal).resolve(input).properties?.contextWindow,
    ).toBe(64_000);
    const automatic = personal.deleteExact("p", "m");
    expect(
      ModelConfigRules.composeEffective(builtin, automatic).resolve(input).properties
        ?.contextWindow,
    ).toBe(800_000);
    expect(
      ModelConfigRules.composeEffective(builtin, automatic).resolve({
        ...input,
        baseUrl: "https://other.example/v1",
      }).properties?.contextWindow,
    ).toBe(128_000);
    expect(
      ModelConfigRules.composeEffective(builtin, automatic).resolve({
        ...input,
        apiType: "openai-responses",
      }).properties?.contextWindow,
    ).toBe(128_000);
    const decoded = parsePersonalModelConfigRules(automatic.toPersonalJSON());
    expect(
      ModelConfigRules.composeEffective(builtin, decoded).resolve(input).properties?.contextWindow,
    ).toBe(800_000);
    expect(automatic.renameExactModel("p", "m", "renamed").getDiscovered(input)).toBeUndefined();
  });

  it("Todo90：固定配置不从推荐补缺；enabled 仍独立继承", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: new ModelConfig({
          enabled: false,

          properties: new ModelPropertiesConfig({
            requiresMfjsToolSchema: true,
            contextWindow: 100000,
          }),
        }),
      },
      {
        type: "manual-provider-model",
        providerId: "p",
        modelId: "m",
        config: new ModelConfig({
          properties: new ModelPropertiesConfig({ requiresMfjsToolSchema: false }),
        }),
      },
    ]);
    const fixed = rules.resolve({ providerId: "p", modelId: "m" });
    expect(fixed.properties?.contextWindow).toBeUndefined();
    expect(fixed.properties?.requiresMfjsToolSchema).toBe(false);
    expect(fixed.enabled).toBe(false);
    expect(fixed.validateComplete().length).toBeGreaterThan(0);
  });
  it("modelMatch 对完整 Model ID 做大小写不敏感匹配，但不隐式扩成 contains", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: "GLM-5",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    expect(rules.resolve({ providerId: "custom", modelId: "glm-5" }).enabled).toBe(false);
    expect(rules.resolve({ providerId: "custom", modelId: "glm-5-turbo" }).enabled).toBeUndefined();
    expect(
      rules.resolve({ providerId: "custom", modelId: "vendor/glm-5" }).enabled,
    ).toBeUndefined();
  });

  it("baseUrlMatch 规范化 scheme、hostname、默认端口和尾部斜杠，但保留 path 大小写", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: new ModelConfig({ enabled: true }),
      },
      {
        type: "provider-site",
        modelMatch: "model-a",
        baseUrlMatch: "https://api\\.example\\.com/v1",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        baseUrl: "HTTPS://API.EXAMPLE.COM:443/v1/",
      }).enabled,
    ).toBe(false);
    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        baseUrl: "https://api.example.com/V1/",
      }).enabled,
    ).toBe(true);
  });

  it("按 Effective Provider baseURL 应用可选的 Endpoint 特化规则", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: new ModelConfig({ enabled: true }),
      },
      {
        type: "provider-site",
        modelMatch: "model-a",
        baseUrlMatch: "https://api\\.example\\.com/v1",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        apiType: "openai-responses",
        baseUrl: "https://api.example.com/v1",
      }).enabled,
    ).toBe(false);
    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        apiType: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
      }).enabled,
    ).toBe(true);
  });

  it("严格解析并原样序列化 baseUrlMatch", () => {
    const source = {
      ...emptyBuiltin,
      providerSiteRules: [
        {
          modelMatch: "model-a",
          apiTypeMatch: "openai-responses",
          baseUrlMatch: "https://api\\\\.example\\\\.com/v1",
          config: { enabled: true },
        },
      ],
    };
    const rules = parseZCodeBuiltinModelConfigRules(source);
    expect(rules.toZCodeBuiltinJSON()).toEqual(source);
  });

  it("Personal 手动配置通过所属集合表达模式，往返不混回智能组", () => {
    const source = {
      providerModelRules: [],
      manualProviderModelRules: [
        {
          providerId: "provider-a",
          modelId: "model-a",
          config: extractManualModelConfig(complete),
        },
      ],
    };
    const rules = parsePersonalModelConfigRules(source);
    expect(rules.toPersonalJSON()).toEqual(source);
    expect(rules.getExactRule("provider-a", "model-a")?.type).toBe("manual-provider-model");
  });

  it("替换精确 Personal Rule 时保留显式推荐模式", () => {
    const rules = ModelConfigRules.empty().setExact(
      "provider-a",
      "model-a",
      parseModelConfig(extractManualModelConfig({ ...complete, enabled: true })),
      false,
    );

    const replaced = rules.setExact(
      "provider-a",
      "model-a",
      parseModelConfig(extractManualModelConfig({ ...complete, enabled: false })),
      false,
    );

    expect(replaced.getExactRule("provider-a", "model-a")).toEqual({
      type: "manual-provider-model",
      providerId: "provider-a",
      modelId: "model-a",
      config: parseModelConfig(extractManualModelConfig({ ...complete, enabled: false })),
    });
  });

  it("provider-model 使用结构化精确身份并按来源层合成", () => {
    const builtin = parseZCodeBuiltinModelConfigRules({
      ...emptyBuiltin,
      modelRules: [{ modelMatch: "model-a", config: { enabled: false } }],
    });
    const personal = parsePersonalModelConfigRules({
      providerModelRules: [
        { providerId: "provider-a", modelId: "model-a", config: { enabled: true } },
      ],
      manualProviderModelRules: [],
    });
    const rules = ModelConfigRules.composeEffective(builtin, personal);
    expect(rules.resolve({ providerId: "provider-a", modelId: "model-a" }).enabled).toBe(true);
    expect(rules.resolve({ providerId: "provider-b", modelId: "model-a" }).enabled).toBe(false);
    expect(rules.resolve({ providerId: "provider-a", modelId: "MODEL-A" }).enabled).toBe(false);
    expect(rules.rules().map((rule) => rule.type)).toEqual(["model", "provider-model"]);
  });

  it("Effective 组合只允许 Built-in 与 Personal 精确覆盖", () => {
    const builtin = new ModelConfigRules([
      { type: "model", modelMatch: ".*", config: new ModelConfig({ enabled: true }) },
    ]);
    const personal = new ModelConfigRules([
      {
        type: "provider-model",
        providerId: "provider-a",
        modelId: "model-a",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    const effective = ModelConfigRules.composeEffective(builtin, personal);

    expect(effective.resolve({ providerId: "provider-a", modelId: "model-a" }).enabled).toBe(false);
    expect(effective.rules().map((rule) => rule.type)).toEqual(["model", "provider-model"]);
    expect(personal.rules().map((rule) => rule.type)).toEqual(["provider-model"]);
  });

  it("专属生命周期操作只修改精确规则，不猜测外观精确的匹配规则", () => {
    const match = {
      type: "model" as const,
      modelMatch: "model-a",
      config: new ModelConfig({ enabled: false }),
    };
    const rules = new ModelConfigRules([match]).setExact(
      "provider-a",
      "model-a",
      new ModelConfig({ enabled: true }),
    );
    const renamed = rules.renameExactModel("provider-a", "model-a", "model-b");
    expect(renamed.rules()[0]).toEqual(match);
    expect(renamed.getExact("provider-a", "model-a")).toBeUndefined();
    expect(renamed.getExact("provider-a", "model-b")?.enabled).toBe(true);
    expect(renamed.deleteExact("provider-a", "model-b").rules()).toEqual([match]);
  });

  it("持久化不接受 type 或混合两种 Rule 字段", () => {
    expect(() =>
      parseZCodeBuiltinModelConfigRules({
        ...emptyBuiltin,
        modelRules: [{ type: "model", modelMatch: "model-a", config: { enabled: true } }],
      }),
    ).toThrow();
    expect(() =>
      parsePersonalModelConfigRules({
        providerModelRules: [
          {
            providerId: "provider-a",
            modelId: "model-a",
            modelMatch: "model-a",
            config: { enabled: true },
          },
        ],
        manualProviderModelRules: [],
      }),
    ).toThrow();
  });
});

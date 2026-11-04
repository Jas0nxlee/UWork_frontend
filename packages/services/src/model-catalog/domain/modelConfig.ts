import type { ModelConfigObject } from "@zcode/provider";

export interface CatalogMetadata {
  readonly limit?: { readonly context?: number; readonly output?: number };
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
  readonly reasoning?: boolean;
  readonly reasoning_options?: readonly {
    readonly type: "effort";
    readonly values: readonly string[];
  }[];
  readonly tool_call?: boolean;
  readonly structured_output?: boolean;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const boolean = (value: unknown): boolean | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error("Invalid catalog capability");
  return value;
};
const tokens = (value: unknown): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid catalog token limit");
  return value;
};
const modalities = (value: unknown): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > 128))
    throw new Error("Invalid catalog modalities");
  return [...new Set(value as string[])];
};

/** 仅留公开目录的能力白名单；价格、描述、SDK、环境变量和远端请求模板不进入缓存。 */
export function sanitizeMetadata(value: unknown): CatalogMetadata {
  const data = record(value);
  if (!data) throw new Error("Invalid catalog model");
  const limit = record(data.limit);
  const modes = record(data.modalities);
  if ((data.limit !== undefined && !limit) || (data.modalities !== undefined && !modes))
    throw new Error("Invalid catalog model metadata");
  const context = tokens(limit?.context),
    output = tokens(limit?.output);
  const inputModes = modalities(modes?.input),
    outputModes = modalities(modes?.output);
  const reasoning = boolean(data.reasoning),
    toolCall = boolean(data.tool_call),
    structured = boolean(data.structured_output);
  let efforts: string[] = [];
  if (data.reasoning_options !== undefined) {
    if (!Array.isArray(data.reasoning_options))
      throw new Error("Invalid catalog reasoning options");
    for (const option of data.reasoning_options) {
      const item = record(option);
      if (item?.type !== "effort") continue;
      if (!Array.isArray(item.values) || item.values.some((level) => typeof level !== "string"))
        throw new Error("Invalid catalog reasoning efforts");
      efforts.push(...item.values.filter((level) => effortOrder.includes(level)));
    }
  }
  efforts = effortOrder.filter((level) => efforts.includes(level));
  return {
    ...(context !== undefined || output !== undefined
      ? {
          limit: {
            ...(context !== undefined ? { context } : {}),
            ...(output !== undefined ? { output } : {}),
          },
        }
      : {}),
    ...(inputModes !== undefined || outputModes !== undefined
      ? {
          modalities: {
            ...(inputModes ? { input: inputModes } : {}),
            ...(outputModes ? { output: outputModes } : {}),
          },
        }
      : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(efforts.length ? { reasoning_options: [{ type: "effort", values: efforts }] } : {}),
    ...(toolCall === undefined ? {} : { tool_call: toolCall }),
    ...(structured === undefined ? {} : { structured_output: structured }),
  };
}

function modalityKind(value: string): string | undefined {
  if (value === "pdf" || value === "application/pdf") return "pdf";
  return ["text", "image", "audio", "video"].find(
    (kind) => value === kind || value.startsWith(`${kind}/`),
  );
}

/** 预算和 toggle 没有通用离散档位；这里只写明确 effort，实际请求 map 仍由 Provider 拥有。 */
export function catalogModelConfig(model: CatalogMetadata): ModelConfigObject {
  const properties: NonNullable<ModelConfigObject["properties"]> = {};
  const optionSpecs: NonNullable<ModelConfigObject["optionSpecs"]> = {};
  if (model.limit?.context) properties.contextWindow = model.limit.context;
  if (model.limit?.output) optionSpecs.maxOutputTokens = { max: model.limit.output };
  if (model.modalities?.input) {
    const kinds = model.modalities.input.map(modalityKind);
    const supported = (kind: string) =>
      kinds.includes(kind) ? true : kinds.includes(undefined) ? undefined : false;
    const input: Record<string, boolean> = {};
    for (const [kind, key] of [
      ["text", "supportsText"],
      ["image", "supportsImage"],
      ["audio", "supportsAudio"],
      ["video", "supportsVideo"],
      ["pdf", "supportsPdf"],
    ]) {
      const enabled = supported(kind!);
      if (enabled !== undefined) input[key!] = enabled;
    }
    if (Object.keys(input).length) properties.inputFormat = input;
  }
  if (model.modalities?.output) {
    const kinds = model.modalities.output.map(modalityKind);
    if (kinds.includes("text") || !kinds.includes(undefined))
      properties.outputFormat = { supportsText: kinds.includes("text") };
  }
  if (
    model.limit?.context === 0 &&
    (properties.inputFormat?.supportsText === false ||
      properties.outputFormat?.supportsText === false)
  )
    properties.contextWindow = null;
  if (model.tool_call !== undefined) properties.supportsToolCall = model.tool_call;
  if (model.structured_output !== undefined)
    properties.supportsJsonSchemaOutput = model.structured_output;
  if (model.reasoning === false) optionSpecs.reasoningLevel = { values: ["disabled"], map: "{}" };
  else {
    const values = model.reasoning_options?.flatMap((option) => option.values) ?? [];
    if (values.length) optionSpecs.reasoningLevel = { values };
  }
  return {
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(Object.keys(optionSpecs).length ? { optionSpecs } : {}),
  };
}

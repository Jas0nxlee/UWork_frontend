// ============================================================
// Zod -> provider-neutral JSON Schema for tool contracts
// ============================================================

import { z } from "zod";
import type { JsonSchema } from "../model/index.js";

const STRIPPED_SCHEMA_KEYS = new Set(["$schema", "$id", "$ref", "$defs", "definitions"]);
export const TOOL_JSON_SCHEMA_VERSION = "https://json-schema.org/draft/2020-12/schema";

/**
 * Convert a Zod runtime schema into the JSON Schema subset exposed to model
 * providers. Keep all built-in tool schemas on this path so runtime validation
 * and provider-facing function parameters cannot drift.
 */
export function toToolJsonSchema(schema: z.ZodType): JsonSchema {
  // 原因：旧转换器不认识真实 Zod 4，会把工具参数静默投影成 {}；原生转换保留输入约束。
  const jsonSchema = z.toJSONSchema(schema, {
    io: "input",
    target: "draft-07",
    reused: "inline",
    // 正规化会去掉 provider 不支持的 $ref；先拒绝循环，避免引用约束被无声删除。
    cycles: "throw",
    override: ({ zodSchema, jsonSchema: node }) => {
      // Zod 3 转换器对 strip 对象声明 additionalProperties=false；迁移保留模型合同，
      // 运行时仍按原 schema 剥离未知字段，不把 ToolSearch 的 strip 改成 strict。
      if (zodSchema instanceof z.ZodObject && zodSchema.def.catchall === undefined) {
        node.additionalProperties = false;
      }
    },
  }) as JsonSchema;

  normalizeToolJsonSchema(jsonSchema);
  jsonSchema.$schema = TOOL_JSON_SCHEMA_VERSION;
  return jsonSchema;
}

export function normalizeToolJsonSchema(schema: JsonSchema): JsonSchema {
  normalizeSchemaNode(schema);
  return schema;
}

function normalizeSchemaNode(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeSchemaNode(item);
    }
    return;
  }

  if (!isRecord(value)) return;

  for (const key of STRIPPED_SCHEMA_KEYS) {
    delete value[key];
  }

  if (isRecord(value.properties)) {
    for (const child of Object.values(value.properties)) {
      normalizeSchemaNode(child);
    }
  }

  normalizeSchemaNode(value.items);
  normalizeSchemaNode(value.additionalProperties);
  normalizeSchemaNode(value.oneOf);
  normalizeSchemaNode(value.anyOf);
  normalizeSchemaNode(value.allOf);

  if (Array.isArray(value.anyOf) && value.oneOf === undefined) {
    value.oneOf = value.anyOf;
    delete value.anyOf;
  }

  if (value.type === undefined) {
    const inferredType = inferSchemaType(value);
    if (inferredType) {
      value.type = inferredType;
    }
  }

  const typeValues = Array.isArray(value.type) ? value.type : [value.type];
  if (
    typeValues.includes("object") &&
    !isRecord(value.properties) &&
    isRecord(value.additionalProperties) &&
    value.propertyNames === undefined
  ) {
    value.propertyNames = { type: "string" };
  }
  if (
    typeValues.includes("object") &&
    !isRecord(value.properties) &&
    value.additionalProperties === undefined
  ) {
    value.properties = {};
  }
  if (typeValues.includes("array") && value.items === undefined) {
    value.items = {};
  }
}

function inferSchemaType(schema: Record<string, unknown>): string | undefined {
  if (isRecord(schema.properties) || Array.isArray(schema.required)) {
    return "object";
  }
  if (
    schema.items !== undefined ||
    typeof schema.minItems === "number" ||
    typeof schema.maxItems === "number"
  ) {
    return "array";
  }
  if (Array.isArray(schema.enum)) {
    return inferTypeFromValues(schema.enum);
  }
  if ("const" in schema) {
    return inferTypeFromValues([schema.const]);
  }
  if (typeof schema.minLength === "number" || typeof schema.maxLength === "number") {
    return "string";
  }
  if (typeof schema.minimum === "number" || typeof schema.maximum === "number") {
    return "number";
  }
  return undefined;
}

function inferTypeFromValues(values: unknown[]): string | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value) => typeof value === "string")) return "string";
  if (values.every((value) => typeof value === "boolean")) return "boolean";
  if (values.every((value) => Number.isInteger(value))) return "integer";
  if (values.every((value) => typeof value === "number")) return "number";
  if (values.every((value) => value === null)) return "null";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

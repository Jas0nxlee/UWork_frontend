import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toToolJsonSchema, TOOL_JSON_SCHEMA_VERSION } from "../src/tools/json-schema.js";

describe("tool JSON Schema conversion", () => {
  it("keeps input constraints and defaults through preprocess and transform", () => {
    const schema = z
      .object({
        count: z.preprocess((value) => value, z.number().min(1).max(9).default(3)),
        label: z
          .string()
          .min(2)
          .transform((value) => value.trim()),
      })
      .strict();

    expect(toToolJsonSchema(schema)).toEqual({
      $schema: TOOL_JSON_SCHEMA_VERSION,
      type: "object",
      properties: {
        count: { type: "number", minimum: 1, maximum: 9, default: 3 },
        label: { type: "string", minLength: 2 },
      },
      required: ["label"],
      additionalProperties: false,
    });
  });

  it("keeps nested record value constraints and string keys", () => {
    const schema = z.record(z.string(), z.record(z.string(), z.number().min(0)));
    expect(toToolJsonSchema(schema)).toEqual({
      $schema: TOOL_JSON_SCHEMA_VERSION,
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: { type: "number", minimum: 0 },
        propertyNames: { type: "string" },
      },
      propertyNames: { type: "string" },
    });
  });

  it("inlines repeated schemas without erasing either validation branch", () => {
    const item = z.object({ id: z.string().min(1) }).strict();
    const converted = toToolJsonSchema(z.object({ left: item, right: item }).strict());
    const properties = converted.properties as Record<string, unknown>;
    expect(properties.left).toEqual(properties.right);
    expect(properties.left).toMatchObject({
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    });
    expect(JSON.stringify(converted)).not.toMatch(/"\$(?:ref|defs)"/);
  });

  it("rejects recursive types instead of removing their reference constraint", () => {
    const recursive: z.ZodType = z.lazy(() => z.object({ child: recursive.optional() }));
    expect(() => toToolJsonSchema(recursive)).toThrow();
  });

  it.each([z.bigint(), z.date(), z.custom()])(
    "rejects non-JSON types instead of publishing an unconstrained schema",
    (schema) => {
      expect(() => toToolJsonSchema(schema)).toThrow();
    },
  );
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toToolJsonSchema } from "../json-schema.js";
import type { ToolJsonSchemaConverter } from "./contract.js";

describe("tool-json-schema contract", () => {
  it("publishes the runtime required value and unknown-field boundary", () => {
    const input = z.object({ query: z.string().min(1) }).strict();
    const convert: ToolJsonSchemaConverter = toToolJsonSchema;
    expect(convert(input)).toMatchObject({
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    });
    expect(input.safeParse({ query: "" }).success).toBe(false);
    expect(input.safeParse({ query: "valid", extra: true }).success).toBe(false);
  });
});

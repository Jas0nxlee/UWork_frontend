import { z } from "zod";
import type { ToolJsonSchemaConverter } from "./contract.js";

/** 相同 runtime schema 发布参数；转换器不执行工具或维护额外状态。 */
export function exampleToolJsonSchema(convert: ToolJsonSchemaConverter) {
  return convert(z.object({ query: z.string().min(1) }).strict());
}

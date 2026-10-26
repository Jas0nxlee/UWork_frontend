import type { z } from "zod";
import type { JsonSchema } from "../../model/index.js";

/** 纯转换实际输入校验为 provider schema；保留约束与默认值，不可表示或循环类型抛错。 */
export type ToolJsonSchemaConverter = (schema: z.ZodType) => JsonSchema;

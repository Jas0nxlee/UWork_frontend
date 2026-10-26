/**
 * tool-json-schema 模块清单（architecture-governance managed 模块）。
 * 层：domain。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const toolJsonSchemaModule = {
  id: "tool-json-schema",
  requires: ["zcode-cli"],
  provides: ["tool-json-schema"],
  publicEntrypoints: [
    "contract.ts",
    "../json-schema.ts",
    "../deferred-tool-call.ts",
    "../tool-search.ts",
  ],
} as const;

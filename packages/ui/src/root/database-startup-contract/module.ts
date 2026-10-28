/**
 * ui-database-startup 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const uiDatabaseStartupModule = {
  id: "ui-database-startup",
  requires: ["ui", "shared"],
  provides: ["ui-database-startup"],
  publicEntrypoints: ["index.ts", "contract.ts", "../GlobalDatabaseStartupLoading.tsx"],
} as const;

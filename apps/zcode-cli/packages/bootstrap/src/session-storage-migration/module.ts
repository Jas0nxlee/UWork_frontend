/**
 * cli-session-storage-migration 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliSessionStorageMigrationModule = {
  id: "cli-session-storage-migration",
  requires: ["zcode-cli", "shared"],
  provides: ["cli-session-storage-migration"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;

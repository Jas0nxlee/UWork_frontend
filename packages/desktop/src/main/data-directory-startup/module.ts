/**
 * data-directory-startup 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const dataDirectoryStartupModule = {
  id: "data-directory-startup",
  requires: ["shared", "desktop", "project-storage", "host-database-startup", "plugin-sandbox"],
  provides: ["data-directory-startup"],
  publicEntrypoints: ["index.ts", "contract.ts", "preready.ts", "bootstrap.ts", "worker.ts"],
} as const;

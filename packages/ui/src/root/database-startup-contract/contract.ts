import type { DatabaseStartupState } from "@zcode/shared";
/** 展示既有启动 owner 的投影，不在 UI 复制迁移状态或提交设置。 */
export interface GlobalDatabaseStartupProps {
  state: DatabaseStartupState | null;
  onRetry: () => void;
  onCopy: (details: string) => Promise<void>;
  onExit: () => void;
  onCancel?: () => void;
}

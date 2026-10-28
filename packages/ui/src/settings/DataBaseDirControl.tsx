import { FolderOpen, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  isDataBaseDirForbiddenWindowsInstallDirError,
  type PendingDataDirectoryMigration,
} from "@zcode/shared";
import {
  TID_SETTINGS_DATA_BASE_DIR_BROWSE,
  TID_SETTINGS_DATA_BASE_DIR_INPUT,
  TID_SETTINGS_DATA_BASE_DIR_SAVE,
  TID_SETTINGS_DATA_BASE_DIR_STATUS,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DataBaseDirControl({
  dataBaseDir,
  pendingMigration,
  infoUnavailable = false,
  defaultHomeDir,
  onDataBaseDirChange,
  onSelectDataBaseDir,
}: {
  dataBaseDir: string;
  pendingMigration?: PendingDataDirectoryMigration;
  infoUnavailable?: boolean;
  defaultHomeDir: string;
  onDataBaseDirChange: (dir: string) => Promise<void>;
  onSelectDataBaseDir: () => Promise<string | null>;
}) {
  const { intl } = useZCodeIntl();
  const activeDir = pendingMigration?.sourceBaseDir || dataBaseDir || defaultHomeDir;
  const effectiveDir = pendingMigration?.targetBaseDir || activeDir;
  const [localDataBaseDir, setLocalDataBaseDir] = useState(effectiveDir);
  const [isPickingDataBaseDir, setIsPickingDataBaseDir] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMessageId, setErrorMessageId] = useState("settings.dataBaseDirCopyFailed");

  const ownerGeneration = useRef(0);
  useEffect(() => {
    // 其他窗口可保存或取消同一请求；已保存的局部状态不能遮住 owner 的新投影。
    ownerGeneration.current += 1;
    setLocalDataBaseDir(effectiveDir);
    setSaveState("idle");
  }, [effectiveDir]);

  const isDirty = localDataBaseDir.trim() !== effectiveDir;
  const isSaving = saveState === "saving";

  const handleBrowseDataBaseDir = useCallback(async () => {
    setIsPickingDataBaseDir(true);
    try {
      const selectedDir = await onSelectDataBaseDir();
      if (!selectedDir) {
        return;
      }

      // 之前这里允许手输任意字符串，用户填错路径后仍会触发整份数据复制。
      // 只接受系统目录弹窗返回的真实文件夹路径；“保存”仅记录下次启动执行的请求，
      // 避免把“浏览目录”和“执行数据迁移”这两个风险不同的动作混在一起。
      setLocalDataBaseDir(selectedDir);
      if (saveState !== "idle") {
        setSaveState("idle");
      }
    } finally {
      setIsPickingDataBaseDir(false);
    }
  }, [onSelectDataBaseDir, saveState]);

  const handleSave = useCallback(async () => {
    const trimmed = localDataBaseDir.trim();
    const newValue = trimmed === defaultHomeDir ? "" : trimmed;
    const submittedGeneration = ownerGeneration.current;
    setSaveState("saving");
    try {
      await onDataBaseDirChange(newValue);
      if (submittedGeneration !== ownerGeneration.current) return;
      setSaveState("saved");
    } catch (error) {
      // 旧提交的晚到结果不能覆盖随后收到的跨窗口设置事实。
      if (submittedGeneration !== ownerGeneration.current) return;
      setErrorMessageId(
        isDataBaseDirForbiddenWindowsInstallDirError(error)
          ? "settings.dataBaseDirForbiddenInstallDir"
          : "settings.dataBaseDirCopyFailed",
      );
      setSaveState("error");
    }
  }, [defaultHomeDir, localDataBaseDir, onDataBaseDirChange]);

  return (
    <div className="flex w-[320px] min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
        <Input
          size="lg"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_INPUT}
          value={localDataBaseDir}
          readOnly
          disabled={isSaving || isPickingDataBaseDir}
          placeholder={intl.formatMessage({ id: "settings.dataBaseDirPlaceholder" })}
          className="flex-1 font-mono"
        />
      </div>
      {infoUnavailable ? (
        <p role="alert" className="text-ui-caption text-destructive">
          {intl.formatMessage({ id: "settings.dataBaseDirInfoUnavailable" })}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_BROWSE}
          disabled={isSaving || isPickingDataBaseDir}
          onClick={() => void handleBrowseDataBaseDir()}
        >
          {intl.formatMessage({ id: "settings.dataBaseDirBrowse" })}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_SAVE}
          disabled={!isDirty || isSaving || isPickingDataBaseDir}
          onClick={() => void handleSave()}
        >
          {isSaving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            intl.formatMessage({ id: "settings.dataBaseDirSave" })
          )}
        </Button>
      </div>
      {saveState === "saving" ? (
        <p
          data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
          data-state="saving"
          className="text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "settings.dataBaseDirCopying" })}
        </p>
      ) : saveState === "error" ? (
        <p
          data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
          data-state="error"
          className="text-ui-base text-destructive"
        >
          {intl.formatMessage({ id: errorMessageId })}
        </p>
      ) : pendingMigration ? (
        <p
          data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
          data-state="saved"
          className="text-ui-base text-amber-600 dark:text-amber-400"
        >
          {intl.formatMessage({ id: "settings.dataBaseDirRestartRequired" })}
          <span className="mt-1 block break-all text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.dataBaseDirPendingTarget" },
              { active: activeDir, target: pendingMigration.targetBaseDir },
            )}
          </span>
        </p>
      ) : saveState === "saved" ? (
        <p
          data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
          data-state="saved"
          className="text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "settings.dataBaseDirMigrationCancelled" })}
        </p>
      ) : null}
    </div>
  );
}

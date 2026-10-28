import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  appSettingsSchema,
  pendingDataDirectoryMigrationSchema,
  UWORK_DATA_ROOT_DIR_NAME,
  type AppSettings,
  type PendingDataDirectoryMigration,
} from "@zcode/shared";
import type { ISettingService } from "#src/setting/setting.js";
import { getDataBaseDir, validateDataBaseDirTarget } from "#src/paths.js";
import { atomicWriteText, withAtomicFileLock } from "#src/fs/atomicFileUtils.js";

function resolveUserHomeDir() {
  // 独立桌面 Dev 实例已设置自己的 home，设置服务却仍写真实 HOME，
  // 导致启动迁移和外观操作污染其他实例。与 Electron 的显式 home 覆盖保持一致。
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export function dataDirectoryMigrationControlPaths(homeDir?: string) {
  const home = homeDir || resolveUserHomeDir();
  return {
    settingsFile: join(home, UWORK_DATA_ROOT_DIR_NAME, "v2", "setting.json"),
    operationDirectory: join(home, ".uwork-data-directory-migration"),
    requestLockPath: join(home, ".uwork-data-directory-migration-request"),
  };
}

export function assertPendingMigrationValid(raw: unknown, fullSchemaFailed = false): void {
  if (raw && typeof raw === "object" && Object.hasOwn(raw, "pendingDataDirectoryMigration")) {
    const pending = (raw as Record<string, unknown>).pendingDataDirectoryMigration;
    if (
      fullSchemaFailed ||
      (pending !== undefined && !pendingDataDirectoryMigrationSchema.safeParse(pending).success)
    )
      throw Object.assign(new Error("Invalid pending data directory migration"), {
        kind: "corrupt",
      });
  }
}

/** 活动根与待执行请求只有冷迁移 owner 可提交，普通偏好 patch 不得绕过停写门禁。 */
export function assertDataDirectorySettingsPatch(patch: Partial<AppSettings>): void {
  if (Object.hasOwn(patch, "dataBaseDir") || Object.hasOwn(patch, "pendingDataDirectoryMigration"))
    throw new Error("Data directory settings require the cold migration owner");
}

type WriteOperation = (shouldCommit: () => boolean, enterCommitPhase: () => void) => Promise<void>;
export interface DataDirectorySettingOwnerPort {
  settingsFile: string;
  defaultBaseDir: string;
  requestLockPath: string;
  enqueueSettingsWrite: (operation: WriteOperation) => Promise<void>;
  readSettings: () => Promise<AppSettings>;
  writeSettings: (
    settings: AppSettings,
    shouldCommit: () => boolean,
    enterCommitPhase: () => void,
  ) => Promise<void>;
}
/** 所有提交仍通过同一 Setting owner 队列/文件锁；helper 不创建第二个设置实例或写队列。 */
export function createDataDirectorySettingOwner(port: DataDirectorySettingOwnerPort): Pick<
  ISettingService,
  "getDataDirectoryInfo" | "updateDataBaseDir"
> & {
  commitPendingDataDirectoryMigration: (request: PendingDataDirectoryMigration) => Promise<void>;
  cancelPendingDataDirectoryMigration: (
    request: PendingDataDirectoryMigration,
    originalSettings?: string,
  ) => Promise<void>;
} {
  const {
    settingsFile,
    defaultBaseDir,
    requestLockPath,
    enqueueSettingsWrite,
    readSettings,
    writeSettings,
  } = port;
  return {
    async getDataDirectoryInfo() {
      return { activeBaseDir: resolve(getDataBaseDir()), defaultBaseDir: defaultBaseDir };
    },
    async updateDataBaseDir(newDir: string | undefined): Promise<void> {
      const currentBaseDir = resolve(getDataBaseDir());
      const requested = newDir?.trim();
      const targetBaseDir = resolve(requested || defaultBaseDir);
      if (requested && !isAbsolute(requested)) throw new Error("Data directory must be absolute");
      const validation = validateDataBaseDirTarget(targetBaseDir);
      if (!validation.ok) {
        // Windows 安装目录由安装器/自动更新管理，把 .zcode/v2 放进去可能在升级时被覆盖。
        // 迁移前在 service 层拦截，避免 UI 入口变化或 RPC 调用绕过前端判断。
        const error = new Error(`${validation.code}: ${validation.forbiddenDir}`);
        (error as Error & { code: string }).code = validation.code;
        throw error;
      }

      const sourceRoot = join(currentBaseDir, UWORK_DATA_ROOT_DIR_NAME);
      const targetRoot = join(targetBaseDir, UWORK_DATA_ROOT_DIR_NAME);
      const contains = (parent: string, child: string) => {
        const path = relative(parent, child);
        return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
      };
      if (
        currentBaseDir !== targetBaseDir &&
        (contains(sourceRoot, targetRoot) || contains(targetRoot, sourceRoot))
      )
        throw new Error("UWork data directories must not overlap");
      // 运行中的 Host/Agent 继续使用旧根；请求锁与启动 Worker 共用，不能在复制中途改请求。
      await withAtomicFileLock(requestLockPath, () =>
        enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
          const current = await readSettings();
          const previous = current.pendingDataDirectoryMigration;
          if (currentBaseDir === targetBaseDir) {
            if (previous)
              await writeSettings(
                { ...current, pendingDataDirectoryMigration: undefined },
                shouldCommit,
                enterCommitPhase,
              );
            return;
          }
          if (
            previous?.sourceBaseDir === currentBaseDir &&
            previous.targetBaseDir === targetBaseDir &&
            previous.resetToDefault === !requested
          )
            return;
          await writeSettings(
            {
              ...current,
              pendingDataDirectoryMigration: {
                requestId: randomUUID(),
                sourceBaseDir: currentBaseDir,
                targetBaseDir,
                resetToDefault: !requested,
              },
            },
            shouldCommit,
            enterCommitPhase,
          );
        }),
      );
    },
    async commitPendingDataDirectoryMigration(request) {
      await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
        const current = await readSettings();
        const pending = current.pendingDataDirectoryMigration;
        const currentBase = resolve(current.dataBaseDir || defaultBaseDir);
        if (!pending && currentBase === resolve(request.targetBaseDir)) return;
        if (
          !pending ||
          pending.requestId !== request.requestId ||
          pending.sourceBaseDir !== request.sourceBaseDir ||
          pending.targetBaseDir !== request.targetBaseDir ||
          pending.resetToDefault !== request.resetToDefault ||
          currentBase !== resolve(request.sourceBaseDir)
        )
          throw new Error("Data directory migration request changed before commit");
        await writeSettings(
          {
            ...current,
            dataBaseDir: request.resetToDefault ? undefined : request.targetBaseDir,
            pendingDataDirectoryMigration: undefined,
          },
          shouldCommit,
          enterCommitPhase,
        );
      });
    },
    async cancelPendingDataDirectoryMigration(request, originalSettings) {
      await enqueueSettingsWrite(async (shouldCommit, enterCommitPhase) => {
        const existing = await readFile(settingsFile, "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        );
        if (existing === undefined) {
          if (originalSettings === undefined) throw new Error("Missing bootstrap recovery input");
          const restored = appSettingsSchema.parse(JSON.parse(originalSettings));
          const pending = restored.pendingDataDirectoryMigration;
          if (
            !pending ||
            pending.requestId !== request.requestId ||
            pending.sourceBaseDir !== request.sourceBaseDir ||
            pending.targetBaseDir !== request.targetBaseDir ||
            pending.resetToDefault !== request.resetToDefault
          )
            throw new Error("Bootstrap recovery request mismatch");
          // 只恢复已校验的缺席 owner 原文；所有正常设置写者共用此文件锁。
          await atomicWriteText(settingsFile, originalSettings, {
            useFileLock: false,
            beforeRename: () => {
              if (!shouldCommit()) throw new Error("Stale bootstrap recovery");
              enterCommitPhase();
            },
          });
        }
        const current = await readSettings();
        const pending = current.pendingDataDirectoryMigration;
        const active = resolve(current.dataBaseDir || defaultBaseDir);
        if (!pending && active === resolve(request.sourceBaseDir)) return;
        if (
          !pending ||
          pending.requestId !== request.requestId ||
          pending.sourceBaseDir !== request.sourceBaseDir ||
          pending.targetBaseDir !== request.targetBaseDir ||
          pending.resetToDefault !== request.resetToDefault ||
          active !== resolve(request.sourceBaseDir)
        )
          throw new Error("Data directory migration cannot be cancelled after commit or conflict");
        await writeSettings(
          { ...current, pendingDataDirectoryMigration: undefined },
          shouldCommit,
          enterCommitPhase,
        );
      });
    },
  };
}

/** 仅供已持冷启动请求锁的存储 Worker 使用；不进入 Setting RPC。 */
export type DataDirectoryMigrationCommitOwner = Pick<
  ReturnType<typeof createDataDirectorySettingOwner>,
  "commitPendingDataDirectoryMigration" | "cancelPendingDataDirectoryMigration"
>;

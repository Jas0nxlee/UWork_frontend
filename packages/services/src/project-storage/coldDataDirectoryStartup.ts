import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  appSettingsSchema,
  pendingDataDirectoryMigrationSchema,
  type AppSettings,
  type PendingDataDirectoryMigration,
} from "@zcode/shared";
import { copyDataDirectory, listDataDirectorySqliteFiles } from "#src/dataDirectoryMigration.js";
import { getDefaultDataBaseDir } from "#src/paths.js";
import { withAtomicFileLock } from "#src/fs/atomicFileUtils.js";
import {
  createSettingServiceWithMigrations,
  dataDirectoryMigrationControlPaths,
} from "#src/setting/settingService.js";

const operationSchema = z
  .object({
    schemaVersion: z.literal(1),
    request: pendingDataDirectoryMigrationSchema,
    originalSettings: z.string(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const corrupt = () =>
  Object.assign(new Error("Invalid cold data directory recovery state"), { kind: "corrupt" });
async function readMetadata(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) {
    let parent = dirname(resolve(path));
    for (;;) {
      const ancestor = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (ancestor) {
        if (ancestor.isSymbolicLink()) {
          try {
            await realpath(parent);
          } catch {
            throw corrupt();
          }
        }
        return undefined;
      }
      const next = dirname(parent);
      if (next === parent) throw corrupt();
      parent = next;
    }
  }
  if (!info.isFile() || info.isSymbolicLink()) throw corrupt();
  return readFile(path, "utf8");
}
async function assertOperationDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw corrupt();
}
function parseSettings(raw: string): AppSettings {
  try {
    return appSettingsSchema.parse(JSON.parse(raw));
  } catch {
    throw corrupt();
  }
}
function sameRequest(
  left: PendingDataDirectoryMigration,
  right: PendingDataDirectoryMigration,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.sourceBaseDir === right.sourceBaseDir &&
    left.targetBaseDir === right.targetBaseDir &&
    left.resetToDefault === right.resetToDefault
  );
}
async function durableOperation(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  if (process.platform !== "win32") {
    const parent = await open(dirname(dirname(path)), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  if (process.platform !== "win32") {
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
async function clearOperation(path: string): Promise<void> {
  await rm(path, { force: true });
  if (process.platform !== "win32") {
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

async function readControlState(
  paths: ReturnType<typeof dataDirectoryMigrationControlPaths>,
  defaultBaseDir: string,
) {
  await assertOperationDirectory(paths.operationDirectory);
  const rawOperation = await readMetadata(join(paths.operationDirectory, "operation.json"));
  let operation: z.infer<typeof operationSchema> | undefined;
  if (rawOperation !== undefined) {
    try {
      operation = operationSchema.parse(JSON.parse(rawOperation));
    } catch {
      throw corrupt();
    }
    const original = parseSettings(operation.originalSettings).pendingDataDirectoryMigration;
    if (
      hash(operation.originalSettings) !== operation.checksum ||
      !original ||
      !sameRequest(original, operation.request)
    )
      throw corrupt();
  }
  const rawSettings = await readMetadata(paths.settingsFile);
  const settings = rawSettings === undefined ? undefined : parseSettings(rawSettings);
  const request = operation?.request ?? settings?.pendingDataDirectoryMigration;
  if (!request) return { operation, rawSettings, request, disposition: "none" as const };
  if (
    !isAbsolute(request.sourceBaseDir) ||
    !isAbsolute(request.targetBaseDir) ||
    resolve(request.sourceBaseDir) === resolve(request.targetBaseDir)
  )
    throw corrupt();
  const current = settings ?? (operation ? parseSettings(operation.originalSettings) : undefined);
  if (!current) throw corrupt();
  const active = resolve(current.dataBaseDir || defaultBaseDir);
  if (current.pendingDataDirectoryMigration) {
    if (
      !sameRequest(current.pendingDataDirectoryMigration, request) ||
      active !== resolve(request.sourceBaseDir)
    )
      throw corrupt();
    return { operation, rawSettings, request, disposition: "pending" as const };
  }
  if (operation && active === resolve(request.targetBaseDir))
    return { operation, rawSettings, request, disposition: "committed" as const };
  if (operation && active === resolve(request.sourceBaseDir))
    return { operation, rawSettings, request, disposition: "cancelled" as const };
  throw corrupt();
}

/** 仅是失败 UI 的校验投影；不修改请求或以缓存代替设置 owner。 */
export async function canCancelPendingDataDirectoryMigration(
  options: { defaultDataBaseDir?: string } = {},
): Promise<boolean> {
  const paths = dataDirectoryMigrationControlPaths();
  try {
    return await withAtomicFileLock(paths.requestLockPath, async () => {
      const state = await readControlState(
        paths,
        resolve(options.defaultDataBaseDir || getDefaultDataBaseDir()),
      );
      return state.disposition === "pending" || state.disposition === "cancelled";
    });
  } catch {
    return false;
  }
}

/** 前一存储 Worker 已退出后调用；保留源、目标和 stage 副本，不回滚已提交目标。 */
export async function cancelPendingDataDirectoryMigration(
  options: { defaultDataBaseDir?: string } = {},
): Promise<void> {
  const paths = dataDirectoryMigrationControlPaths();
  await withAtomicFileLock(
    paths.requestLockPath,
    async () => {
      const defaultBaseDir = resolve(options.defaultDataBaseDir || getDefaultDataBaseDir());
      const state = await readControlState(paths, defaultBaseDir);
      if (state.disposition === "none") return;
      if (state.disposition === "committed")
        throw new Error("Data directory migration already committed; retry startup to finish");
      if (state.disposition === "pending" && state.request)
        await createSettingServiceWithMigrations({
          defaultDataBaseDir: defaultBaseDir,
        }).cancelPendingDataDirectoryMigration(state.request, state.operation?.originalSettings);
      if (state.operation) await clearOperation(join(paths.operationDirectory, "operation.json"));
    },
    { lockMaxWaitMs: 60 * 60_000 },
  );
}

/** 不启动服务、不隔离坏 JSON；存在或无法判定的请求均交给冷启动错误/重试 gate。 */
export async function inspectDataDirectoryStartup(
  homeDir?: string,
  defaultDataBaseDir?: string,
): Promise<{
  required: boolean;
  locale: "zh-CN" | "en-US";
  desktopChromiumHardwareAccelerationEnabled: boolean;
}> {
  const paths = dataDirectoryMigrationControlPaths(homeDir);
  try {
    await assertOperationDirectory(paths.operationDirectory);
    const recovery = await lstat(join(paths.operationDirectory, "operation.json")).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    const raw = await readMetadata(paths.settingsFile);
    if (raw === undefined && !recovery)
      return { required: false, locale: "zh-CN", desktopChromiumHardwareAccelerationEnabled: true };
    let value: Record<string, unknown> | AppSettings = raw === undefined ? {} : JSON.parse(raw);
    const required = recovery || Object.hasOwn(value, "pendingDataDirectoryMigration");
    if (required) {
      const state = await readControlState(
        paths,
        resolve(defaultDataBaseDir || getDefaultDataBaseDir()),
      );
      const contents = state.rawSettings ?? state.operation?.originalSettings;
      if (contents === undefined) throw corrupt();
      value = parseSettings(contents);
    }
    return {
      required,
      locale: value.locale === "en-US" ? "en-US" : "zh-CN",
      desktopChromiumHardwareAccelerationEnabled:
        value.desktopChromiumHardwareAccelerationEnabled !== false,
    };
  } catch {
    return { required: true, locale: "zh-CN", desktopChromiumHardwareAccelerationEnabled: false };
  }
}

/** 请求锁覆盖停写检查、文件层激活和 settings CAS；唯一设置写者不接触 CLI 会话事实。 */
export async function executePendingDataDirectoryMigration(options: {
  defaultDataBaseDir?: string;
  assertNoWriters: (databasePath: string) => Promise<void>;
  report?: (phase: "checking" | "waiting_for_lock" | "migrating" | "committing") => void;
  copy?: typeof copyDataDirectory;
}): Promise<void> {
  const paths = dataDirectoryMigrationControlPaths();
  const defaultBaseDir = resolve(options.defaultDataBaseDir || getDefaultDataBaseDir());
  const operationFile = join(paths.operationDirectory, "operation.json");
  options.report?.("waiting_for_lock");
  await withAtomicFileLock(
    paths.requestLockPath,
    async () => {
      options.report?.("checking");
      const state = await readControlState(paths, defaultBaseDir);
      const { request, rawSettings } = state;
      let { operation } = state;
      if (!request) return;
      if (state.disposition !== "pending") {
        if (operation) await clearOperation(operationFile);
        return;
      }
      if (request.resetToDefault && resolve(request.targetBaseDir) !== defaultBaseDir)
        throw corrupt();
      if (rawSettings !== undefined) {
        // 同请求重试前 owner 仍可合法保存偏好；本轮 retire 前须同步最新恢复原文，
        // 否则 bootstrap 暂缺后取消会回放上次失败时的旧设置。缺席时保留唯一已验证记录。
        operation = {
          schemaVersion: 1,
          request,
          originalSettings: rawSettings,
          checksum: hash(rawSettings),
        };
        await durableOperation(operationFile, JSON.stringify(operation));
      } else if (!operation) throw corrupt();
      // Header 枚举不打开 SQLite。首次写库仅在所有源/已有目标写者检查通过后由文件层 backup 执行。
      const databases = new Set<string>();
      for (const base of new Set([request.sourceBaseDir, request.targetBaseDir])) {
        const files = await listDataDirectorySqliteFiles(base).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            throw error;
          },
        );
        files.forEach((path) => databases.add(path));
      }
      for (const path of databases) await options.assertNoWriters(path);
      options.report?.("migrating");
      await (options.copy ?? copyDataDirectory)(request.sourceBaseDir, request.targetBaseDir, {
        requestId: request.requestId,
        bootstrapSettingsFilePath: paths.settingsFile,
      });
      options.report?.("committing");
      // 激活中 bootstrap 暂缺时只使用外部原始快照作恢复输入；此刻文件层已恢复原文，重新读取 CAS。
      await createSettingServiceWithMigrations({
        defaultDataBaseDir: defaultBaseDir,
      }).commitPendingDataDirectoryMigration(request);
      await clearOperation(operationFile);
    },
    { lockMaxWaitMs: 60 * 60_000 },
  );
}

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { UWORK_DATA_ROOT_DIR_NAME } from "@zcode/shared";
import {
  isRelocatableMetadataFile,
  relocateDataDirectoryMetadata,
} from "./dataDirectoryMigrationMetadata.js";
import type { DataDirectoryCopyOptions } from "#src/project-storage/contract.js";
import {
  copySqliteSnapshot,
  isSqliteDatabase,
} from "#src/project-storage/data-directory/sqliteSnapshot.js";
import {
  DATA_DIRECTORY_RECEIPT,
  dataDirectoryTargetConflict,
  bootstrapRelativePath,
  fileFingerprint,
  syncDirectory,
  treeFingerprint,
  verifyCopyReceipt,
  isBootstrapEntry,
  syncStagedFile,
} from "#src/project-storage/data-directory/copyReceipt.js";
import {
  activateCopyWorkspace,
  createCopyWorkspace,
  isBootstrapOnlyTarget,
  markCopyVerified,
  preserveBootstrapOwner,
  resumeCopyWorkspace,
} from "#src/project-storage/data-directory/copyActivation.js";

const contains = (parent: string, child: string): boolean => {
  const part = relative(parent, child);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
};
const localPath = (root: string, path: string): string => relative(root, path).split(sep).join("/");
function isBootstrapFile(local: string): boolean {
  return isBootstrapEntry(local, "v2/setting.json") || local === DATA_DIRECTORY_RECEIPT;
}
function assertSkippableLink(local: string): void {
  // 共享工作区链接仍沿旧规则跳过；数据库/默认数据库目录链接不能悄悄漏复制后建立空库。
  if (local === "cli" || local === "cli/db" || /\.(?:sqlite|db)$/i.test(local)) {
    throw new Error("UWork data directory migration cannot omit a linked SQLite location");
  }
}
async function* sourceEntries(
  root: string,
  directory = root,
): AsyncGenerator<{ path: string; local: string; directory: boolean; mode: number }> {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    const local = localPath(root, path);
    const info = await lstat(path);
    if (info.isFile() && isBootstrapFile(local)) continue;
    if (info.isSymbolicLink()) {
      assertSkippableLink(local);
      continue;
    }
    if (!info.isDirectory() && !info.isFile())
      throw new Error("UWork migration cannot copy an unsupported filesystem entry");
    yield { path, local, directory: info.isDirectory(), mode: info.mode & 0o777 };
    if (info.isDirectory()) yield* sourceEntries(root, path);
  }
}
async function assertSourceDirectory(source: string): Promise<void> {
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("UWork migration source must be a real directory");
}

/** 冷启动写者门禁复用此只读枚举；不跟随数据库或目录链接，不把扩展名当成 SQLite 证据。 */
export async function listDataDirectorySqliteFiles(baseDir: string): Promise<string[]> {
  const source = resolve(baseDir, UWORK_DATA_ROOT_DIR_NAME);
  await assertSourceDirectory(source);
  const result: string[] = [];
  for await (const entry of sourceEntries(source)) {
    if (entry.directory) continue;
    const headerMatches = await isSqliteDatabase(entry.path);
    const knownDatabase =
      entry.local === "v2/tasks-index.sqlite" || entry.local === "cli/db/db.sqlite";
    // 已知业务库不能因头部损坏而降级成普通文件后发布；全新零字节库仍交给 SQLite 验证。
    if (knownDatabase && !headerMatches && (await lstat(entry.path)).size > 0) {
      throw new Error("UWork SQLite database header is invalid");
    }
    if (headerMatches || knownDatabase) result.push(entry.path);
  }
  return result;
}

/** 不创建目录就解析尚未存在的目标；断链与权限错误不能被当作空目标。 */
async function plannedCanonicalPath(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // lstat 存在、realpath 失败说明有坏链接，不能继续向父级回退。
      try {
        await lstat(current);
        throw new Error("UWork migration target contains a broken path");
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== "ENOENT") throw probeError;
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

async function assertInternalDatabaseReference(config: unknown, source: string): Promise<void> {
  const path = (config as { storage?: { sessionDbPath?: unknown } } | null)?.storage?.sessionDbPath;
  if (typeof path !== "string" || !isAbsolute(path) || !contains(source, path)) return;
  let current = source;
  for (const part of relative(source, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("UWork migration cannot relocate a linked session database");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/** UWork 整根冷复制；调用方持有请求锁、停写门禁并唯一提交 bootstrap 设置。 */
export async function copyDataDirectory(
  oldBaseDir: string,
  newBaseDir: string,
  options?: DataDirectoryCopyOptions,
): Promise<void> {
  const source = resolve(oldBaseDir, UWORK_DATA_ROOT_DIR_NAME);
  const target = resolve(newBaseDir, UWORK_DATA_ROOT_DIR_NAME);
  if (
    options &&
    (typeof options.requestId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(options.requestId))
  )
    throw new Error("UWork migration requestId is invalid");
  if (source === target) return;
  if (contains(source, target) || contains(target, source))
    throw new Error("UWork data directories must not overlap");
  const bootstrap = bootstrapRelativePath(target, options?.bootstrapSettingsFilePath);
  if (options && (await resumeCopyWorkspace(source, target, options))) return;
  const targetInfo = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (targetInfo?.isSymbolicLink())
    throw dataDirectoryTargetConflict("UWork migration target must not be a link");
  const entries = targetInfo ? await readdir(target) : [];
  let originalBootstrapFingerprint: string | undefined;
  if (entries.length) {
    if (!options)
      throw dataDirectoryTargetConflict(
        "UWork target data directory is not empty; choose an empty directory",
      );
    // 激活后的 request 重试只核验新根；不能重新读取旧根、覆盖新根或伪造已完成凭据。
    if (entries.includes(DATA_DIRECTORY_RECEIPT)) {
      try {
        await verifyCopyReceipt(target, {
          requestId: options.requestId,
          source,
          target,
          bootstrapSettingsFilePath: options.bootstrapSettingsFilePath,
        });
      } catch (error) {
        throw dataDirectoryTargetConflict(
          "UWork target migration receipt is invalid or changed",
          error,
        );
      }
      return;
    }
    if (!(await isBootstrapOnlyTarget(target, bootstrap)))
      throw dataDirectoryTargetConflict(
        "UWork target data directory is not empty; choose an empty directory",
      );
    originalBootstrapFingerprint = await treeFingerprint(target);
  } else if (bootstrap) {
    throw new Error("UWork bootstrap owner is missing before data directory copy");
  }
  await assertSourceDirectory(source);
  const canonicalSource = await realpath(source);
  const canonicalTarget = await plannedCanonicalPath(target);
  if (contains(canonicalSource, canonicalTarget) || contains(canonicalTarget, canonicalSource))
    throw new Error("UWork data directories must not overlap");
  const databases = new Set(await listDataDirectorySqliteFiles(oldBaseDir));
  await mkdir(dirname(target), { recursive: true });
  const workspace = options ? await createCopyWorkspace(source, target, options) : undefined;
  const stage = workspace?.root ?? (await mkdtemp(join(dirname(target), ".uwork-migration-")));
  const stagedRoot = workspace?.stageRoot ?? join(stage, UWORK_DATA_ROOT_DIR_NAME);
  let verified = false;
  const directoryModes = [{ path: stagedRoot, mode: (await lstat(source)).mode & 0o777 }];
  try {
    await mkdir(stagedRoot, { mode: 0o700 });
    for await (const entry of sourceEntries(source)) {
      const destination = join(stagedRoot, entry.local);
      if (entry.directory) {
        await mkdir(destination, { mode: 0o700 });
        directoryModes.push({ path: destination, mode: entry.mode });
        continue;
      }
      if (
        (entry.path.endsWith("-wal") || entry.path.endsWith("-shm")) &&
        databases.has(entry.path.slice(0, -4))
      )
        continue;
      if (databases.has(entry.path)) await copySqliteSnapshot(entry.path, destination);
      else {
        await copyFile(entry.path, destination);
        // 只在私有 stage 临时给 owner 写权限，完成重定位和可写句柄 flush 后恢复原 mode。
        await chmod(destination, entry.mode | 0o200);
        if ((await fileFingerprint(entry.path)) !== (await fileFingerprint(destination)))
          throw new Error("UWork migration content verification failed");
        if (isRelocatableMetadataFile(entry.local)) {
          let parsed: unknown;
          let validJson = false;
          try {
            parsed = JSON.parse(await readFile(destination, "utf8"));
            validJson = true;
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
          if (validJson) {
            if (entry.local === "cli/config.json")
              await assertInternalDatabaseReference(parsed, source);
            const before = JSON.stringify(parsed);
            relocateDataDirectoryMetadata(entry.local, parsed, {
              source,
              target,
              canonicalSource,
              canonicalTarget,
            });
            if (before !== JSON.stringify(parsed))
              await writeFile(destination, JSON.stringify(parsed, null, 2) + "\n");
          }
        }
      }
      await syncStagedFile(destination, entry.mode);
    }
    const stagedBootstrapFingerprint =
      originalBootstrapFingerprint && bootstrap
        ? await preserveBootstrapOwner(target, stagedRoot, bootstrap)
        : undefined;
    for (const directory of directoryModes.reverse()) {
      await chmod(directory.path, directory.mode);
      await syncDirectory(directory.path);
    }
    if (workspace) {
      await markCopyVerified(workspace, originalBootstrapFingerprint, stagedBootstrapFingerprint);
      verified = true;
      await activateCopyWorkspace(workspace);
      return;
    }
    // rmdir 只接受仍为空的目标；其他请求或用户新增的任何内容都不得被覆盖。
    await rmdir(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(stagedRoot, target);
    await syncDirectory(dirname(target));
  } finally {
    // verified 后的私有 journal/stage 是崩溃恢复材料，不能在部分 retire 时删掉唯一候选。
    if (!verified) await rm(stage, { recursive: true, force: true });
  }
}

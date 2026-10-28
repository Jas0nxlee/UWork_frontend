import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { DataDirectoryCopyOptions } from "#src/project-storage/contract.js";
import {
  bootstrapRelativePath,
  DATA_DIRECTORY_RECEIPT,
  dataDirectoryTargetConflict,
  durableJson,
  fileFingerprint,
  isBootstrapEntry,
  syncDirectory,
  syncStagedFile,
  treeFingerprint,
  verifyCopyReceipt,
  writeCopyReceipt,
} from "./copyReceipt.js";

interface CopyJournal {
  version: 1;
  requestId: string;
  source: string;
  target: string;
  bootstrapSettingsFilePath?: string;
  phase: "copying" | "verified";
  originalBootstrapFingerprint?: string;
  stagedBootstrapFingerprint?: string;
}
export interface CopyWorkspace {
  root: string;
  stageRoot: string;
  retiredRoot: string;
  journalPath: string;
  journal: CopyJournal;
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function workspacePaths(source: string, target: string, options: DataDirectoryCopyOptions) {
  const id = createHash("sha256")
    .update(JSON.stringify([source, target, options.requestId]))
    .digest("hex")
    .slice(0, 32);
  const root = join(dirname(target), `.uwork-data-copy-${id}`);
  return {
    root,
    stageRoot: join(root, ".uwork"),
    retiredRoot: join(root, "retired-bootstrap"),
    journalPath: join(root, "journal.json"),
  };
}
async function readWorkspace(
  source: string,
  target: string,
  options: DataDirectoryCopyOptions,
): Promise<CopyWorkspace | undefined> {
  const paths = workspacePaths(source, target, options);
  if (!(await exists(paths.root))) return undefined;
  const directory = await lstat(paths.root);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.platform !== "win32" && (directory.mode & 0o077) !== 0)
  )
    throw new Error("UWork migration staging directory is not private");
  if (!(await exists(paths.journalPath))) {
    if ((await readdir(paths.root)).length)
      throw new Error("UWork migration staging directory belongs to another operation");
    return undefined;
  }
  const info = await lstat(paths.journalPath);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0))
    throw new Error("UWork migration journal is not private");
  const journal = JSON.parse(await readFile(paths.journalPath, "utf8")) as CopyJournal;
  if (
    journal.version !== 1 ||
    journal.requestId !== options.requestId ||
    journal.source !== source ||
    journal.target !== target ||
    journal.bootstrapSettingsFilePath !== options.bootstrapSettingsFilePath ||
    !["copying", "verified"].includes(journal.phase)
  )
    throw new Error("UWork migration journal does not match this request");
  return { ...paths, journal };
}

/** bootstrap-only 是精确的设置 owner 特例；普通目录和链接不能借此绕过非空检查。 */
export async function isBootstrapOnlyTarget(root: string, bootstrap?: string): Promise<boolean> {
  if (!bootstrap) return false;
  const allowedDirectory = dirname(bootstrap).split(sep).join("/");
  const visit = async (path: string): Promise<boolean> => {
    const local = relative(root, path).split(sep).join("/");
    const info = await lstat(path);
    if (info.isSymbolicLink()) return false;
    if (info.isDirectory()) {
      if (local && local !== allowedDirectory) return false;
      for (const name of await readdir(path)) if (!(await visit(join(path, name)))) return false;
      return true;
    }
    return info.isFile() && isBootstrapEntry(local, bootstrap);
  };
  if (!(await exists(join(root, bootstrap)))) return false;
  const owner = await lstat(join(root, bootstrap));
  return owner.isFile() && !owner.isSymbolicLink() && (await visit(root));
}
async function bootstrapFingerprint(root: string, bootstrap: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (path: string): Promise<void> => {
    const local = relative(root, path).split(sep).join("/");
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("UWork bootstrap owner contains a link");
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        const child = join(path, name);
        const childLocal = relative(root, child).split(sep).join("/");
        if (
          childLocal === dirname(bootstrap).split(sep).join("/") ||
          (isBootstrapEntry(childLocal, bootstrap) && (await lstat(child)).isFile())
        )
          await visit(child);
      }
    } else if (info.isFile() && isBootstrapEntry(local, bootstrap))
      hash.update(JSON.stringify([local, info.mode & 0o777, await fileFingerprint(path)]));
    else throw new Error("UWork bootstrap owner has an unsupported entry");
  };
  await visit(root);
  return hash.digest("hex");
}
export async function preserveBootstrapOwner(
  target: string,
  stageRoot: string,
  bootstrap: string,
): Promise<string> {
  const expected = await bootstrapFingerprint(target, bootstrap);
  const copy = async (path: string): Promise<void> => {
    const local = relative(target, path);
    const info = await lstat(path);
    if (info.isDirectory()) {
      const destination = join(stageRoot, local);
      await mkdir(destination, { recursive: true, mode: info.mode & 0o777 });
      for (const name of await readdir(path)) {
        const child = join(path, name);
        const childLocal = relative(target, child).split(sep).join("/");
        if (
          childLocal === dirname(bootstrap).split(sep).join("/") ||
          isBootstrapEntry(childLocal, bootstrap)
        )
          await copy(child);
      }
      if (isBootstrapEntry(local.split(sep).join("/"), bootstrap))
        await chmod(destination, info.mode & 0o777);
      await syncDirectory(destination);
    } else if (info.isFile() && isBootstrapEntry(local.split(sep).join("/"), bootstrap)) {
      const destination = join(stageRoot, local);
      await copyFile(path, destination);
      await chmod(destination, (info.mode & 0o777) | 0o200);
      await syncStagedFile(destination, info.mode & 0o777);
    } else throw new Error("UWork bootstrap owner must be a regular file");
  };
  await copy(target);
  if (expected !== (await bootstrapFingerprint(stageRoot, bootstrap)))
    throw new Error("UWork bootstrap settings changed while preserving owner");
  return expected;
}

export async function createCopyWorkspace(
  source: string,
  target: string,
  options: DataDirectoryCopyOptions,
): Promise<CopyWorkspace> {
  const existing = await readWorkspace(source, target, options);
  const paths = workspacePaths(source, target, options);
  if (existing) {
    if (existing.journal.phase !== "copying" || (await exists(existing.retiredRoot)))
      throw new Error("UWork migration activation must be resumed before copying");
    await rm(existing.stageRoot, { recursive: true, force: true });
    return existing;
  }
  if (!(await exists(paths.root))) await mkdir(paths.root, { mode: 0o700 });
  const journal: CopyJournal = {
    version: 1,
    requestId: options.requestId,
    source,
    target,
    phase: "copying",
    ...(options.bootstrapSettingsFilePath
      ? { bootstrapSettingsFilePath: options.bootstrapSettingsFilePath }
      : {}),
  };
  await durableJson(paths.journalPath, journal);
  await syncDirectory(dirname(paths.root));
  return { ...paths, journal };
}
export async function markCopyVerified(
  workspace: CopyWorkspace,
  originalBootstrapFingerprint?: string,
  stagedBootstrapFingerprint?: string,
): Promise<void> {
  const journal = workspace.journal;
  const bootstrap = bootstrapRelativePath(journal.target, journal.bootstrapSettingsFilePath);
  await writeCopyReceipt(workspace.stageRoot, {
    version: 1,
    requestId: journal.requestId,
    source: journal.source,
    target: journal.target,
    fingerprint: await treeFingerprint(workspace.stageRoot, bootstrap),
    ...(journal.bootstrapSettingsFilePath
      ? { bootstrapSettingsFilePath: journal.bootstrapSettingsFilePath }
      : {}),
  });
  journal.phase = "verified";
  if (originalBootstrapFingerprint)
    journal.originalBootstrapFingerprint = originalBootstrapFingerprint;
  if (stagedBootstrapFingerprint) journal.stagedBootstrapFingerprint = stagedBootstrapFingerprint;
  await durableJson(workspace.journalPath, journal);
}
async function activate(workspace: CopyWorkspace): Promise<void> {
  const journal = workspace.journal;
  const expected = {
    requestId: journal.requestId,
    source: journal.source,
    target: journal.target,
    bootstrapSettingsFilePath: journal.bootstrapSettingsFilePath,
  };
  const bootstrap = bootstrapRelativePath(journal.target, journal.bootstrapSettingsFilePath);
  await verifyCopyReceipt(workspace.stageRoot, expected);
  if (
    bootstrap &&
    journal.stagedBootstrapFingerprint &&
    (await bootstrapFingerprint(workspace.stageRoot, bootstrap)) !==
      journal.stagedBootstrapFingerprint
  )
    throw new Error("UWork staged bootstrap owner changed");
  if (await exists(journal.target)) {
    const info = await lstat(journal.target);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw dataDirectoryTargetConflict("UWork migration target is not a directory");
    const entries = await readdir(journal.target);
    if (entries.length) {
      if (
        !journal.originalBootstrapFingerprint ||
        !(await isBootstrapOnlyTarget(journal.target, bootstrap)) ||
        (await treeFingerprint(journal.target)) !== journal.originalBootstrapFingerprint ||
        (await exists(workspace.retiredRoot))
      )
        throw dataDirectoryTargetConflict(
          "UWork target data directory is not empty or changed during activation",
        );
      await rename(journal.target, workspace.retiredRoot);
      await syncDirectory(workspace.root);
      await syncDirectory(dirname(journal.target));
    } else await rmdir(journal.target);
  }
  // 外部启动记录保留 pending/原设置；retire 后崩溃时不能先重建一个小 target 覆盖它。
  await rename(workspace.stageRoot, journal.target);
  await syncDirectory(dirname(journal.target));
  await rm(workspace.root, { recursive: true, force: true });
}
export async function activateCopyWorkspace(workspace: CopyWorkspace): Promise<void> {
  if (workspace.journal.phase !== "verified")
    throw new Error("UWork migration candidate is not verified");
  await activate(workspace);
}
export async function resumeCopyWorkspace(
  source: string,
  target: string,
  options: DataDirectoryCopyOptions,
): Promise<boolean> {
  const workspace = await readWorkspace(source, target, options);
  if (!workspace || workspace.journal.phase !== "verified") return false;
  if (await exists(join(target, DATA_DIRECTORY_RECEIPT))) {
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
    await rm(workspace.root, { recursive: true, force: true });
  } else await activate(workspace);
  return true;
}

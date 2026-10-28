import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, open, readFile, readdir, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DATA_DIRECTORY_RECEIPT = ".uwork-data-migration-receipt.json";

export function dataDirectoryTargetConflict(
  message: string,
  cause?: unknown,
): Error & { code: "DATA_DIRECTORY_TARGET_CONFLICT" } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: "DATA_DIRECTORY_TARGET_CONFLICT" as const,
  });
}

export interface CopyReceipt {
  version: 1;
  requestId: string;
  source: string;
  target: string;
  fingerprint: string;
  bootstrapSettingsFilePath?: string;
}

export function bootstrapRelativePath(target: string, path?: string): string | undefined {
  if (!path) return undefined;
  if (!isAbsolute(path)) throw new Error("UWork bootstrap settings path must be absolute");
  const local = relative(target, resolve(path)).split(sep).join("/");
  if (local === ".." || local.startsWith("../") || isAbsolute(local)) return undefined;
  if (local !== "v2/setting.json") throw new Error("UWork bootstrap settings exclusion is invalid");
  return local;
}
export function isBootstrapEntry(local: string, bootstrap?: string): boolean {
  if (!bootstrap) return false;
  if (local === bootstrap) return true;
  const prefix = `${bootstrap}.tmp-`;
  // 与 settingsWriteQueue 的原子文件生成器一致；不豁免任意同前缀文件或目录。
  return local.startsWith(prefix) && /^\d+-\d+-[a-f0-9]+$/.test(local.slice(prefix.length));
}

/** Windows FlushFileBuffers 需要可写句柄；恢复只读 mode 前先打开并完成 flush。 */
export async function syncStagedFile(path: string, finalMode?: number): Promise<void> {
  const file = await open(path, "r+");
  try {
    await file.sync();
    if (finalMode !== undefined) {
      await chmod(path, finalMode);
      await file.sync();
    }
  } finally {
    await file.close();
  }
}

export async function fileFingerprint(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** 指纹包含所有目录、文件内容与权限；激活凭据本身不参与，禁止链接混入重试目标。 */
export async function treeFingerprint(root: string, bootstrap?: string): Promise<string> {
  const digest = createHash("sha256");
  const visit = async (path: string): Promise<void> => {
    const local = relative(root, path).split(sep).join("/");
    if (local === DATA_DIRECTORY_RECEIPT) return;
    const info = await lstat(path);
    if (info.isFile() && isBootstrapEntry(local, bootstrap)) return;
    const mode = info.mode & 0o777;
    if (info.isDirectory()) {
      digest.update(JSON.stringify([local, "directory", mode]));
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (info.isFile()) {
      digest.update(JSON.stringify([local, "file", mode, await fileFingerprint(path)]));
    } else throw new Error("UWork migration receipt verification rejected an unexpected entry");
  };
  await visit(root);
  return digest.digest("hex");
}

export async function writeCopyReceipt(root: string, receipt: CopyReceipt): Promise<void> {
  const path = join(root, DATA_DIRECTORY_RECEIPT);
  await durableJson(path, receipt);
}
export async function durableJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

export async function verifyCopyReceipt(
  root: string,
  expected: Pick<CopyReceipt, "requestId" | "source" | "target" | "bootstrapSettingsFilePath">,
): Promise<void> {
  const path = join(root, DATA_DIRECTORY_RECEIPT);
  const info = await lstat(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("UWork migration receipt is not a private regular file");
  }
  const receipt = JSON.parse(await readFile(path, "utf8")) as CopyReceipt;
  if (
    receipt.version !== 1 ||
    receipt.requestId !== expected.requestId ||
    receipt.source !== expected.source ||
    receipt.target !== expected.target ||
    receipt.bootstrapSettingsFilePath !== expected.bootstrapSettingsFilePath ||
    !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
    Object.keys(receipt).some(
      (key) =>
        ![
          "version",
          "requestId",
          "source",
          "target",
          "fingerprint",
          "bootstrapSettingsFilePath",
        ].includes(key),
    ) ||
    (await treeFingerprint(
      root,
      bootstrapRelativePath(expected.target, expected.bootstrapSettingsFilePath),
    )) !== receipt.fingerprint
  )
    throw new Error("UWork migration receipt verification failed");
}

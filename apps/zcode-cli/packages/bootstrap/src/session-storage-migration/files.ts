import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // ENOENT 也可能来自指向离线卷的文件/祖先 symlink，不能误当作首次安装。
    let candidate = path;
    for (;;) {
      try {
        const entry = await lstat(candidate);
        if (entry.isSymbolicLink()) {
          try {
            await realpath(candidate);
          } catch (linkError) {
            if ((linkError as NodeJS.ErrnoException).code === "ENOENT")
              throw Object.assign(
                new Error("SESSION_MIGRATION_PATH: symbolic-link destination is unavailable"),
                { code: "SESSION_MIGRATION_PATH", kind: "path" },
              );
            throw linkError;
          }
        }
        return false;
      } catch (entryError) {
        if ((entryError as NodeJS.ErrnoException).code !== "ENOENT") throw entryError;
      }
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function fileFingerprint(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
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
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
/** SQLite backup 从只读连接获得 WAL 一致性快照，源不运行 schema migration。 */
export async function snapshot(source: string, target: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.snapshot`;
  let published = false;
  try {
    const db = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(db, temporary);
    } finally {
      db.close();
    }
    await chmod(temporary, 0o600);
    const file = await open(temporary, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    published = true;
    await syncDirectory(dirname(target));
  } finally {
    // backup/权限/同步失败都可能留下大块部分文件；仅清本次 UUID 的未发布产物，保留业务库和已发布备份。
    if (!published)
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        await rm(`${temporary}${suffix}`, { force: true });
  }
}

interface LockOwner {
  pid: number;
  owner: string;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}
export async function acquireMigrationLock(target: string): Promise<() => Promise<void>> {
  const path = `${target}.uwork-migration.lock`;
  const owner: LockOwner = { pid: process.pid, owner: randomUUID() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(path, { mode: 0o700 });
      try {
        await durableJson(`${path}/owner.json`, owner);
      } catch (error) {
        await rm(path, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        const current = await readJson<LockOwner>(`${path}/owner.json`);
        if (current?.owner === owner.owner) await rm(path, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readJson<LockOwner>(`${path}/owner.json`);
      if (
        !current ||
        !Number.isSafeInteger(current.pid) ||
        current.pid <= 0 ||
        typeof current.owner !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(current.owner) ||
        alive(current.pid)
      ) {
        throw new Error(
          "SESSION_MIGRATION_LOCKED: migration owner is active or cannot be verified",
        );
      }
      // 隔离目录保留旧 owner 名：并发回收者无法把后来新建的活锁覆盖到同一非空隔离目录。
      try {
        await rename(path, `${path}.orphan-${current.owner}`);
      } catch (renameError) {
        const code = (renameError as NodeJS.ErrnoException).code;
        if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(code ?? "")) throw renameError;
      }
    }
  }
  throw new Error("SESSION_MIGRATION_LOCKED: concurrent migration");
}

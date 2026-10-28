import { createHash, randomUUID } from "node:crypto";
import { SqliteSessionStore, type SqliteMigrationProgress } from "@zcode/adapters/storage";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  zcodeProtocolNotifications,
  zcodeStorageStartupStateSchema,
  ZCODE_STORAGE_PREPARATION_FRAME_MAX_CHARS,
  type ZCodeStorageStartupState,
} from "@zcode/shared";
import { sessionDatabaseMigration } from "../session-storage-migration/index.js";
import type { SessionDatabaseRouteResolver } from "../session-storage-migration/index.js";

interface LegacyMigrationPlan {
  sourcePath: string;
  targetPath: string;
  resolveSessionDatabase?: SessionDatabaseRouteResolver;
}

export async function openProtocolStartupStorage(options: {
  dbPath: string;
  output: NodeJS.WritableStream;
  onProgress?: (progress: ZCodeStorageStartupState) => void;
  legacyMigration?: LegacyMigrationPlan & { ownershipManifestPath: string };
}): Promise<SqliteSessionStore> {
  const attemptId = randomUUID();
  const databaseId = createHash("sha256").update(options.dbPath).digest("hex");
  let sequence = 0;
  let failedReported = false;
  const report = async (progress: SqliteMigrationProgress) => {
    const params = zcodeStorageStartupStateSchema.parse({
      schemaVersion: 1,
      attemptId,
      databaseId,
      databaseKind: "session",
      sequence: ++sequence,
      ...progress,
    });
    failedReported ||= params.phase === "failed";
    options.onProgress?.(params);
    // 不能先写入 JS 缓冲后立即阻塞执行 SQL；等待 Writable 确认控制帧已交给传输层。
    await new Promise<void>((resolve, reject) => {
      options.output.write(
        `${JSON.stringify({ method: zcodeProtocolNotifications.storageStartup, params })}\n`,
        (error?: Error | null) => (error ? reject(error) : resolve()),
      );
    });
  };
  try {
    await report({ phase: "checking", elapsedMs: 0 });
    if (options.legacyMigration) {
      const startedAt = Date.now();
      // 路径升级必须早于 openStartup：先建空库会把未迁移状态误当成新安装，隐藏原有历史。
      await sessionDatabaseMigration.migrate({
        ...options.legacyMigration,
        onProgress: async (phase) =>
          report({
            phase: phase === "activating" ? "committing" : "migrating",
            elapsedMs: Date.now() - startedAt,
            migrationId: "uwork-session-database-root-v1",
          }),
      });
    }
    return await SqliteSessionStore.openStartup({ dbPath: options.dbPath }, { onProgress: report });
  } catch (error) {
    if (!failedReported) {
      try {
        await report({
          phase: "failed",
          elapsedMs: 0,
          errorCode: classifyDatabaseStartupError(error),
          ...databaseStartupErrorDetails(error),
        });
      } catch {
        /* 传输已断开时保留最初的数据库/传输异常。 */
      }
    }
    throw error;
  }
}

/** 只准备存储，不创建 Provider/MCP/工作区 runtime；Host 确认观测边界后才允许写库。 */
export async function prepareProtocolStartupStorage(options: {
  dbPath: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  legacyMigration?: LegacyMigrationPlan;
}): Promise<void> {
  const { createInterface } = await import("node:readline");
  const { zcodeStoragePathReadySchema, classifyDatabaseStartupError } =
    await import("@zcode/shared");
  const lines = createInterface({ input: options.input });
  let timer: ReturnType<typeof setTimeout>;
  const acknowledgement = new Promise<{ reuse?: boolean; ownershipManifestPath?: string }>(
    (resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error("Storage observation handshake timed out"), {
              kind: "startup_status_timeout",
            }),
          ),
        30_000,
      );
      lines.once("line", (line) => {
        try {
          if (line.length > ZCODE_STORAGE_PREPARATION_FRAME_MAX_CHARS)
            throw new Error("Invalid storage acknowledgement");
          const ack = zcodeStoragePathReadySchema.parse(JSON.parse(line));
          resolve(ack);
        } catch (error) {
          reject(error);
        }
      });
      lines.once("close", () =>
        reject(
          Object.assign(new Error("Storage preparation input closed"), {
            kind: "transport_closed",
          }),
        ),
      );
    },
  );
  // 路径通知发送失败时也要消费已创建的等待 promise，避免未处理拒绝。
  void acknowledgement.catch(() => {});
  let store: SqliteSessionStore | undefined;
  let failure: unknown;
  const write = (frame: unknown) =>
    new Promise<void>((resolve, reject) => {
      options.output.write(`${JSON.stringify(frame)}\n`, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
  try {
    const migration =
      options.legacyMigration &&
      !(await sessionDatabaseMigration.isPrepared(options.legacyMigration))
        ? options.legacyMigration
        : undefined;
    await write({
      method: "startup/storagePath",
      params: {
        path: options.dbPath,
        ...(migration ? { legacySourcePath: migration.sourcePath } : {}),
      },
    });
    const ack = await acknowledgement;
    clearTimeout(timer!);
    lines.close();
    // 同一路径的显式库准备不代表默认路径升级完成；不能用 Host 的复用 ACK 绕过迁移账本。
    if (migration && ack.reuse)
      throw new Error("Legacy session migration cannot reuse an unprepared database");
    // reuse 仅由同一次 Host 准备的成功路径集合授予；不打开连接，也不写永久跳过标记。
    if (!ack.reuse) {
      if (migration && !ack.ownershipManifestPath)
        throw new Error("Legacy session migration requires ownership manifest / 归属清单");
      store = await openProtocolStartupStorage({
        ...options,
        legacyMigration: migration
          ? { ...migration, ownershipManifestPath: ack.ownershipManifestPath! }
          : undefined,
      });
      store.close();
      store = undefined;
    }
    await write({ method: "startup/storagePrepared", params: {} });
  } catch (error) {
    failure = error;
    try {
      await write({
        method: "startup/storageState",
        params: {
          schemaVersion: 1,
          attemptId: randomUUID(),
          databaseId: createHash("sha256").update(options.dbPath).digest("hex"),
          databaseKind: "session",
          sequence: 1,
          phase: "failed",
          elapsedMs: 0,
          errorCode: classifyDatabaseStartupError(error),
          ...databaseStartupErrorDetails(error),
        },
      });
    } catch {
      /* 原始存储异常优先于失败通知的 IO 异常。 */
    }
    throw error;
  } finally {
    clearTimeout(timer!);
    lines.close();
    try {
      store?.close();
    } catch (error) {
      if (!failure) throw error;
    }
  }
}

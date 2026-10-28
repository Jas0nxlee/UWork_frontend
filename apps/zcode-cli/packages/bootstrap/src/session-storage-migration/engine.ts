import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import type {
  LegacySessionOwnershipManifest,
  SessionDatabaseMigrationContract,
  SessionDatabaseMigrationOptions,
  SessionDatabaseMigrationResult,
  SessionDatabaseRouteResolver,
} from "./contract.js";
import {
  acquireMigrationLock,
  durableJson,
  exists,
  fileFingerprint,
  fingerprint,
  readJson,
  snapshot,
  syncDirectory,
} from "./files.js";
import { assertCurrentColumns, mergeOwnedRows, ownershipError, validateSchema } from "./rows.js";

interface Journal {
  version: 1;
  id: string;
  sourcePath: string;
  targetPath: string;
  manifestFingerprint: string;
  phase: "copying" | "verified" | "activating" | "complete";
  workDir: string;
  importedSessions: number;
  status: "fresh" | "migrated";
  sourceIdentity?: unknown;
  targetExisted: boolean;
  stageFingerprint?: string;
  targetFiles?: { database: string; wal: string | null };
  sourceFiles?: { database: string; wal: string | null };
  targetMode?: number;
}
async function walFingerprint(path: string): Promise<string | null> {
  if (!(await exists(path)) || (await stat(path)).size <= 32) return null;
  return fileFingerprint(path);
}
async function targetFiles(target: string): Promise<{ database: string; wal: string | null }> {
  return { database: await fileFingerprint(target), wal: await walFingerprint(`${target}-wal`) };
}
async function sourceChanged(journal: Journal): Promise<boolean> {
  if (journal.status !== "migrated" || !journal.sourceFiles) return false;
  try {
    return fingerprint(await targetFiles(journal.sourcePath)) !== fingerprint(journal.sourceFiles);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
function sourceChangedError(): Error & {
  code: "SESSION_MIGRATION_SOURCE_CHANGED";
  kind: "source-changed";
} {
  return Object.assign(
    new Error("SESSION_MIGRATION_SOURCE_CHANGED: legacy database changed after its snapshot"),
    { code: "SESSION_MIGRATION_SOURCE_CHANGED" as const, kind: "source-changed" as const },
  );
}
async function assertSourceUnchanged(journal: Journal): Promise<void> {
  if (journal.status === "migrated" && !journal.sourceFiles) throw sourceChangedError();
  if (await sourceChanged(journal)) throw sourceChangedError();
}
interface Paths {
  sourcePath: string;
  targetPath: string;
}
const markerTable = "uwork_session_root_migration";
const journalPath = (target: string) => `${target}.uwork-migration.json`;
function normalized(paths: Paths): Paths {
  if (!isAbsolute(paths.sourcePath) || !isAbsolute(paths.targetPath))
    throw new Error("SESSION_MIGRATION_PATH: absolute paths required");
  const result = { sourcePath: resolve(paths.sourcePath), targetPath: resolve(paths.targetPath) };
  if (result.sourcePath === result.targetPath)
    throw new Error("SESSION_MIGRATION_PATH: source and target must differ");
  return result;
}
function assertJournal(journal: Journal, paths: Paths): void {
  if (
    journal.version !== 1 ||
    typeof journal.sourcePath !== "string" ||
    !isAbsolute(journal.sourcePath) ||
    typeof journal.targetPath !== "string" ||
    !isAbsolute(journal.targetPath) ||
    typeof journal.workDir !== "string" ||
    !isAbsolute(journal.workDir) ||
    !/^[a-f0-9-]{36}$/i.test(journal.id) ||
    !/^[a-f0-9]{64}$/i.test(journal.manifestFingerprint) ||
    !["fresh", "migrated"].includes(journal.status) ||
    typeof journal.targetExisted !== "boolean" ||
    !["copying", "verified", "activating", "complete"].includes(journal.phase) ||
    !Number.isSafeInteger(journal.importedSessions) ||
    journal.importedSessions < 0
  )
    throw new Error("SESSION_MIGRATION_JOURNAL: incompatible migration record");
  // 完成后历史位置只作审计；当前位置旁的 ledger 必须与该位置的 DB 不可变 marker 相符。
  // 未完成阶段仍会执行文件恢复，必须严格绑定当前 source/target 与安全工作目录。
  if (journal.phase === "complete") return;
  if (journal.sourcePath !== paths.sourcePath || journal.targetPath !== paths.targetPath)
    throw new Error("SESSION_MIGRATION_JOURNAL: pending migration paths changed");
  if (journal.workDir !== join(dirname(paths.targetPath), ".uwork-session-migration", journal.id))
    throw new Error("SESSION_MIGRATION_JOURNAL: invalid staging directory");
}
function markerMatches(db: DatabaseSync, journal: Journal): boolean {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(markerTable))
    return false;
  const marker = db.prepare(`SELECT * FROM ${markerTable} WHERE id=1`).get();
  return (
    marker?.migration_id === journal.id &&
    marker.manifest_fingerprint === journal.manifestFingerprint &&
    marker.source_identity_fingerprint === fingerprint(journal.sourceIdentity ?? { absent: true })
  );
}
async function targetMatches(journal: Journal, path = journal.targetPath): Promise<boolean> {
  if (!(await exists(path))) return false;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return markerMatches(db, journal);
  } finally {
    db.close();
  }
}
async function assertReady(paths: Paths): Promise<void> {
  if (!(await isPrepared(paths)))
    throw new Error("SESSION_MIGRATION_REQUIRED: default session database has not been prepared");
}
async function isPrepared(paths: Paths): Promise<boolean> {
  const target = normalized(paths);
  const journal = await readJson<Journal>(journalPath(target.targetPath));
  if (!journal) return false;
  assertJournal(journal, target);
  if (journal.phase !== "complete") return false;
  if (!(await targetMatches(journal, target.targetPath)))
    throw new Error("SESSION_MIGRATION_VERIFY: completed target marker is missing or invalid");
  return true;
}
function parseManifest(value: unknown): LegacySessionOwnershipManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw ownershipError("invalid manifest");
  const manifest = value as LegacySessionOwnershipManifest;
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.sessions) ||
    Object.keys(value).some((key) => key !== "schemaVersion" && key !== "sessions")
  )
    throw ownershipError("incompatible manifest");
  const ids = new Set<string>();
  for (const item of manifest.sessions) {
    if (
      !item ||
      typeof item.sessionId !== "string" ||
      !item.sessionId.trim() ||
      typeof item.workspacePath !== "string" ||
      !isAbsolute(item.workspacePath) ||
      (item.workspaceIdentity !== undefined &&
        (typeof item.workspaceIdentity !== "string" || !item.workspaceIdentity.trim())) ||
      Object.keys(item).some(
        (key) => !["sessionId", "workspacePath", "workspaceIdentity"].includes(key),
      ) ||
      ids.has(item.sessionId)
    )
      throw ownershipError("invalid or duplicate ownership entry");
    ids.add(item.sessionId);
  }
  return {
    ...manifest,
    sessions: [...manifest.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
  };
}

async function routeManifest(
  manifest: LegacySessionOwnershipManifest,
  paths: Paths,
  resolveSessionDatabase?: SessionDatabaseRouteResolver,
): Promise<LegacySessionOwnershipManifest> {
  if (!resolveSessionDatabase) return manifest;
  const identities = new Map<string, Promise<{ dev: bigint; ino: bigint } | undefined>>();
  const identity = (path: string) => {
    let value = identities.get(path);
    if (!value) {
      value = stat(path, { bigint: true })
        .then((file) => ({ dev: file.dev, ino: file.ino }))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
      identities.set(path, value);
    }
    return value;
  };
  const samePath = async (left: string, right: string) => {
    if (resolve(left) === resolve(right)) return true;
    const [a, b] = await Promise.all([identity(left), identity(right)]);
    if (a && b) return a.dev === b.dev && a.ino === b.ino;
    return (
      process.platform === "win32" && resolve(left).toLowerCase() === resolve(right).toLowerCase()
    );
  };
  const sessions: LegacySessionOwnershipManifest["sessions"] = [];
  for (const session of manifest.sessions) {
    const route = resolveSessionDatabase(session);
    if (!isAbsolute(route.path)) throw ownershipError("database route is not absolute");
    // 路径文本不同不证明分库；显式 symlink/hardlink 仍可能指向同一旧库，须保留严格 ID 验证。
    if (route.explicitlyConfigured) {
      if (await samePath(route.path, paths.sourcePath)) sessions.push(session);
      continue;
    }
    if (!(await samePath(route.path, paths.targetPath)))
      throw ownershipError("default database route changed during preparation");
    sessions.push(session);
  }
  return { ...manifest, sessions };
}
async function upgrade(path: string): Promise<void> {
  const store = await SqliteSessionStore.openStartup({ dbPath: path });
  await store.close();
  await chmod(path, 0o600);
}
function currentIds(path: string): Set<string> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return new Set(
      db
        .prepare("SELECT id FROM schema_migration")
        .all()
        .map((row) => String(row.id)),
    );
  } finally {
    db.close();
  }
}
function validate(path: string, ids: Set<string>): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    validateSchema(db, ids);
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
      throw new Error("SESSION_MIGRATION_CORRUPT: database failed integrity check");
  } finally {
    db.close();
  }
}
type MigrationFaultPhase = "verified" | "retired-main" | "retired-wal" | "activated";
async function activate(
  journal: Journal,
  fault?: (phase: MigrationFaultPhase) => void,
): Promise<void> {
  await assertSourceUnchanged(journal);
  const stage = join(journal.workDir, "stage.sqlite");
  if (!(await targetMatches(journal))) {
    if (!(await targetMatches(journal, stage)))
      throw new Error("SESSION_MIGRATION_VERIFY: activation candidate is not verified");
    if (!journal.stageFingerprint || (await fileFingerprint(stage)) !== journal.stageFingerprint)
      throw new Error("SESSION_MIGRATION_VERIFY: staging database changed after verification");
    const retainedMain = join(journal.workDir, "retired.sqlite");
    if (journal.targetExisted) {
      if (!journal.targetFiles)
        throw new Error("SESSION_MIGRATION_VERIFY: original target fingerprint missing");
      const originalExists = await exists(journal.targetPath);
      if (originalExists && (await exists(retainedMain)))
        throw new Error("SESSION_MIGRATION_CONFLICT: target recreated during activation");
      const originalMain = originalExists ? journal.targetPath : retainedMain;
      const retainedWal = join(journal.workDir, "retired.sqlite-wal");
      const originalWal = (await exists(retainedWal)) ? retainedWal : `${journal.targetPath}-wal`;
      if (
        (await fileFingerprint(originalMain)) !== journal.targetFiles.database ||
        (await walFingerprint(originalWal)) !== journal.targetFiles.wal
      )
        throw new Error("SESSION_MIGRATION_CONFLICT: original target changed after its snapshot");
    } else if (await exists(journal.targetPath))
      throw new Error("SESSION_MIGRATION_CONFLICT: target appeared after preparation");
    await chmod(stage, journal.targetMode ?? 0o600);
    // 先保留旧主库与 sidecars；一致性备份另存。不能让旧 WAL 在新主库激活后重放。
    for (const suffix of ["", "-wal", "-shm"]) {
      const original = `${journal.targetPath}${suffix}`;
      if (await exists(original)) {
        const retained = join(journal.workDir, `retired.sqlite${suffix}`);
        if (await exists(retained))
          throw new Error("SESSION_MIGRATION_CONFLICT: target changed during activation");
        await rename(original, retained);
        if (suffix === "") fault?.("retired-main");
        else if (suffix === "-wal") fault?.("retired-wal");
      }
    }
    await rename(stage, journal.targetPath);
    await syncDirectory(dirname(journal.targetPath));
  } else if (
    !journal.stageFingerprint ||
    (await fileFingerprint(journal.targetPath)) !== journal.stageFingerprint
  )
    throw new Error("SESSION_MIGRATION_VERIFY: activated database changed before completion");
  await assertSourceUnchanged(journal);
}

/** 故障钩子仅由模块测试注入；生产入口不读取测试环境变量。 */
export function createMigrationEngine(testHooks?: {
  fault?: (phase: MigrationFaultPhase) => void;
}): SessionDatabaseMigrationContract {
  return {
    assertReady,
    isPrepared,
    async migrate(
      options: SessionDatabaseMigrationOptions,
    ): Promise<SessionDatabaseMigrationResult> {
      const paths = normalized(options);
      await mkdir(dirname(paths.targetPath), { recursive: true });
      const release = await acquireMigrationLock(paths.targetPath);
      try {
        let journal = await readJson<Journal>(journalPath(paths.targetPath));
        if (journal) {
          assertJournal(journal, paths);
          if (journal.phase === "complete") {
            await assertReady(paths);
            return { status: "already-migrated", importedSessions: journal.importedSessions };
          }
          if (journal.phase === "activating") {
            await options.onProgress?.("activating");
            await activate(journal, testHooks?.fault);
            journal.phase = "complete";
            await durableJson(journalPath(paths.targetPath), journal);
            return { status: journal.status, importedSessions: journal.importedSessions };
          }
        }
        const manifest = await routeManifest(
          parseManifest(await readJson(options.ownershipManifestPath)),
          paths,
          options.resolveSessionDatabase,
        );
        if ((await exists(paths.sourcePath)) && (await exists(paths.targetPath))) {
          const sourceFile = await stat(paths.sourcePath);
          const targetFile = await stat(paths.targetPath);
          if (sourceFile.dev === targetFile.dev && sourceFile.ino === targetFile.ino)
            throw new Error("SESSION_MIGRATION_PATH: source and target alias the same file");
        }
        const manifestFingerprint = fingerprint(manifest);
        if (
          journal?.status === "migrated" &&
          ((await sourceChanged(journal)) ||
            (!journal.sourceFiles && (await exists(join(journal.workDir, "source-backup.sqlite")))))
        ) {
          // 尚未激活的旧尝试只留作审计与恢复，不复用可能过期的 source/target 快照。
          // 新一轮重新验证 Host 归属清单并备份，避免失败期间的旧 CLI 续写被静默遗漏。
          await durableJson(join(journal.workDir, "superseded-attempt.json"), journal);
          journal = undefined;
        }
        if (!journal && !(await exists(paths.sourcePath)) && manifest.sessions.length)
          throw ownershipError("legacy database missing for known sessions");
        if (journal && journal.manifestFingerprint !== manifestFingerprint)
          throw ownershipError("manifest changed during an unfinished migration");
        if (!journal) {
          const id = randomUUID();
          journal = {
            version: 1,
            id,
            ...paths,
            manifestFingerprint,
            phase: "copying",
            workDir: join(dirname(paths.targetPath), ".uwork-session-migration", id),
            importedSessions: 0,
            status: (await exists(paths.sourcePath)) ? "migrated" : "fresh",
            targetExisted: await exists(paths.targetPath),
          };
          await mkdir(journal.workDir, { recursive: true, mode: 0o700 });
          await durableJson(journalPath(paths.targetPath), journal);
        }
        const stage = join(journal.workDir, "stage.sqlite");
        if (journal.phase !== "verified") {
          await options.onProgress?.("copying");
          const reference = join(journal.workDir, "current-schema.sqlite");
          await upgrade(reference);
          const ids = currentIds(reference);
          // 不完整 stage 仅是本次迁移的衍生产物；所有 source/target 快照都保留以便恢复。
          for (const suffix of ["", "-wal", "-shm"]) await rm(`${stage}${suffix}`, { force: true });
          if (journal.targetExisted) {
            const targetBackup = join(journal.workDir, "target-backup.sqlite");
            if (!journal.targetFiles) {
              journal.targetFiles = await targetFiles(paths.targetPath);
              journal.targetMode = (await stat(paths.targetPath)).mode & 0o777;
              await durableJson(journalPath(paths.targetPath), journal);
            }
            if (!(await exists(targetBackup))) {
              if (
                fingerprint(await targetFiles(paths.targetPath)) !==
                fingerprint(journal.targetFiles)
              )
                throw new Error("SESSION_MIGRATION_CONFLICT: target changed before snapshot");
              await snapshot(paths.targetPath, targetBackup);
              if (
                fingerprint(await targetFiles(paths.targetPath)) !==
                fingerprint(journal.targetFiles)
              )
                throw new Error("SESSION_MIGRATION_CONFLICT: target changed during snapshot");
            }
            validate(targetBackup, ids);
            await snapshot(targetBackup, stage);
            await upgrade(stage);
          } else await snapshot(reference, stage);
          const currentReference = new DatabaseSync(reference, { readOnly: true });
          const currentStage = new DatabaseSync(stage, { readOnly: true });
          try {
            assertCurrentColumns(currentStage, currentReference);
          } finally {
            currentStage.close();
            currentReference.close();
          }
          if (journal.status === "migrated") {
            const sourceBackup = join(journal.workDir, "source-backup.sqlite");
            if (!journal.sourceFiles) {
              journal.sourceFiles = await targetFiles(paths.sourcePath);
              await durableJson(journalPath(paths.targetPath), journal);
            }
            await assertSourceUnchanged(journal);
            if (!(await exists(sourceBackup))) await snapshot(paths.sourcePath, sourceBackup);
            await assertSourceUnchanged(journal);
            validate(sourceBackup, ids);
            if (!journal.sourceIdentity) {
              const file = await stat(paths.sourcePath);
              const original = new DatabaseSync(sourceBackup, { readOnly: true });
              try {
                const hasIdentity = original
                  .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='zcode_database_identity'",
                  )
                  .get();
                journal.sourceIdentity = {
                  device: file.dev,
                  inode: file.ino,
                  sqlite: hasIdentity
                    ? original.prepare("SELECT * FROM zcode_database_identity ORDER BY scope").all()
                    : null,
                };
              } finally {
                original.close();
              }
              await durableJson(journalPath(paths.targetPath), journal);
            }
            const upgraded = join(journal.workDir, "source-current.sqlite");
            for (const suffix of ["", "-wal", "-shm"])
              await rm(`${upgraded}${suffix}`, { force: true });
            await snapshot(sourceBackup, upgraded);
            await upgrade(upgraded);
            const source = new DatabaseSync(upgraded, { readOnly: true });
            const target = new DatabaseSync(stage);
            try {
              journal.importedSessions = mergeOwnedRows(source, target, manifest);
            } finally {
              source.close();
              target.close();
            }
          } else if (manifest.sessions.length)
            throw ownershipError("legacy database missing for known sessions");
          await options.onProgress?.("verifying");
          validate(stage, ids);
          const db = new DatabaseSync(stage);
          try {
            if (db.prepare("PRAGMA foreign_key_check").all().length)
              throw new Error("SESSION_MIGRATION_VERIFY: incomplete target references");
            // 位置只留作审计；产品根复制/重定位后仍由不可变迁移 UUID、归属和源身份绑定。
            db.exec(
              `CREATE TABLE IF NOT EXISTS ${markerTable}(id INTEGER PRIMARY KEY CHECK(id=1),migration_id TEXT NOT NULL,source_path TEXT NOT NULL,target_path TEXT NOT NULL,manifest_fingerprint TEXT NOT NULL,source_identity_fingerprint TEXT NOT NULL)`,
            );
            db.prepare(`INSERT INTO ${markerTable} VALUES(1,?,?,?,?,?)`).run(
              journal.id,
              paths.sourcePath,
              paths.targetPath,
              manifestFingerprint,
              fingerprint(journal.sourceIdentity ?? { absent: true }),
            );
            db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
          } finally {
            db.close();
          }
          await chmod(stage, 0o600);
          journal.stageFingerprint = await fileFingerprint(stage);
          journal.phase = "verified";
          await durableJson(journalPath(paths.targetPath), journal);
          testHooks?.fault?.("verified");
        }
        await options.onProgress?.("activating");
        await assertSourceUnchanged(journal);
        journal.phase = "activating";
        await durableJson(journalPath(paths.targetPath), journal);
        await activate(journal, testHooks?.fault);
        testHooks?.fault?.("activated");
        await assertSourceUnchanged(journal);
        journal.phase = "complete";
        await durableJson(journalPath(paths.targetPath), journal);
        return { status: journal.status, importedSessions: journal.importedSessions };
      } finally {
        await release();
      }
    },
  };
}

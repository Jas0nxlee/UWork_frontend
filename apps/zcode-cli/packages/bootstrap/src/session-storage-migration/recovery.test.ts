import {
  copyFile,
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  chmod,
  stat,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import { afterEach, describe, it, expect } from "vitest";
import { createMigrationEngine } from "./engine.js";
import { sessionDatabaseMigration } from "./index.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uwork-migration-recovery-"));
  roots.push(root);
  const sourcePath = join(root, "source.sqlite");
  const targetPath = join(root, "target.sqlite");
  const ownershipManifestPath = join(root, "manifest.json");
  await writeFile(
    ownershipManifestPath,
    JSON.stringify({
      schemaVersion: 1,
      sessions: [{ sessionId: "owned", workspacePath: "/work" }],
    }),
    { mode: 0o600 },
  );
  const store = await SqliteSessionStore.openStartup({ dbPath: sourcePath });
  store.close();
  const source = new DatabaseSync(sourcePath);
  source.exec(
    "INSERT INTO session(id,project_id,workspace_id,slug,directory,title,version,time_created,time_updated) VALUES('owned','p','/work','owned','/work','owned','1',1,2)",
  );
  source.close();
  return { root, sourcePath, targetPath, ownershipManifestPath };
}
async function walTarget(root: string, targetPath: string) {
  const producerPath = join(root, "wal-fixture.sqlite");
  const store = await SqliteSessionStore.openStartup({ dbPath: producerPath });
  store.close();
  const db = new DatabaseSync(producerPath);
  db.exec(
    "PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;INSERT INTO session(id,project_id,workspace_id,slug,directory,title,version,time_created,time_updated) VALUES('existing','other','/target','existing','/target','existing','1',1,2)",
  );
  // 仅构造隔离夹具：写者不再写入时保留完整已提交 WAL 对，再关闭原夹具连接；不是迁移实现。
  try {
    await copyFile(producerPath, targetPath);
    await copyFile(`${producerPath}-wal`, `${targetPath}-wal`);
  } finally {
    db.close();
  }
}
describe("migration error/recovery boundaries", () => {
  it("keeps an unfinished ledger strictly bound to its original target and recovery directory", async () => {
    const f = await fixture();
    await expect(
      createMigrationEngine({
        fault(phase) {
          if (phase === "verified") throw new Error("paused before activation");
        },
      }).migrate(f),
    ).rejects.toThrow("paused before activation");
    const movedRoot = join(f.root, "moved-pending");
    await mkdir(movedRoot);
    const targetPath = join(movedRoot, "db.sqlite");
    await writeFile(
      `${targetPath}.uwork-migration.json`,
      await readFile(`${f.targetPath}.uwork-migration.json`),
      { mode: 0o600 },
    );
    await expect(sessionDatabaseMigration.isPrepared({ ...f, targetPath })).rejects.toThrow(
      /pending migration paths changed/,
    );
    await expect(sessionDatabaseMigration.migrate({ ...f, targetPath })).rejects.toThrow(
      /pending migration paths changed/,
    );
    await expect(stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.skipIf(process.platform === "win32").each(["file", "ancestor"] as const)(
    "does not treat a broken source %s symlink as a fresh installation",
    async (kind) => {
      const f = await fixture();
      await rm(f.sourcePath);
      await writeFile(f.ownershipManifestPath, JSON.stringify({ schemaVersion: 1, sessions: [] }));
      let sourcePath = f.sourcePath;
      if (kind === "file") await symlink(join(f.root, "offline-volume", "db.sqlite"), sourcePath);
      else {
        const link = join(f.root, "broken-library");
        await symlink(join(f.root, "offline-volume"), link, "dir");
        sourcePath = join(link, "cli", "db", "db.sqlite");
      }
      await expect(sessionDatabaseMigration.migrate({ ...f, sourcePath })).rejects.toThrow(
        /SESSION_MIGRATION_PATH/,
      );
      await expect(sessionDatabaseMigration.isPrepared({ ...f, sourcePath })).resolves.toBe(false);
    },
  );
  it("starts a new retained attempt when the source changed after a failed snapshot attempt", async () => {
    const f = await fixture();
    await expect(
      createMigrationEngine({
        fault(phase) {
          if (phase === "verified") throw new Error("stop after snapshot");
        },
      }).migrate(f),
    ).rejects.toThrow("stop after snapshot");
    const previous = JSON.parse(await readFile(`${f.targetPath}.uwork-migration.json`, "utf8"));
    const source = new DatabaseSync(f.sourcePath);
    source.exec(
      "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES('late','owned',3,3,'late source input',0)",
    );
    source.close();
    await sessionDatabaseMigration.migrate(f);
    const current = JSON.parse(await readFile(`${f.targetPath}.uwork-migration.json`, "utf8"));
    expect(current.id).not.toBe(previous.id);
    expect((await stat(join(previous.workDir, "source-backup.sqlite"))).isFile()).toBe(true);
    const target = new DatabaseSync(f.targetPath, { readOnly: true });
    try {
      expect(target.prepare("SELECT id FROM message").all()).toEqual([{ id: "late" }]);
    } finally {
      target.close();
    }
    const later = new DatabaseSync(f.sourcePath);
    later.exec("UPDATE session SET title='legacy later use' WHERE id='owned'");
    later.close();
    await expect(sessionDatabaseMigration.migrate(f)).resolves.toMatchObject({
      status: "already-migrated",
    });
  });
  it.each([false, true])(
    "detects source writes after backup and before activation (WAL: %s)",
    async (wal) => {
      const f = await fixture();
      const source = new DatabaseSync(f.sourcePath);
      source.exec(
        wal ? "PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0" : "PRAGMA journal_mode=DELETE",
      );
      try {
        await expect(
          sessionDatabaseMigration.migrate({
            ...f,
            onProgress: async (phase) => {
              if (phase === "verifying")
                source.exec(
                  "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES('during','owned',3,3,'during snapshot',0)",
                );
            },
          }),
        ).rejects.toThrow(/SOURCE_CHANGED/);
        await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
        await sessionDatabaseMigration.migrate(f);
        const target = new DatabaseSync(f.targetPath, { readOnly: true });
        try {
          expect(target.prepare("SELECT id FROM message").all()).toEqual([{ id: "during" }]);
        } finally {
          target.close();
        }
      } finally {
        source.close();
      }
    },
  );
  it("fails closed if the source changes during partial activation", async () => {
    const f = await fixture();
    await walTarget(f.root, f.targetPath);
    await expect(
      createMigrationEngine({
        fault(phase) {
          if (phase === "retired-main") {
            const source = new DatabaseSync(f.sourcePath);
            try {
              source.exec("UPDATE session SET title='legacy resumed' WHERE id='owned'");
            } finally {
              source.close();
            }
            throw new Error("interrupted after source changed");
          }
        },
      }).migrate(f),
    ).rejects.toThrow("interrupted after source changed");
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/SOURCE_CHANGED/);
    await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
  });
  it.each(["ENOSPC", "EACCES"])(
    "propagates %s without activating and permits a clean retry",
    async (code) => {
      const f = await fixture();
      const before = await readFile(f.sourcePath);
      await expect(
        sessionDatabaseMigration.migrate({
          ...f,
          onProgress: async (phase) => {
            if (phase === "copying")
              throw Object.assign(new Error("injected filesystem failure"), { code });
          },
        }),
      ).rejects.toMatchObject({ code });
      expect(await readFile(f.sourcePath)).toEqual(before);
      await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
      await expect(sessionDatabaseMigration.migrate(f)).resolves.toMatchObject({
        status: "migrated",
        importedSessions: 1,
      });
    },
  );
  it.each(["retired-main", "retired-wal"] as const)(
    "resumes after interruption at %s",
    async (phase) => {
      const f = await fixture();
      await walTarget(f.root, f.targetPath);
      let injected = false;
      await expect(
        createMigrationEngine({
          fault(at) {
            if (at === phase) {
              injected = true;
              throw new Error("injected activation interruption");
            }
          },
        }).migrate(f),
      ).rejects.toThrow("injected activation interruption");
      expect(injected).toBe(true);
      await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
      await expect(sessionDatabaseMigration.migrate(f)).resolves.toMatchObject({
        status: "migrated",
        importedSessions: 1,
      });
      const db = new DatabaseSync(f.targetPath, { readOnly: true });
      try {
        expect(db.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([
          { id: "existing" },
          { id: "owned" },
        ]);
      } finally {
        db.close();
      }
    },
  );
  it.skipIf(process.platform === "win32")(
    "keeps backups/stage/manifest/journal private and preserves the active target mode",
    async () => {
      const f = await fixture();
      const store = await SqliteSessionStore.openStartup({ dbPath: f.targetPath });
      store.close();
      await chmod(f.targetPath, 0o640);
      await sessionDatabaseMigration.migrate({
        ...f,
        onProgress: async (phase) => {
          if (phase !== "activating") return;
          const ledger = JSON.parse(await readFile(`${f.targetPath}.uwork-migration.json`, "utf8"));
          expect((await stat(ledger.workDir)).mode & 0o777).toBe(0o700);
          expect((await stat(`${f.targetPath}.uwork-migration.json`)).mode & 0o777).toBe(0o600);
          expect((await stat(f.ownershipManifestPath)).mode & 0o777).toBe(0o600);
          for (const name of await readdir(ledger.workDir))
            if (name.endsWith(".sqlite"))
              expect((await stat(join(ledger.workDir, name))).mode & 0o777, name).toBe(0o600);
        },
      });
      expect((await stat(f.targetPath)).mode & 0o777).toBe(0o640);
    },
  );
});

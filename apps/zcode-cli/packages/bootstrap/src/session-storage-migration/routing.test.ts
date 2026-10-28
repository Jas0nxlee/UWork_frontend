import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import { createSessionDatabaseRouteResolver } from "../app/session-store.js";
import { createMigrationEngine } from "./engine.js";
import { sessionDatabaseMigration } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uwork-session-route-"));
  roots.push(root);
  const defaultCwd = join(root, "default-project");
  const explicitCwd = join(root, "explicit-project");
  await mkdir(defaultCwd);
  await mkdir(join(explicitCwd, ".zcode"), { recursive: true });
  const sourcePath = join(root, ".zcode", "cli", "db", "db.sqlite");
  const targetPath = join(root, ".uwork", "cli", "db", "db.sqlite");
  const ownershipManifestPath = join(root, "ownership.json");
  const env = {
    HOME: root,
    ZCODE_STORAGE_DIR: join(root, ".uwork"),
    UWORK_SESSION_DB_MIGRATION: "1",
  };
  const store = await SqliteSessionStore.openStartup({ dbPath: sourcePath });
  store.close();
  const db = new DatabaseSync(sourcePath);
  db.prepare(`INSERT INTO session
    (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES ('owned', 'project', 'owned', ?, 'owned', '1', 1, 2)`).run(defaultCwd);
  db.close();
  const sessions = [
    { sessionId: "owned", workspacePath: defaultCwd },
    { sessionId: "explicit-only", workspacePath: explicitCwd },
  ];
  await writeFile(ownershipManifestPath, JSON.stringify({ schemaVersion: 1, sessions }));
  const setExplicit = (path: string) =>
    writeFile(
      join(explicitCwd, ".zcode", "config.json"),
      JSON.stringify({ storage: { sessionDbPath: path } }),
    );
  return {
    root,
    defaultCwd,
    explicitCwd,
    sourcePath,
    targetPath,
    ownershipManifestPath,
    env,
    sessions,
    setExplicit,
  };
}

it("默认路由任务缺席仍失败，不按旧库ID存在性过滤", async () => {
  const f = await fixture();
  await writeFile(
    f.ownershipManifestPath,
    JSON.stringify({
      schemaVersion: 1,
      sessions: [f.sessions[0], { sessionId: "missing-default", workspacePath: f.defaultCwd }],
    }),
  );
  await expect(
    sessionDatabaseMigration.migrate({
      ...f,
      resolveSessionDatabase: createSessionDatabaseRouteResolver(f.env),
    }),
  ).rejects.toMatchObject({ code: "SESSION_MIGRATION_OWNERSHIP" });
  await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
});

it("显式配置仍指向旧源库时必须验证其历史，不能仅按explicit标签排除", async () => {
  const f = await fixture();
  await f.setExplicit(f.sourcePath);
  await expect(
    sessionDatabaseMigration.migrate({
      ...f,
      resolveSessionDatabase: createSessionDatabaseRouteResolver(f.env),
    }),
  ).rejects.toMatchObject({ code: "SESSION_MIGRATION_OWNERSHIP" });
  await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
});

it("显式库只是旧源库的文件别名时仍保留严格归属校验", async () => {
  const f = await fixture();
  const alias = join(f.root, "legacy-alias.sqlite");
  await link(f.sourcePath, alias);
  await f.setExplicit(alias);
  await expect(
    sessionDatabaseMigration.migrate({
      ...f,
      resolveSessionDatabase: createSessionDatabaseRouteResolver(f.env),
    }),
  ).rejects.toMatchObject({ code: "SESSION_MIGRATION_OWNERSHIP" });
  await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
});

it("同一过滤清单换Host临时文件仍可恢复，路由不会写入显式库", async () => {
  const f = await fixture();
  const explicitPath = join(f.explicitCwd, "independent.sqlite");
  await f.setExplicit("./independent.sqlite");
  await writeFile(explicitPath, "EXPLICIT_STORAGE_MUST_NOT_BE_OPENED");
  await expect(
    createMigrationEngine({
      fault(phase) {
        if (phase === "verified") throw new Error("verified interruption");
      },
    }).migrate({ ...f, resolveSessionDatabase: createSessionDatabaseRouteResolver(f.env) }),
  ).rejects.toThrow("verified interruption");
  const nextManifest = join(f.root, "new-host-attempt.json");
  await writeFile(nextManifest, await readFile(f.ownershipManifestPath));
  await expect(
    sessionDatabaseMigration.migrate({
      ...f,
      ownershipManifestPath: nextManifest,
      resolveSessionDatabase: createSessionDatabaseRouteResolver(f.env),
    }),
  ).resolves.toEqual({ status: "migrated", importedSessions: 1 });
  expect(await readFile(explicitPath, "utf8")).toBe("EXPLICIT_STORAGE_MUST_NOT_BE_OPENED");
});

it("所有已知任务明确属于其它库时，缺席的默认旧库可完成fresh准备", async () => {
  const f = await fixture();
  await f.setExplicit("./independent.sqlite");
  await rm(f.sourcePath);
  await writeFile(
    f.ownershipManifestPath,
    JSON.stringify({ schemaVersion: 1, sessions: [f.sessions[1]] }),
  );
  await expect(
    sessionDatabaseMigration.migrate({
      ...f,
      resolveSessionDatabase: createSessionDatabaseRouteResolver(f.env),
    }),
  ).resolves.toEqual({ status: "fresh", importedSessions: 0 });
  await expect(sessionDatabaseMigration.assertReady(f)).resolves.toBeUndefined();
});

it("默认路由出现不同目标时明确失败，不把它当作显式分库证明", async () => {
  const f = await fixture();
  await expect(
    sessionDatabaseMigration.migrate({
      ...f,
      resolveSessionDatabase: () => ({
        path: join(f.root, "unexpected.sqlite"),
        explicitlyConfigured: false,
      }),
    }),
  ).rejects.toMatchObject({ code: "SESSION_MIGRATION_OWNERSHIP" });
});

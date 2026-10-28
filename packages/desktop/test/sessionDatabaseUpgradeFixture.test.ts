import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  addHistory,
  fingerprint,
  historyText,
  ids,
  initializeExplicitDatabase,
  rows,
  seedMembership,
  verifyFrozenSchema,
} from "./fixtures/session-database-upgrade/fixture.mjs";

it("builds old-release owned/foreign/archived/explicit membership with committed WAL history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "packaged-upgrade-fixture-"));
  const source = join(directory, "source.sqlite");
  const host = join(directory, "host.sqlite");
  const cli = new DatabaseSync(source);
  const index = new DatabaseSync(host);
  try {
    cli.exec(
      await readFile(
        new URL("./fixtures/session-database-upgrade/cli-v0.1.2.sql", import.meta.url),
        "utf8",
      ),
    );
    index.exec(
      await readFile(
        new URL("./fixtures/session-database-upgrade/host-v0.1.2.sql", import.meta.url),
        "utf8",
      ),
    );
    index.close();
    cli.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0");
    addHistory(cli, ids.owned, directory);
    addHistory(cli, ids.archived, directory);
    addHistory(cli, ids.foreign, join(directory, "foreign"));
    seedMembership(host, directory, join(directory, "explicit"));
    await verifyFrozenSchema(source, "cli");
    await verifyFrozenSchema(host, "host");
    expect((await fingerprint(source))["-wal"]).not.toBeNull();
    expect(JSON.stringify(rows(source, ids.owned))).toContain(historyText);
    const actual = new DatabaseSync(host, { readOnly: true });
    try {
      expect(actual.prepare("SELECT task_id,archived FROM tasks ORDER BY task_id").all()).toEqual([
        { task_id: ids.archived, archived: 1 },
        { task_id: ids.explicit, archived: 0 },
        { task_id: ids.owned, archived: 0 },
      ]);
      expect(actual.prepare("SELECT root_path FROM project_roots").all()).toEqual([
        { root_path: join(directory, "explicit") },
      ]);
    } finally {
      actual.close();
    }
    cli.exec("CREATE TABLE unexpected_release_drift(id TEXT)");
    await expect(verifyFrozenSchema(source, "cli")).rejects.toThrow(/v0.1.2 schema/);
  } finally {
    if (index.isOpen) index.close();
    cli.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("seeds an explicit database through the real CLI without granting its path to the packaged App", async () => {
  const home = await mkdtemp(join(tmpdir(), "packaged-explicit-seed-"));
  const workspace = join(home, "project");
  const database = join(workspace, "custom-history.sqlite");
  const cli = fileURLToPath(
    new URL("../../../apps/zcode-cli/packages/cli/src/main.ts", import.meta.url),
  );
  const nodeArgs = ["--import", import.meta.resolve("tsx")];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    UWORK_DATA_BASE_DIR: home,
    ZCODE_DATA_BASE_DIR: home,
    UWORK_STORAGE_DIR: join(home, ".uwork"),
    ZCODE_STORAGE_DIR: join(home, ".uwork"),
  };
  for (const key of [
    "NODE_OPTIONS",
    "UWORK_SESSION_DB_MIGRATION",
    "ZCODE_SESSION_DB",
    "ZCODE_SESSION_DB_PATH",
  ])
    delete env[key];
  try {
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({ storage: { sessionDbPath: database } }),
    );
    // 旧夹具在这里调用全局 storage-migrate 后，DatabaseSync 会静默创建无 session 表的空库。
    await initializeExplicitDatabase(cli, database, { cwd: workspace, env, nodeArgs });
    expect(env.ZCODE_SESSION_DB_PATH).toBeUndefined();
    expect(env.UWORK_SESSION_DB_MIGRATION).toBeUndefined();
    const db = new DatabaseSync(database);
    try {
      addHistory(db, ids.explicit, workspace);
    } finally {
      db.close();
    }
    expect(rows(database, ids.explicit).messages).toHaveLength(2);

    // 正式包并不继承 seed 覆盖；配套协议入口须凭实际 .zcode/config.json 识别项目显式路由。
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [...nodeArgs, cli, "app-server", "--stdio", "--prepare-storage", "--cwd", workspace],
        {
          cwd: workspace,
          env: { ...env, UWORK_SESSION_DB_MIGRATION: "1" },
          encoding: "utf8",
          timeout: 30_000,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.end(`${JSON.stringify({ method: "startup/storagePathReady" })}\n`);
    });
    const frames = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames.find((frame) => frame.method === "startup/storagePath").params).toEqual({
      path: database,
    });
    expect(frames.some((frame) => frame.method === "startup/storagePrepared")).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);

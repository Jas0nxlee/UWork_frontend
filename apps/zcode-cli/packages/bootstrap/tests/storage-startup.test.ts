import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConfig } from "@zcode/adapters/config";
import {
  getSessionDbPath,
  resolveLegacySessionDatabaseMigration,
} from "../src/app/session-store.js";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { zcodeStorageStartupStateSchema } from "@zcode/shared";
import { openProtocolStartupStorage } from "../src/zcode-protocol/storage-startup.js";
import { prepareProtocolStartupStorage } from "../src/zcode-protocol/storage-startup.js";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import { runZCodeProtocolAgent } from "../src/zcode-protocol-entrypoint.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
describe("迁移前的 stdio 启动控制帧", () => {
  it("prepare-storage在线程不chdir时按传入cwd读取项目显式数据库配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "uwork-storage-project-cwd-"));
    dirs.push(root);
    const workspace = join(root, "project");
    await mkdir(join(workspace, ".zcode"), { recursive: true });
    await writeFile(
      join(workspace, ".zcode", "config.json"),
      JSON.stringify({
        storage: { sessionDbPath: "./project-history.sqlite" },
      }),
    );
    const input = new PassThrough();
    const paths: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        const frame = JSON.parse(String(chunk));
        if (frame.method === "startup/storagePath") {
          paths.push(frame.params.path);
          input.write('{"method":"startup/storagePathReady"}\n');
        }
        callback();
      },
    });
    await runZCodeProtocolAgent({
      prepareStorageOnly: true,
      cwd: workspace,
      input,
      output,
      env: { HOME: root, ZCODE_STORAGE_DIR: join(root, ".uwork"), UWORK_SESSION_DB_MIGRATION: "1" },
    });
    expect(paths).toEqual([join(workspace, "project-history.sqlite")]);
    await expect(access(paths[0]!)).resolves.toBeUndefined();
  });

  it("旧库在观测和归属ACK后迁移，重复启动不再次要求旧库清单", async () => {
    const root = await mkdtemp(join(tmpdir(), "uwork-storage-upgrade-wire-"));
    dirs.push(root);
    const sourcePath = join(root, "legacy", "db.sqlite");
    const targetPath = join(root, "product", "db.sqlite");
    const sourceStore = await SqliteSessionStore.openStartup({ dbPath: sourcePath });
    sourceStore.close();
    const source = new DatabaseSync(sourcePath);
    source
      .prepare(`INSERT INTO session
      (id, project_id, slug, directory, title, version, time_created, time_updated)
      VALUES ('owned', 'workspace', 'owned', '/workspace', '历史任务', '1', 1, 2)`)
      .run();
    source.close();
    const ownershipManifestPath = join(root, "ownership.json");
    await writeFile(
      ownershipManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        sessions: [{ sessionId: "owned", workspacePath: "/workspace" }],
      }),
    );
    const run = async (withManifest: boolean) => {
      const input = new PassThrough();
      const packets: Array<{ method: string; params: Record<string, unknown> }> = [];
      const output = new Writable({
        write(chunk, _encoding, callback) {
          const frame = JSON.parse(String(chunk));
          packets.push(frame);
          if (frame.method === "startup/storagePath")
            input.write(
              `${JSON.stringify({
                method: "startup/storagePathReady",
                ...(withManifest ? { ownershipManifestPath } : {}),
              })}\n`,
            );
          callback();
        },
      });
      await prepareProtocolStartupStorage({
        dbPath: targetPath,
        input,
        output,
        legacyMigration: { sourcePath, targetPath },
      });
      return packets;
    };
    const first = await run(true);
    expect(first[0]?.params.legacySourcePath).toBe(sourcePath);
    const target = new DatabaseSync(targetPath, { readOnly: true });
    expect(target.prepare("SELECT title FROM session WHERE id='owned'").get()).toMatchObject({
      title: "历史任务",
    });
    target.close();
    const second = await run(false);
    expect(second[0]?.params.legacySourcePath).toBeUndefined();
    expect(second.at(-1)?.method).toBe("startup/storagePrepared");
  });

  it("未提供归属清单时明确失败，不抢先创建空目标库", async () => {
    const root = await mkdtemp(join(tmpdir(), "uwork-storage-no-ownership-"));
    dirs.push(root);
    const targetPath = join(root, "product", "db.sqlite");
    await mkdir(join(root, "legacy"));
    const input = new PassThrough();
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (JSON.parse(String(chunk)).method === "startup/storagePath") {
          input.write('{"method":"startup/storagePathReady"}\n');
        }
        callback();
      },
    });
    await expect(
      prepareProtocolStartupStorage({
        dbPath: targetPath,
        input,
        output,
        legacyMigration: { sourcePath: join(root, "legacy", "db.sqlite"), targetPath },
      }),
    ).rejects.toThrow(/ownership|归属/);
    await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("同路径显式库准备的reuse不能绕过默认迁移账本", async () => {
    const root = await mkdtemp(join(tmpdir(), "uwork-storage-reuse-guard-"));
    dirs.push(root);
    const targetPath = join(root, "product", "db.sqlite");
    const input = new PassThrough();
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (JSON.parse(String(chunk)).method === "startup/storagePath") {
          input.write('{"method":"startup/storagePathReady","reuse":true}\n');
        }
        callback();
      },
    });
    await expect(
      prepareProtocolStartupStorage({
        dbPath: targetPath,
        input,
        output,
        legacyMigration: { sourcePath: join(root, "legacy", "db.sqlite"), targetPath },
      }),
    ).rejects.toThrow(/reuse/);
    await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("真实 Writable 回调完成前不执行 SQL；无账号/Provider 参数也能准备数据库", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-storage-wire-"));
    dirs.push(dir);
    const dbPath = join(dir, "db.sqlite");
    const packets: unknown[] = [];
    let release!: () => void;
    let observed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const output = new Writable({
      write(chunk, _encoding, callback) {
        const packet = JSON.parse(String(chunk));
        packets.push(packet);
        if (
          packet.params.phase === "migrating" &&
          packet.params.migrationId === "0001_base_session_store"
        ) {
          release = () => callback();
          observed();
        } else callback();
      },
    });
    const diagnostics: unknown[] = [];
    const opening = openProtocolStartupStorage({
      dbPath,
      output,
      onProgress: (progress) => {
        diagnostics.push(progress);
      },
    });
    await barrier;
    const reader = new DatabaseSync(dbPath);
    try {
      expect(
        reader.prepare("SELECT 1 FROM sqlite_schema WHERE name='session'").get(),
      ).toBeUndefined();
    } finally {
      reader.close();
      release();
    }
    const store = await opening;
    try {
      const states = packets.map((packet) => {
        const envelope = packet as { method: string; params: unknown };
        expect(envelope.method).toBe("startup/storageState");
        return zcodeStorageStartupStateSchema.parse(envelope.params);
      });
      expect(states.at(-1)?.phase).toBe("ready");
      expect(new Set(states.map((s) => s.attemptId)).size).toBe(1);
      expect(states.map((s) => s.sequence)).toEqual(states.map((_, i) => i + 1));
      expect(JSON.stringify(packets)).not.toContain(dir);
      expect(diagnostics).toEqual(states);
    } finally {
      store.close();
    }
  });
});

describe("默认会话库路径升级的配置门禁", () => {
  it("仅Host标志和默认来源共同允许从legacy库升级", () => {
    const home = join(tmpdir(), "isolated-home");
    const storageRoot = join(tmpdir(), "isolated-storage");
    const env = { HOME: home, ZCODE_STORAGE_DIR: storageRoot, UWORK_SESSION_DB_MIGRATION: "1" };
    const config = createConfig({ skipUserConfig: true, env });
    expect(resolveLegacySessionDatabaseMigration(config, { env })).toEqual({
      sourcePath: join(home, ".zcode", "cli", "db", "db.sqlite"),
      targetPath: join(storageRoot, "cli", "db", "db.sqlite"),
    });
    expect(
      resolveLegacySessionDatabaseMigration(config, {
        env: { ...env, UWORK_SESSION_DB_MIGRATION: "0" },
      }),
    ).toBeUndefined();
    expect(
      resolveLegacySessionDatabaseMigration(config, { env: { HOME: env.HOME } }),
    ).toBeUndefined();
    const explicit = createConfig({
      skipUserConfig: true,
      env,
      cliOverrides: { storage: { sessionDbPath: config.config.storage.sessionDbPath } },
    });
    expect(resolveLegacySessionDatabaseMigration(explicit, { env })).toBeUndefined();
    const unknown = { ...config, sources: { ...config.sources, sessionDb: undefined } };
    expect(resolveLegacySessionDatabaseMigration(unknown, { env })).toBeUndefined();
    const standalone = createConfig({ skipUserConfig: true, env: { HOME: env.HOME } });
    expect(resolveLegacySessionDatabaseMigration(standalone, { env })).toBeUndefined();
  });

  it("路径与legacy候选复用同一注入HOME/cwd，显式相对库保持优先", () => {
    const home = join(tmpdir(), "isolated-home");
    const workingDirectory = join(tmpdir(), "migration-workspace");
    const env = { HOME: home, UWORK_SESSION_DB_MIGRATION: "1" };
    const config = createConfig({
      skipUserConfig: true,
      env,
      cliOverrides: { storage: { sessionDbPath: "~/custom.sqlite" } },
    });
    expect(getSessionDbPath(config, workingDirectory, env)).toBe(join(home, "custom.sqlite"));
    const relative = createConfig({
      skipUserConfig: true,
      env,
      cliOverrides: { storage: { sessionDbPath: "data/session.sqlite" } },
    });
    expect(getSessionDbPath(relative, workingDirectory, env)).toBe(
      join(workingDirectory, "data", "session.sqlite"),
    );
    expect(
      resolveLegacySessionDatabaseMigration(relative, { env, workingDirectory }),
    ).toBeUndefined();
  });
});

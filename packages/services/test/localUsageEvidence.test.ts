import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setDataBaseDir } from "../src/paths.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHasExistingLocalTask,
  hasAnyAgentSessionRow,
  resolveAgentSessionDbPath,
} from "../src/onboarding/localUsageEvidence.js";

/**
 * 老用户使用证据判定（docs/onboarding-record-spec.md §4 2026-10 修订）：
 * tasks-index 是同步器的衍生投影，登录瞬间的判定可能早于回填（线上误弹案例：
 * 空索引把老用户判成新用户）。判定必须 OR 上磁盘级证据；agent 会话证据按 CLI
 * 的解析链定位会话库并查 session 表行数（评审 CR-01：路径有 env/config 覆盖、
 * 默认按 homedir 展开，cli/sessions 是工作流输出目录不得作为证据）；证据"读
 * 不了"（非 ENOENT）不得当成"没有"，必须上抛由 UI 保守判不弹（评审 CR-02）。
 */

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "onboarding-usage-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setDataBaseDir(null);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFactory(
  indexTasks: unknown[],
  hasAgentSessionRow: boolean,
  legacySessionsDir: string,
) {
  return createHasExistingLocalTask({
    listIndexTasks: vi.fn(async () => indexTasks),
    hasAgentSessionRow: vi.fn(async () => hasAgentSessionRow),
    resolveLegacyTaskSessionsDir: () => legacySessionsDir,
  });
}

function createSessionDb(dbPath: string, rows: number): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE session (id TEXT)");
  const insert = db.prepare("INSERT INTO session (id) VALUES (?)");
  for (let i = 0; i < rows; i += 1) insert.run(`s${i}`);
  db.close();
}

describe("createHasExistingLocalTask", () => {
  it("索引有行即存量用户（短路，不查会话库）", async () => {
    const emptyDir = makeTempDir();
    const check = createFactory([{ id: "t1" }], false, emptyDir);
    await expect(check()).resolves.toBe(true);
  });

  it("索引为空但 agent 会话库有行 → 存量用户（索引回填时序缺陷的回归）", async () => {
    const emptyDir = makeTempDir();
    const check = createFactory([], true, emptyDir);
    await expect(check()).resolves.toBe(true);
  });

  it("索引与会话库皆空，旧版任务快照非空 → 存量用户", async () => {
    const legacySessionsDir = makeTempDir();
    writeFileSync(join(legacySessionsDir, "task-1.json"), "{}");
    writeFileSync(join(legacySessionsDir, "task-2.deleted.json"), "{}");
    const check = createFactory([], false, legacySessionsDir);
    await expect(check()).resolves.toBe(true);
  });

  it("三源全空（目录不存在/为空）→ 新用户", async () => {
    const check = createFactory([], false, join(makeTempDir(), "not-exist"));
    await expect(check()).resolves.toBe(false);
    const emptyDir = makeTempDir();
    const checkEmpty = createFactory([], false, emptyDir);
    await expect(checkEmpty()).resolves.toBe(false);
  });

  it("索引查询异常时上抛，由上层保守判不弹", async () => {
    const check = createHasExistingLocalTask({
      listIndexTasks: vi.fn(async () => {
        throw new Error("index db locked");
      }),
      hasAgentSessionRow: vi.fn(async () => true),
      resolveLegacyTaskSessionsDir: () => makeTempDir(),
    });
    await expect(check()).rejects.toThrow("index db locked");
  });
});

describe("hasAnyAgentSessionRow", () => {
  it("session 表有行 → true", async () => {
    const dbPath = join(makeTempDir(), "db.sqlite");
    createSessionDb(dbPath, 2);
    await expect(hasAnyAgentSessionRow(dbPath)).resolves.toBe(true);
  });

  it("session 表存在但为空 → false（空库不得误判存量）", async () => {
    const dbPath = join(makeTempDir(), "db.sqlite");
    createSessionDb(dbPath, 0);
    await expect(hasAnyAgentSessionRow(dbPath)).resolves.toBe(false);
  });

  it("库文件存在但无 session 表 → false", async () => {
    const dbPath = join(makeTempDir(), "db.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE other (a TEXT)");
    db.close();
    await expect(hasAnyAgentSessionRow(dbPath)).resolves.toBe(false);
  });

  it("库文件不存在（ENOENT）→ false", async () => {
    await expect(
      hasAnyAgentSessionRow(join(makeTempDir(), "not-exist", "db.sqlite")),
    ).resolves.toBe(false);
  });

  it("WAL 未 checkpoint 的行对只读连接可见（写连接保持打开）", async () => {
    // 评审 SG-01：模拟 CLI 持有写连接、行还在 WAL 中未合并的真实场景——
    // 这正是线上误弹案例里"判定时刻数据在 WAL"的形态。
    const dbPath = join(makeTempDir(), "db.sqlite");
    const writer = new DatabaseSync(dbPath);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.exec("PRAGMA wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE session (id TEXT)");
    writer.prepare("INSERT INTO session (id) VALUES (?)").run("s1");
    try {
      await expect(hasAnyAgentSessionRow(dbPath)).resolves.toBe(true);
    } finally {
      writer.close();
    }
  });

  // Windows libuv 把 ENOTDIR 归一化为 ENOENT，该分支在 POSIX CI 上验证；
  // Windows 下同一语义由"库文件损坏 → 上抛"用例覆盖。
  (process.platform === "win32" ? it.skip : it)(
    "父路径是文件（ENOTDIR）→ 上抛而非静默无证据（评审 CR-02 回归）",
    async () => {
      const filePath = join(makeTempDir(), "occupied");
      writeFileSync(filePath, "not a dir");
      await expect(hasAnyAgentSessionRow(join(filePath, "db.sqlite"))).rejects.toThrow();
    },
  );

  it("库文件损坏 → 上抛（读不了 ≠ 没有，交由 UI 保守判不弹）", async () => {
    const dbPath = join(makeTempDir(), "db.sqlite");
    writeFileSync(dbPath, "definitely not a sqlite file");
    await expect(hasAnyAgentSessionRow(dbPath)).rejects.toThrow();
  });
});

describe("resolveAgentSessionDbPath（评审三轮 CR-01：不复制解析规则，无法确定按未知跳过）", () => {
  async function onWindows<T>(run: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    try {
      return await run();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  }

  it.each(["env", "config"] as const)(
    "Windows %s 的 ~/ 显式库使用 USERPROFILE，不借 managed HOME 改写",
    async (source) => {
      const base = makeTempDir();
      const storageHome = join(base, "managed-home");
      const platformHome = join(base, "profile-home");
      const readConfigFile = vi.fn(async () =>
        JSON.stringify({ storage: { sessionDbPath: "~/history.sqlite" } }),
      );
      const env = {
        HOME: storageHome,
        USERPROFILE: platformHome,
        ...(source === "env" ? { ZCODE_SESSION_DB_PATH: "~/history.sqlite" } : {}),
      };
      await onWindows(async () => {
        await expect(resolveAgentSessionDbPath({ env, readConfigFile })).resolves.toBe(
          join(platformHome, "history.sqlite"),
        );
      });
      if (source === "env") expect(readConfigFile).not.toHaveBeenCalled();
      else
        expect(readConfigFile).toHaveBeenCalledWith(
          join(storageHome, ".uwork", "cli", "config.json"),
        );
    },
  );

  it("Windows 的 managed 默认根、Source Server 注入默认与显式 homedir 注入保持各自边界", async () => {
    const base = makeTempDir();
    const storageHome = join(base, "managed-home");
    const platformHome = join(base, "profile-home");
    const injectedHome = join(base, "injected-home");
    const legacyDefault = join(platformHome, ".zcode", "cli", "db", "db.sqlite");
    const env = { HOME: storageHome, USERPROFILE: platformHome };
    const readConfigFile = vi.fn(async () => "{}");
    await onWindows(async () => {
      await expect(resolveAgentSessionDbPath({ env, readConfigFile })).resolves.toBe(
        join(storageHome, ".uwork", "cli", "db", "db.sqlite"),
      );
      await expect(
        resolveAgentSessionDbPath({ env, readConfigFile, defaultSessionDbPath: legacyDefault }),
      ).resolves.toBe(legacyDefault);
      await expect(
        resolveAgentSessionDbPath({
          env,
          homedirPath: injectedHome,
          readConfigFile: async (path) => {
            expect(path).toBe(join(injectedHome, ".uwork", "cli", "config.json"));
            return JSON.stringify({ storage: { sessionDbPath: "~/history.sqlite" } });
          },
        }),
      ).resolves.toBe(join(injectedHome, "history.sqlite"));
    });
  });

  it("未升级宿主可注入旧默认库，但显式env和配置继续优先", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    const legacyDefault = join(HOME, ".zcode", "cli", "db", "db.sqlite");
    const fromConfig = join(HOME, "configured.sqlite");
    const fromEnv = join(HOME, "environment.sqlite");
    const options = { env: {}, homedirPath: HOME, defaultSessionDbPath: legacyDefault };
    await expect(resolveAgentSessionDbPath(options)).resolves.toBe(legacyDefault);
    mkdirSync(join(USER_CONFIG, ".."), { recursive: true });
    writeFileSync(USER_CONFIG, JSON.stringify({ storage: { sessionDbPath: fromConfig } }));
    await expect(resolveAgentSessionDbPath(options)).resolves.toBe(fromConfig);
    await expect(
      resolveAgentSessionDbPath({ ...options, env: { ZCODE_SESSION_DB_PATH: fromEnv } }),
    ).resolves.toBe(fromEnv);
    writeFileSync(USER_CONFIG, JSON.stringify({ storage: { sessionDbPath: "relative.sqlite" } }));
    await expect(resolveAgentSessionDbPath(options)).resolves.toBeNull();
  });

  function freshHome(): { HOME: string; USER_CONFIG: string } {
    const HOME = join(makeTempDir(), "home");
    setDataBaseDir(HOME);
    vi.stubEnv("ZCODE_STORAGE_DIR", "");
    return { HOME, USER_CONFIG: join(HOME, ".uwork", "cli", "config.json") };
  }

  it("env 单别名：绝对路径原样可用", async () => {
    const customDb = join(makeTempDir(), "custom.sqlite");
    const { HOME, USER_CONFIG } = freshHome();
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_SESSION_DB_PATH: customDb },
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
      }),
    ).resolves.toBe(customDb);
  });

  it("env ~/ 值按 homedir 展开", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_SESSION_DB: "~/session-alt.sqlite" },
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
      }),
    ).resolves.toBe(join(HOME, "session-alt.sqlite"));
  });

  it("双别名并存按 env 键序取后者（与 CLI env adapter 覆盖顺序一致）", async () => {
    const dbA = join(makeTempDir(), "a.sqlite");
    const dbB = join(makeTempDir(), "b.sqlite");
    const { HOME, USER_CONFIG } = freshHome();
    // PATH 别名后出现 → PATH 胜出
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_SESSION_DB: dbA, ZCODE_SESSION_DB_PATH: dbB },
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
      }),
    ).resolves.toBe(dbB);
    // 交换插入顺序 → DB 别名胜出（固定优先级会在这里产生偏差，评审实证）
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_SESSION_DB_PATH: dbB, ZCODE_SESSION_DB: dbA },
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
      }),
    ).resolves.toBe(dbA);
  });

  it("env 相对路径 → null（CLI 按工作区 cwd 解析，host 无法镜像）", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_SESSION_DB_PATH: "history/session.sqlite" },
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
      }),
    ).resolves.toBeNull();
  });

  it("user config（home 默认位置）storage.sessionDbPath 覆盖，~/ 展开", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    mkdirSync(join(HOME, ".uwork", "cli"), { recursive: true });
    writeFileSync(USER_CONFIG, JSON.stringify({ storage: { sessionDbPath: "~/data/s.sqlite" } }));
    await expect(
      resolveAgentSessionDbPath({ env: {}, homedirPath: HOME, userConfigPath: USER_CONFIG }),
    ).resolves.toBe(join(HOME, "data", "s.sqlite"));
  });

  it("user config 相对路径 → null（不按 host cwd 猜测）", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    mkdirSync(join(HOME, ".uwork", "cli"), { recursive: true });
    writeFileSync(USER_CONFIG, JSON.stringify({ storage: { sessionDbPath: "db/rel.sqlite" } }));
    await expect(
      resolveAgentSessionDbPath({ env: {}, homedirPath: HOME, userConfigPath: USER_CONFIG }),
    ).resolves.toBeNull();
  });

  it("user config 不存在 → 与新版 writer 一致的有效 CLI 根会话库", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    await expect(
      resolveAgentSessionDbPath({ env: {}, homedirPath: HOME, userConfigPath: USER_CONFIG }),
    ).resolves.toBe(join(HOME, ".uwork", "cli", "db", "db.sqlite"));
  });

  it("默认 userConfigPath 使用产品根，不读取同一 home 中的上游配置", async () => {
    const { HOME } = freshHome();
    const readPaths: string[] = [];
    await resolveAgentSessionDbPath({
      env: {},
      homedirPath: HOME,
      readConfigFile: async (path) => {
        readPaths.push(path);
        return "{}";
      },
    });
    expect(readPaths).toEqual([join(HOME, ".uwork", "cli", "config.json")]);
  });

  it("产品配置和上游配置并存时只读取产品配置，缺失时使用 writer 默认库", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    const upstreamConfig = join(HOME, ".zcode", "cli", "config.json");
    const productDb = join(HOME, "product.sqlite");
    const upstreamDb = join(HOME, "upstream.sqlite");
    for (const config of [USER_CONFIG, upstreamConfig]) {
      mkdirSync(join(config, ".."), { recursive: true });
    }
    writeFileSync(USER_CONFIG, JSON.stringify({ storage: { sessionDbPath: productDb } }));
    writeFileSync(upstreamConfig, JSON.stringify({ storage: { sessionDbPath: upstreamDb } }));
    createSessionDb(productDb, 1);
    createSessionDb(upstreamDb, 1);
    await expect(resolveAgentSessionDbPath({ env: {}, homedirPath: HOME })).resolves.toBe(
      productDb,
    );
    rmSync(USER_CONFIG);
    const emptyProductDb = await resolveAgentSessionDbPath({ env: {}, homedirPath: HOME });
    expect(emptyProductDb).toBe(join(HOME, ".uwork", "cli", "db", "db.sqlite"));
    await expect(hasAnyAgentSessionRow(emptyProductDb!)).resolves.toBe(false);
  });

  it("显式注入 CLI storage root 隔离配置，默认会话库同样跟随该根", async () => {
    const { HOME } = freshHome();
    const storageRoot = join(makeTempDir(), "external-storage");
    vi.stubEnv("ZCODE_STORAGE_DIR", join(makeTempDir(), "other-process-storage"));
    const configPath = join(storageRoot, "cli", "config.json");
    mkdirSync(join(storageRoot, "cli"), { recursive: true });
    writeFileSync(configPath, "{}");
    const readPaths: string[] = [];
    await expect(
      resolveAgentSessionDbPath({
        env: { ZCODE_STORAGE_DIR: storageRoot },
        homedirPath: HOME,
        readConfigFile: async (path) => {
          readPaths.push(path);
          return "{}";
        },
      }),
    ).resolves.toBe(join(storageRoot, "cli", "db", "db.sqlite"));
    expect(readPaths).toEqual([configPath]);
  });

  it.each(["home", "env"] as const)("%s 注入不使用进程全局的另一个配置根", async (source) => {
    const isolatedHome = join(makeTempDir(), "isolated-home");
    const processRoot = join(makeTempDir(), "process-storage");
    vi.stubEnv("ZCODE_STORAGE_DIR", processRoot);
    const readPaths: string[] = [];
    const options =
      source === "home" ? { homedirPath: isolatedHome } : { env: { HOME: isolatedHome } };
    await expect(
      resolveAgentSessionDbPath({
        ...options,
        readConfigFile: async (path) => {
          readPaths.push(path);
          return "{}";
        },
      }),
    ).resolves.toBe(join(isolatedHome, ".uwork", "cli", "db", "db.sqlite"));
    expect(readPaths).toEqual([join(isolatedHome, ".uwork", "cli", "config.json")]);
  });

  it("user config 非 ENOENT 读取失败 → 上抛", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    const eaccs = Object.assign(new Error("read denied"), { code: "EACCES" });
    await expect(
      resolveAgentSessionDbPath({
        env: {},
        homedirPath: HOME,
        userConfigPath: USER_CONFIG,
        readConfigFile: async () => {
          throw eaccs;
        },
      }),
    ).rejects.toThrow(eaccs);
  });

  it("user config 非法 JSON → 上抛", async () => {
    const { HOME, USER_CONFIG } = freshHome();
    mkdirSync(join(HOME, ".uwork", "cli"), { recursive: true });
    writeFileSync(USER_CONFIG, "{broken json");
    await expect(
      resolveAgentSessionDbPath({ env: {}, homedirPath: HOME, userConfigPath: USER_CONFIG }),
    ).rejects.toThrow();
  });
});

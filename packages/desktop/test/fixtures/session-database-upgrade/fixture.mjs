import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ids = Object.freeze({
  owned: "session_packaged_upgrade_owned",
  archived: "session_packaged_upgrade_archived",
  foreign: "session_packaged_upgrade_foreign",
  explicit: "session_packaged_upgrade_explicit",
  afterUpgrade: "session_packaged_upgrade_new",
});
export const historyText = "PACKAGED_UPGRADE_012_PRESERVED_ASSISTANT_HISTORY";
export const explicitHistoryText = "PACKAGED_UPGRADE_EXPLICIT_HISTORY";
export const historyTitle = "PACKAGED_UPGRADE_012_HISTORY";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exec = promisify(execFile);

export function createPackagedUpgradeEnvironment(baseEnv, data, platform) {
  const env = {
    ...baseEnv,
    // Windows 旧 Node home 由 USERPROFILE 决定；不同 HOME 必须由真实发布包门禁覆盖。
    HOME: platform === "win" ? join(data, "alternate-home") : data,
    USERPROFILE: data,
    UWORK_DATA_BASE_DIR: data,
    ZCODE_DATA_BASE_DIR: data,
    UWORK_STORAGE_DIR: join(data, ".uwork"),
    ZCODE_STORAGE_DIR: join(data, ".uwork"),
    ZCODE_LOG_DIR: join(data, ".uwork", "cli", "log"),
    ZCODE_DESKTOP_HOME_DIR: data,
    ZCODE_DESKTOP_USER_DATA_DIR: join(data, "userData"),
    ZCODE_DESKTOP_SESSION_DATA_DIR: join(data, "sessionData"),
  };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "UWORK_SESSION_DB_MIGRATION",
    "ZCODE_SESSION_DB_PATH",
    "ZCODE_SESSION_DB",
    "ZCODE_AGENT_SERVER_COMMAND",
    "ZCODE_AGENT_SERVER_ARGS_JSON",
    "ZCODE_AGENT_SERVER_CWD",
    "GLM_BINARY_PATH",
    "ZCODE_AGENT_WORKDIR",
    "ZCODE_HOME",
  ])
    delete env[key];
  return env;
}

export async function initializeExplicitDatabase(cli, path, { cwd, env, nodeArgs = [] }) {
  // storage-migrate 是全局维护命令，不传 workspace 给 createConfig；只有夹具 seed 单独指定库。
  // 正式 App 继续使用未注入 DB path 的原 env，项目路由由其配套 prepare-storage 自行解析。
  await exec(process.execPath, [...nodeArgs, cli, "storage-migrate"], {
    cwd,
    env: { ...env, ZCODE_SESSION_DB_PATH: path },
    timeout: 60_000,
  });
  // DatabaseSync 默认会创建空文件，必须先证实子进程生成了完整旧 schema，不能把夹具缺陷伪装成产品失败。
  await access(path);
  await verifyFrozenSchema(path, "cli");
}

export async function verifyFrozenSchema(path, role) {
  const origin = JSON.parse(await readFile(new URL("./origin.json", import.meta.url), "utf8"));
  const description = origin.schemas[role];
  assert.equal(origin.version, "0.1.2");
  const sql = await readFile(new URL(description.file, import.meta.url));
  assert.equal(hash(sql), description.sha256, "Frozen old-release schema was changed");
  const expected = new DatabaseSync(":memory:");
  const actual = new DatabaseSync(path, { readOnly: true });
  const schema = (db) =>
    db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all()
      .map((row) => {
        // 账本 bootstrap 与冻结 SQL 的标识符引号/类型大小写不同，按 SQLite 实际列契约比较。
        if (["schema_migration", "tasks_schema_migration"].includes(row.name))
          return {
            ...row,
            sql: undefined,
            columns: db
              .prepare(`PRAGMA table_info("${row.name}")`)
              .all()
              .map((column) => ({ ...column, type: String(column.type).toUpperCase() })),
          };
        return { ...row, sql: row.sql?.replace(/\s+/g, " ").trim() };
      });
  try {
    expected.exec(sql.toString("utf8"));
    assert.deepEqual(
      schema(actual),
      schema(expected),
      `${role} fixture no longer has the v0.1.2 schema`,
    );
  } finally {
    actual.close();
    expected.close();
  }
}

export function addHistory(db, sessionId, workspacePath, text = historyText) {
  const time = 1_790_000_000_000;
  db.prepare(`INSERT INTO session (
    id,project_id,workspace_id,parent_id,slug,directory,path,title,version,
    time_created,time_updated,title_source,last_outcome
  ) VALUES (?,?,NULL,NULL,?,?,?,?,?,?,?,'custom','completed')`).run(
    sessionId,
    `project_${sessionId}`,
    sessionId,
    workspacePath,
    workspacePath,
    sessionId === ids.owned ? historyTitle : sessionId,
    "0.1.2-fixture",
    time,
    time + 100,
  );
  const userId = `message_user_${sessionId}`;
  const assistantId = `message_assistant_${sessionId}`;
  const put = db.prepare(
    "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence)VALUES(?,?,?,?,?,?)",
  );
  put.run(
    userId,
    sessionId,
    time,
    time,
    JSON.stringify({
      role: "user",
      agent: "zcode-agent",
      content: "PACKAGED_UPGRADE_012_QUESTION",
      time: { created: time },
      model: { providerID: "fixture-unavailable", modelID: "fixture-model" },
    }),
    1,
  );
  put.run(
    assistantId,
    sessionId,
    time + 1,
    time + 100,
    JSON.stringify({
      role: "assistant",
      agent: "zcode-agent",
      content: text,
      parentID: userId,
      providerID: "fixture-unavailable",
      modelID: "fixture-model",
      mode: "build",
      finish: "stop",
      cost: 0,
      time: { created: time + 1, completed: time + 100 },
      path: { cwd: workspacePath, root: workspacePath },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    2,
  );
  const part = db.prepare(
    "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data)VALUES(?,?,?,?,?,?)",
  );
  for (const [messageId, body] of [
    [userId, "PACKAGED_UPGRADE_012_QUESTION"],
    [assistantId, text],
  ])
    part.run(
      `part_${messageId}`,
      messageId,
      sessionId,
      time,
      time + 100,
      JSON.stringify({ type: "text", text: body, time: { start: time, end: time + 100 } }),
    );
}

export function seedMembership(path, workspace, explicitWorkspace) {
  const db = new DatabaseSync(path);
  const now = 1_790_000_000_000;
  try {
    db.prepare("INSERT OR IGNORE INTO hosts(host_id,kind,position)VALUES('local','local',0)").run();
    db.prepare(
      "INSERT INTO projects(project_id,host_id,name,position,created_at,updated_at)VALUES('packaged-explicit','local','Packaged explicit',900,?,?)",
    ).run(now, now);
    db.prepare(
      "INSERT INTO project_roots(project_id,root_path,position,is_primary)VALUES('packaged-explicit',?,0,1)",
    ).run(explicitWorkspace);
    const put = db.prepare(`INSERT INTO tasks (
      workspace_key,workspace_path,task_id,title,task_status,provider,mode,model,
      created_at,updated_at,archived,meta_json,host_id,root_path,project_id,handoff_pending,cli_created_at,cli_updated_at,cli_title,cli_title_source,cli_last_outcome
    )VALUES(?,?,?,?,'completed','glm','default','fixture-model',?,?,?,?,'local',?,?,8,?,?,?,'custom','completed')`);
    for (const [id, path, archived, project] of [
      [ids.owned, workspace, 0, null],
      [ids.archived, workspace, 1, null],
      [ids.explicit, explicitWorkspace, 0, "packaged-explicit"],
    ]) {
      const title = id === ids.owned ? historyTitle : id;
      put.run(
        path,
        path,
        id,
        title,
        now,
        now + 100,
        archived,
        JSON.stringify({
          taskId: id,
          workspacePath: path,
          provider: "glm",
          status: "completed",
          title,
        }),
        // v0.1.2 已完成归属的行由 root_path 固化 cwd；缺席会被项目投影读成字符串 "null"。
        path,
        project,
        now,
        now + 100,
        title,
      );
    }
  } finally {
    db.close();
  }
}

export function rows(path, id) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      messages: db.prepare("SELECT * FROM message WHERE session_id=? ORDER BY id").all(id),
      parts: db.prepare("SELECT * FROM part WHERE session_id=? ORDER BY id").all(id),
    };
  } finally {
    db.close();
  }
}

export async function fingerprint(path) {
  const result = {};
  for (const suffix of ["", "-wal"])
    result[suffix || "main"] = await readFile(`${path}${suffix}`)
      .then(hash)
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
  return result;
}

import {
  mkdtemp,
  writeFile,
  mkdir,
  readFile,
  rm,
  link,
  symlink,
  copyFile,
  cp,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import { sessionDatabaseMigration } from "./index.js";
import { createMigrationEngine } from "./engine.js";
import { mergeOwnedRows } from "./rows.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uwork-session-migration-"));
  roots.push(root);
  const paths = {
    sourcePath: join(root, "source.sqlite"),
    targetPath: join(root, "target.sqlite"),
    ownershipManifestPath: join(root, "ownership.json"),
  };
  await writeFile(
    paths.ownershipManifestPath,
    JSON.stringify({
      schemaVersion: 1,
      sessions: [{ sessionId: "owned", workspacePath: "/work" }],
    }),
  );
  return { root, ...paths };
}
async function database(path: string) {
  const s = await SqliteSessionStore.openStartup({ dbPath: path });
  s.close();
  return new DatabaseSync(path);
}
function session(db: DatabaseSync, id: string, parent: string | null = null, cwd = "/work") {
  db.prepare(
    "INSERT INTO session(id,project_id,workspace_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?,1,2)",
  ).run(id, cwd === "/work" ? "project-work" : `project-${cwd}`, cwd, parent, id, cwd, id, "1");
}
function insert(db: DatabaseSync, table: string, row: Record<string, string | number | null>) {
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table}(${columns.join(",")})VALUES(${columns.map(() => "?").join(",")})`,
  ).run(...Object.values(row));
}
describe("session database path migration", () => {
  it("accepts a byte-identical completed ledger beside a moved database without consulting historical paths", async () => {
    const f = await fixture();
    const source = await database(f.sourcePath);
    session(source, "owned");
    source.close();
    await sessionDatabaseMigration.migrate(f);
    const active = new DatabaseSync(f.targetPath);
    session(active, "new-after-upgrade", null, "/new");
    active.close();
    const ledgerBytes = await readFile(`${f.targetPath}.uwork-migration.json`);
    const ledger = JSON.parse(ledgerBytes.toString("utf8"));
    const relocated = join(f.root, "opaque-copy");
    await mkdir(relocated);
    const targetPath = join(relocated, "db.sqlite");
    await copyFile(f.targetPath, targetPath);
    await writeFile(`${targetPath}.uwork-migration.json`, ledgerBytes, { mode: 0o600 });
    await rm(f.sourcePath);
    await rm(f.ownershipManifestPath);
    await rm(f.targetPath);
    await rm(ledger.workDir, { recursive: true });
    const moved = { ...f, targetPath };
    await expect(sessionDatabaseMigration.isPrepared(moved)).resolves.toBe(true);
    await expect(sessionDatabaseMigration.migrate(moved)).resolves.toEqual({
      status: "already-migrated",
      importedSessions: 1,
    });
    expect(await readFile(`${targetPath}.uwork-migration.json`)).toEqual(ledgerBytes);
    const db = new DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([
        { id: "new-after-upgrade" },
        { id: "owned" },
      ]);
    } finally {
      db.close();
    }
    const unmarkedPath = join(relocated, "unmarked.sqlite");
    (await database(unmarkedPath)).close();
    await writeFile(`${unmarkedPath}.uwork-migration.json`, ledgerBytes, { mode: 0o600 });
    await expect(
      sessionDatabaseMigration.isPrepared({ ...f, targetPath: unmarkedPath }),
    ).rejects.toThrow(/VERIFY/);
  });
  it("keeps a completed migration valid after copying the product root and relocating only the journal", async () => {
    const f = await fixture();
    const source = await database(f.sourcePath);
    session(source, "owned");
    source.close();
    await sessionDatabaseMigration.migrate(f);
    const active = new DatabaseSync(f.targetPath);
    session(active, "created-after-upgrade", null, "/new");
    active.close();
    const relocated = join(f.root, "new-product-root");
    await mkdir(relocated);
    const targetPath = join(relocated, "target.sqlite");
    await copyFile(f.targetPath, targetPath);
    const ledger = JSON.parse(await readFile(`${f.targetPath}.uwork-migration.json`, "utf8"));
    const workDir = join(relocated, ".uwork-session-migration", ledger.id);
    await cp(ledger.workDir, workDir, { recursive: true });
    await writeFile(
      `${targetPath}.uwork-migration.json`,
      JSON.stringify({ ...ledger, targetPath, workDir }),
      { mode: 0o600 },
    );
    await rm(f.sourcePath);
    await rm(f.ownershipManifestPath);
    const moved = { ...f, targetPath };
    await expect(sessionDatabaseMigration.isPrepared(moved)).resolves.toBe(true);
    await expect(sessionDatabaseMigration.migrate(moved)).resolves.toEqual({
      status: "already-migrated",
      importedSessions: 1,
    });
    const db = new DatabaseSync(targetPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([
        { id: "created-after-upgrade" },
        { id: "owned" },
      ]);
    } finally {
      db.close();
    }
  });
  it("projects only ownership columns when caching relations with large foreign payloads", async () => {
    const f = await fixture();
    const source = await database(f.sourcePath);
    session(source, "owned");
    session(source, "foreign", null, "/foreign");
    const payload = "x".repeat(2_000_000);
    source
      .prepare("UPDATE session SET summary_diffs=?,revert=? WHERE id='foreign'")
      .run(payload, payload);
    insert(source, "workflow_run", {
      id: "foreign-run",
      name: "foreign",
      parent_session_id: "foreign",
      cwd: "/foreign",
      script_hash: "hash",
      status: "completed",
      args_json: payload,
      time_created: 1,
      time_updated: 2,
    });
    const target = await database(f.targetPath);
    const prepare = source.prepare.bind(source);
    vi.spyOn(source, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (
        /^SELECT \* FROM "(?:session|workflow_run|workflow_activity|session_task_link|dwf_run|dwf_actor)"$/i.test(
          sql,
        )
      )
        vi.spyOn(statement, "all").mockImplementation(() => {
          throw new Error("relation cache must not load full payload rows");
        });
      return statement;
    });
    try {
      expect(
        mergeOwnedRows(source, target, {
          schemaVersion: 1,
          sessions: [{ sessionId: "owned", workspacePath: "/work" }],
        }),
      ).toBe(1);
    } finally {
      source.close();
      target.close();
    }
  });
  it.each(["history", "permission", "project-setting", "workspace-setting"])(
    "fails closed for ambiguous shared %s with foreign sessions in the same scope",
    async (table) => {
      const f = await fixture();
      const db = await database(f.sourcePath);
      session(db, "owned");
      session(db, "foreign");
      if (table === "history")
        insert(db, "input_history", {
          id: "foreign-input",
          project_id: "project-work",
          session_id: null,
          text: "another product raw input",
          kind: "text",
          time_created: 1,
        });
      else if (table === "permission")
        insert(db, "permission", {
          project_id: "project-work",
          data: "{}",
          time_created: 1,
          time_updated: 1,
        });
      else
        insert(db, "local_setting", {
          scope: table === "project-setting" ? "project" : "workspace",
          scope_id: table === "project-setting" ? "project-work" : "/work",
          namespace: "permission",
          key: "rules",
          value: "{}",
          schema_version: 1,
          time_created: 1,
          time_updated: 1,
        });
      db.close();
      await expect(sessionDatabaseMigration.migrate(f)).rejects.toMatchObject({
        code: "SESSION_MIGRATION_OWNERSHIP",
        kind: "ownership",
      });
      await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
    },
  );
  it.each(["hardlink", "symlink"] as const)(
    "rejects source/target aliases via %s",
    async (kind) => {
      if (kind === "symlink" && process.platform === "win32") return;
      const f = await fixture();
      const db = await database(f.sourcePath);
      session(db, "owned");
      db.close();
      if (kind === "hardlink") await link(f.sourcePath, f.targetPath);
      else await symlink(f.sourcePath, f.targetPath);
      const before = await readFile(f.sourcePath);
      await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/alias/);
      expect(await readFile(f.sourcePath)).toEqual(before);
    },
  );
  it.each([false, true])(
    "refuses target changes after snapshot (uncheckpointed WAL: %s)",
    async (wal) => {
      const f = await fixture();
      const source = await database(f.sourcePath);
      session(source, "owned");
      source.close();
      const target = await database(f.targetPath);
      session(target, "target-only", null, "/target");
      if (wal) target.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0");
      else target.exec("PRAGMA journal_mode=DELETE");
      try {
        const engine = createMigrationEngine({
          fault(phase) {
            if (phase === "verified")
              target.exec(
                "UPDATE session SET title='written-during-migration' WHERE id='target-only'",
              );
          },
        });
        await expect(engine.migrate(f)).rejects.toThrow(/CONFLICT.*changed/);
        expect(target.prepare("SELECT title FROM session WHERE id='target-only'").get()).toEqual({
          title: "written-during-migration",
        });
        await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
      } finally {
        target.close();
      }
    },
  );
  it("imports only owned sessions and children from a WAL snapshot and leaves the source intact", async () => {
    const f = await fixture();
    const contextFile = join(f.root, "external-context.md");
    await writeFile(contextFile, "retained attachment");
    const source = await database(f.sourcePath);
    try {
      source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      session(source, "owned");
      session(source, "child", "owned");
      session(source, "foreign", null, "/other");
      source
        .prepare("INSERT INTO message VALUES(?, ?,1,2,?,0)")
        .run("msg", "child", JSON.stringify({ text: "retained", file: contextFile }));
      const result = await sessionDatabaseMigration.migrate(f);
      expect(result).toEqual({ status: "migrated", importedSessions: 2 });
      const target = new DatabaseSync(f.targetPath, { readOnly: true });
      try {
        expect(target.prepare("SELECT id FROM session ORDER BY id").all()).toEqual([
          { id: "child" },
          { id: "owned" },
        ]);
        expect(target.prepare("SELECT data FROM message").get()).toEqual({
          data: JSON.stringify({ text: "retained", file: contextFile }),
        });
        expect(await readFile(contextFile, "utf8")).toBe("retained attachment");
      } finally {
        target.close();
      }
      expect(source.prepare("SELECT count(*) AS n FROM session").get()).toEqual({ n: 3 });
      source.close();
      await rm(f.sourcePath);
      await rm(f.ownershipManifestPath);
      await expect(sessionDatabaseMigration.migrate(f)).resolves.toEqual({
        status: "already-migrated",
        importedSessions: 2,
      });
      await expect(sessionDatabaseMigration.assertReady(f)).resolves.toBeUndefined();
    } finally {
      try {
        source.close();
      } catch {}
    }
  });
  it("prepares a fresh database and refuses unprepared normal runtime", async () => {
    const f = await fixture();
    await writeFile(f.ownershipManifestPath, JSON.stringify({ schemaVersion: 1, sessions: [] }));
    await expect(sessionDatabaseMigration.assertReady(f)).rejects.toThrow();
    await expect(sessionDatabaseMigration.migrate(f)).resolves.toEqual({
      status: "fresh",
      importedSessions: 0,
    });
    await expect(sessionDatabaseMigration.assertReady(f)).resolves.toBeUndefined();
  });
  it("fails on ownership mismatch without activating a target", async () => {
    const f = await fixture();
    const db = await database(f.sourcePath);
    session(db, "owned", null, "/other");
    db.close();
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/ownership/i);
    await expect(sessionDatabaseMigration.assertReady(f)).rejects.toThrow();
  });
  it("retains an existing target when an imported primary key has different values", async () => {
    const f = await fixture();
    const source = await database(f.sourcePath);
    session(source, "owned");
    source.close();
    const target = await database(f.targetPath);
    session(target, "owned");
    target.prepare("UPDATE session SET title='newer' WHERE id='owned'").run();
    target.close();
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/conflict/i);
    const db = new DatabaseSync(f.targetPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT title FROM session WHERE id='owned'").get()).toEqual({
        title: "newer",
      });
    } finally {
      db.close();
    }
  });
  it("keeps the workflow, dynamic workflow, queue, usage and permission closure", async () => {
    const f = await fixture();
    const db = await database(f.sourcePath);
    session(db, "owned");
    session(db, "workflow-child");
    session(db, "actor-child");
    session(db, "foreign", null, "/other");
    insert(db, "workflow_definition", {
      id: "def",
      name: "workflow",
      source: "user",
      script_hash: "hash",
      meta_json: "{}",
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "workflow_run", {
      id: "wr",
      definition_id: "def",
      name: "workflow",
      parent_session_id: "owned",
      cwd: "/work",
      script_hash: "hash",
      status: "completed",
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "workflow_activity", {
      id: "act",
      run_id: "wr",
      call_index: 0,
      call_path: "0",
      type: "agent",
      input_hash: "hash",
      status: "completed",
      child_session_id: "workflow-child",
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "workflow_event", {
      id: "we",
      run_id: "wr",
      sequence: 0,
      type: "complete",
      activity_id: "act",
      time_created: 1,
    });
    insert(db, "session_task_link", {
      id: "link",
      root_workflow_run_id: "wr",
      activity_id: "act",
      parent_session_id: "owned",
      child_session_id: "workflow-child",
      role: "agent",
      path: "0",
      status: "completed",
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "dwf_run", {
      id: "dr",
      parent_session_id: "owned",
      cwd: "/work",
      caps_max_concurrency: 1,
      status: "completed",
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "dwf_actor", {
      run_id: "dr",
      site_id: "actor",
      ordinal: 0,
      session_id: "actor-child",
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "dwf_node", {
      run_id: "dr",
      site_id: "node",
      ordinal: 0,
      kind: "artifact",
      input_hash: "hash",
      status: "completed",
      artifact_id: "external-artifact",
      result_json: '{"path":"/external/artifact.txt"}',
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "dwf_event", {
      run_id: "dr",
      sequence: 0,
      type: "artifact",
      payload_json: '{"artifactId":"external-artifact","path":"/external/artifact.txt"}',
      time_created: 1,
    });
    insert(db, "session_input", {
      id: "input",
      session_id: "owned",
      kind: "text",
      delivery: "queue",
      payload: '{"text":"pending"}',
      admitted_sequence: 0,
      status: "admitted",
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "session_entry", {
      id: "entry",
      session_id: "owned",
      type: "turn",
      data: "{}",
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "session_target", {
      session_id: "owned",
      target_id: "target",
      objective: "goal",
      status: "active",
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "message", {
      id: "message",
      session_id: "owned",
      data: '{"text":"message"}',
      time_created: 1,
      time_updated: 2,
      sequence: 0,
    });
    insert(db, "part", {
      id: "part",
      session_id: "owned",
      message_id: "message",
      data: '{"type":"text"}',
      time_created: 1,
      time_updated: 2,
      sequence: 0,
    });
    insert(db, "model_usage", {
      id: "model",
      logical_request_id: "logical",
      session_id: "owned",
      query_source: "main",
      provider_id: "provider",
      model_id: "model",
      status: "completed",
      started_at: 1,
    });
    insert(db, "tool_usage", {
      id: "tool",
      session_id: "owned",
      tool_call_id: "call",
      tool_name: "Bash",
      status: "completed",
      started_at: 1,
    });
    insert(db, "turn_usage", {
      session_id: "owned",
      turn_id: "turn",
      status: "completed",
      started_at: 1,
    });
    insert(db, "permission", {
      project_id: "project-work",
      data: '{"allow":[]}',
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "input_history", {
      id: "history",
      project_id: "project-work",
      session_id: null,
      text: "shared-local",
      kind: "text",
      time_created: 1,
    });
    insert(db, "local_setting", {
      scope: "project",
      scope_id: "project-work",
      namespace: "permission",
      key: "mode",
      value: '"read"',
      schema_version: 1,
      time_created: 1,
      time_updated: 2,
    });
    insert(db, "local_setting", {
      scope: "global",
      scope_id: "global",
      namespace: "provider",
      key: "token",
      value: '"foreign-global"',
      schema_version: 1,
      time_created: 1,
      time_updated: 2,
    });
    db.close();
    await expect(sessionDatabaseMigration.migrate(f)).resolves.toMatchObject({
      importedSessions: 3,
    });
    const target = new DatabaseSync(f.targetPath, { readOnly: true });
    try {
      for (const table of [
        "workflow_definition",
        "workflow_run",
        "workflow_activity",
        "workflow_event",
        "session_task_link",
        "dwf_run",
        "dwf_actor",
        "dwf_node",
        "dwf_event",
        "session_input",
        "session_entry",
        "session_target",
        "message",
        "part",
        "model_usage",
        "tool_usage",
        "turn_usage",
        "permission",
        "input_history",
        "local_setting",
      ]) {
        expect(target.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 1 });
      }
      expect(target.prepare("SELECT result_json FROM dwf_node").get()).toEqual({
        result_json: '{"path":"/external/artifact.txt"}',
      });
      expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      target.close();
    }
  });
  it("merges an identical existing key while preserving independent target sessions", async () => {
    const f = await fixture();
    const s = await database(f.sourcePath);
    session(s, "owned");
    s.close();
    const t = await database(f.targetPath);
    session(t, "owned");
    session(t, "target-only", null, "/target");
    t.close();
    await sessionDatabaseMigration.migrate(f);
    const db = new DatabaseSync(f.targetPath, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM session").get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
  it.each(["verified", "activated"] as const)(
    "recovers a crash after %s while the legacy source remains unchanged",
    async (phase) => {
      const f = await fixture();
      const s = await database(f.sourcePath);
      session(s, "owned");
      s.close();
      const engine = createMigrationEngine({
        fault(at) {
          if (at === phase) throw new Error("injected crash");
        },
      });
      await expect(engine.migrate(f)).rejects.toThrow("injected crash");
      await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
      if (phase === "activated") {
        await rm(f.ownershipManifestPath);
      }
      await expect(sessionDatabaseMigration.migrate(f)).resolves.toMatchObject({
        status: "migrated",
        importedSessions: 1,
      });
      await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(true);
      await rm(f.sourcePath);
      await expect(sessionDatabaseMigration.migrate(f)).resolves.toMatchObject({
        status: "already-migrated",
      });
    },
  );
  it("rejects a corrupt completed marker and a changed verified candidate", async () => {
    const f = await fixture();
    const s = await database(f.sourcePath);
    session(s, "owned");
    s.close();
    await expect(
      createMigrationEngine({
        fault() {
          throw new Error("stop");
        },
      }).migrate(f),
    ).rejects.toThrow("stop");
    const journal = JSON.parse(await readFile(`${f.targetPath}.uwork-migration.json`, "utf8"));
    const stage = new DatabaseSync(join(journal.workDir, "stage.sqlite"));
    stage.exec("UPDATE session SET title='tampered'");
    stage.close();
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/VERIFY/);
  });
  it("rejects unknown newer schema without changing the source", async () => {
    const f = await fixture();
    const s = await database(f.sourcePath);
    session(s, "owned");
    s.exec("CREATE TABLE future_state(id TEXT PRIMARY KEY)");
    s.close();
    const before = await readFile(f.sourcePath);
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/UNKNOWN_SCHEMA/);
    expect(await readFile(f.sourcePath)).toEqual(before);
  });
  it("refuses a live owner lock and recovers an orphan owner lock", async () => {
    const f = await fixture();
    await writeFile(f.ownershipManifestPath, JSON.stringify({ schemaVersion: 1, sessions: [] }));
    const lock = `${f.targetPath}.uwork-migration.lock`;
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, owner: randomUUID() }),
    );
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/LOCKED/);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: 999999999, owner: randomUUID() }),
    );
    await expect(sessionDatabaseMigration.migrate(f)).resolves.toMatchObject({ status: "fresh" });
  });
  it("upgrades a legacy schema only on a snapshot, never on the source", async () => {
    const f = await fixture();
    const db = new DatabaseSync(f.sourcePath);
    db.exec(
      `CREATE TABLE session(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,workspace_id TEXT,parent_id TEXT,slug TEXT NOT NULL,directory TEXT NOT NULL,path TEXT,title TEXT NOT NULL,version TEXT NOT NULL,share_url TEXT,summary_additions INTEGER,summary_deletions INTEGER,summary_files INTEGER,summary_diffs TEXT,revert TEXT,permission TEXT,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL,time_compacting INTEGER,time_archived INTEGER)`,
    );
    session(db, "owned");
    db.close();
    const before = await readFile(f.sourcePath);
    await sessionDatabaseMigration.migrate(f);
    expect(await readFile(f.sourcePath)).toEqual(before);
    const source = new DatabaseSync(f.sourcePath, { readOnly: true });
    try {
      expect(
        source.prepare("SELECT name FROM sqlite_master WHERE name='schema_migration'").all(),
      ).toEqual([]);
    } finally {
      source.close();
    }
    const target = new DatabaseSync(f.targetPath, { readOnly: true });
    try {
      expect(target.prepare("SELECT title_source FROM session WHERE id='owned'").get()).toEqual({
        title_source: "first_input",
      });
    } finally {
      target.close();
    }
  });
  it("serializes concurrent workers using the target PID lock", async () => {
    const f = await fixture();
    await writeFile(f.ownershipManifestPath, JSON.stringify({ schemaVersion: 1, sessions: [] }));
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = sessionDatabaseMigration.migrate({
      ...f,
      onProgress: async (phase) => {
        if (phase === "copying") {
          entered();
          await blocked;
        }
      },
    });
    await started;
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/LOCKED/);
    unblock();
    await expect(first).resolves.toMatchObject({ status: "fresh" });
  });
  it("fails when a completed active marker is replaced and does not reimport old history", async () => {
    const f = await fixture();
    const source = await database(f.sourcePath);
    session(source, "owned");
    source.close();
    await sessionDatabaseMigration.migrate(f);
    const target = new DatabaseSync(f.targetPath);
    target.exec("DROP TABLE uwork_session_root_migration");
    target.close();
    await rm(f.sourcePath);
    await rm(f.ownershipManifestPath);
    await expect(sessionDatabaseMigration.isPrepared(f)).rejects.toThrow(/VERIFY/);
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/VERIFY/);
  });
  it.each(["migration-id", "column"])("fails closed for an unknown future %s", async (kind) => {
    const f = await fixture();
    const db = await database(f.sourcePath);
    session(db, "owned");
    if (kind === "migration-id")
      db.exec(
        "INSERT INTO schema_migration(id,checksum,time_applied) VALUES('9999_future','unknown',1)",
      );
    else db.exec("ALTER TABLE session ADD COLUMN future_business_state TEXT");
    db.close();
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/UNKNOWN_SCHEMA/);
    await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
  });
  it("rejects malformed ownership, missing known history and corrupt source without preparing an empty target", async () => {
    const f = await fixture();
    await writeFile(f.ownershipManifestPath, JSON.stringify({ schemaVersion: 2, sessions: [] }));
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/OWNERSHIP/);
    await writeFile(
      f.ownershipManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        sessions: [{ sessionId: "owned", workspacePath: "/work" }],
      }),
    );
    await expect(sessionDatabaseMigration.migrate(f)).rejects.toThrow(/OWNERSHIP/);
    await expect(sessionDatabaseMigration.isPrepared(f)).resolves.toBe(false);
    const corrupt = await fixture();
    await writeFile(corrupt.sourcePath, "not a sqlite database");
    await expect(sessionDatabaseMigration.migrate(corrupt)).rejects.toThrow();
    await expect(sessionDatabaseMigration.isPrepared(corrupt)).resolves.toBe(false);
  });
});

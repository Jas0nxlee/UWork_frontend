import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildServerRemoteWorkspaceIdentity } from "@zcode/shared";
import * as startup from "../startup-entry.js";

describe("Host session ownership manifest", () => {
  it("reads local Agent ownership including archived/deleted rows without changing tasks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uwork-ownership-"));
    const path = join(directory, "tasks-index.sqlite");
    let manifest:
      | Awaited<ReturnType<typeof startup.createSessionStorageOwnershipManifest>>
      | undefined;
    try {
      await startup.prepareTasksIndexStorage(path, () => {});
      const db = new DatabaseSync(path);
      try {
        db.prepare("INSERT INTO hosts(host_id,kind) VALUES(?,?)").run("remote-owner", "server");
        const insert = db.prepare(`INSERT INTO tasks(
          workspace_key,workspace_path,workspace_identity,task_id,provider,host_id,
          created_at,updated_at,archived,deleted
        ) VALUES(?,?,?,?,?,?,1,2,?,?)`);
        insert.run("/work/a", "/work/a", null, "active", "glm", "local", 0, 0);
        insert.run("/work/b", "/work/b", null, "archived", "glm", "local", 1, 0);
        insert.run("/work/c", "/work/c", null, "deleted", "glm", "local", 0, 1);
        insert.run("/work/d", "/work/d", null, "other-runtime", "claude", "local", 0, 0);
        insert.run(
          "remote:server:test:root",
          "/remote",
          "remote:server:test:root",
          "remote",
          "glm",
          "remote-owner",
          0,
          0,
        );
        insert.run("local-identity", "/work/e", "local-identity", "identity", "glm", "local", 0, 0);
        const remoteIdentity = buildServerRemoteWorkspaceIdentity({
          serverId: "remote",
          workspacePath: "/remote",
        });
        insert.run(
          remoteIdentity,
          "/remote",
          remoteIdentity,
          "remote-identity-with-local-host",
          "glm",
          "local",
          0,
          0,
        );
        const before = db.prepare("SELECT * FROM tasks ORDER BY task_id").all();

        manifest = await startup.createSessionStorageOwnershipManifest(path);

        const parsed = JSON.parse(await readFile(manifest.path, "utf8"));
        expect(parsed).toEqual({
          schemaVersion: 1,
          sessions: [
            { sessionId: "active", workspacePath: "/work/a" },
            { sessionId: "archived", workspacePath: "/work/b" },
            { sessionId: "deleted", workspacePath: "/work/c" },
            {
              sessionId: "identity",
              workspacePath: "/work/e",
              workspaceIdentity: "local-identity",
            },
          ],
        });
        if (process.platform !== "win32")
          expect((await stat(manifest.path)).mode & 0o777).toBe(0o600);
        expect(db.prepare("SELECT * FROM tasks ORDER BY task_id").all()).toEqual(before);
      } finally {
        db.close();
      }
      await manifest.dispose();
      await expect(stat(manifest.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await manifest?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes a large ownership set to a private file rather than a control frame", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uwork-ownership-large-"));
    const path = join(directory, "tasks-index.sqlite");
    let manifest:
      | Awaited<ReturnType<typeof startup.createSessionStorageOwnershipManifest>>
      | undefined;
    try {
      await startup.prepareTasksIndexStorage(path, () => {});
      const db = new DatabaseSync(path);
      try {
        const insert =
          db.prepare(`INSERT INTO tasks(workspace_key,workspace_path,task_id,provider,host_id,created_at,updated_at)
          VALUES('/work','/work',?,'glm','local',1,2)`);
        db.exec("BEGIN");
        for (let index = 0; index < 5000; index++) insert.run(`session-${index}`);
        db.exec("COMMIT");
      } finally {
        db.close();
      }
      manifest = await startup.createSessionStorageOwnershipManifest(path);
      const text = await readFile(manifest.path, "utf8");
      expect(text.length).toBeGreaterThan(65536);
      expect(JSON.parse(text).sessions).toHaveLength(5000);
    } finally {
      await manifest?.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not infer ownership before the tasks storage preparation gate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uwork-ownership-unprepared-"));
    const path = join(directory, "tasks-index.sqlite");
    const db = new DatabaseSync(path);
    db.close();
    try {
      await expect(startup.createSessionStorageOwnershipManifest(path)).rejects.toThrow(
        "not prepared",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

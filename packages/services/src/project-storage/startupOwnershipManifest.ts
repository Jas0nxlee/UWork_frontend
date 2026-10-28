import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  ZCODE_AGENT_PROVIDER,
  zcodeLegacySessionOwnershipManifestSchema,
} from "@zcode/shared";
import { isTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

export interface SessionStorageOwnershipManifestFile {
  readonly path: string;
  dispose(): Promise<void>;
}

/** 只读 Host 组织态；会话正文与源库筛选仍由 CLI 迁移器独占。 */
export async function createSessionStorageOwnershipManifest(
  tasksIndexPath: string,
): Promise<SessionStorageOwnershipManifestFile> {
  const db = new DatabaseSync(tasksIndexPath, { readOnly: true });
  let sessions: Array<{ sessionId: string; workspacePath: string; workspaceIdentity?: string }>;
  try {
    if (!isTasksStoragePrepared(tasksIndexPath, db))
      throw new Error("Tasks storage is not prepared for ownership export");
    // 列表投影会丢弃软删除或尚未交接 cli_created_at 的历史行，且会归一旧 provider。
    // 迁移归属必须取原始本地 Agent 行，不能让另一 runtime 或远端同路径进入源库筛选。
    const rows = db
      .prepare(`SELECT t.task_id, t.workspace_path, t.workspace_identity FROM tasks t
        JOIN hosts h ON h.host_id=t.host_id
        WHERE t.provider=? AND t.host_id='local' AND h.kind='local'
        ORDER BY t.task_id, t.workspace_key`)
      .all(ZCODE_AGENT_PROVIDER) as Array<{
      task_id: string;
      workspace_path: string;
      workspace_identity: string | null;
    }>;
    sessions = rows
      .filter(
        (row) => !row.workspace_identity || !isRemoteWorkspaceIdentity(row.workspace_identity),
      )
      .map((row) => ({
        sessionId: row.task_id,
        workspacePath: row.workspace_path,
        ...(row.workspace_identity?.trim() ? { workspaceIdentity: row.workspace_identity } : {}),
      }));
  } finally {
    db.close();
  }
  const manifest = zcodeLegacySessionOwnershipManifestSchema.parse({ schemaVersion: 1, sessions });
  const directory = await mkdtemp(join(dirname(tasksIndexPath), ".session-db-ownership-"));
  try {
    const path = join(directory, "ownership.json");
    await writeFile(path, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { path, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { LegacySessionOwnershipManifest } from "./contract.js";
import { fingerprint } from "./files.js";

type Row = Record<string, SQLInputValue>;
const SESSION_TABLES = [
  "message",
  "part",
  "session_entry",
  "session_input",
  "session_target",
  "todo",
  "model_usage",
  "tool_usage",
  "turn_usage",
  "input_history",
] as const;
const BUSINESS_TABLES = [
  "session",
  ...SESSION_TABLES,
  "permission",
  "local_setting",
  "workflow_run",
  "workflow_activity",
  "workflow_event",
  "workflow_definition",
  "session_task_link",
  "dwf_run",
  "dwf_actor",
  "dwf_node",
  "dwf_event",
] as const;
const META_TABLES = new Set([
  "schema_migration",
  "zcode_database_identity",
  "sqlite_sequence",
  "uwork_session_root_migration",
]);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export function ownershipError(
  reason: string,
): Error & { code: "SESSION_MIGRATION_OWNERSHIP"; kind: "ownership" } {
  return Object.assign(new Error(`SESSION_MIGRATION_OWNERSHIP: ${reason}`), {
    code: "SESSION_MIGRATION_OWNERSHIP" as const,
    kind: "ownership" as const,
  });
}
function relationRows(db: DatabaseSync, table: string, columns: readonly string[]): Row[] {
  return db.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(table)}`).all() as Row[];
}
function* iterateRows(db: DatabaseSync, table: string): Generator<Row> {
  for (const row of db.prepare(`SELECT * FROM ${quote(table)}`).iterate()) yield row as Row;
}
function key(value: SQLInputValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function add(set: Set<string>, value: SQLInputValue | undefined): boolean {
  const id = key(value);
  if (!id || set.has(id)) return false;
  set.add(id);
  return true;
}

/** 表名单是当前 CLI schema 的静态归属合同；新增表必须先说明其会话关联，不能静默漏迁。 */
export function validateSchema(db: DatabaseSync, currentMigrationIds: Set<string>): void {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[];
  for (const { name } of tables)
    if (!BUSINESS_TABLES.includes(name as never) && !META_TABLES.has(name))
      throw new Error(`SESSION_MIGRATION_UNKNOWN_SCHEMA: ${name}`);
  if (tables.some((t) => t.name === "schema_migration")) {
    for (const row of db.prepare("SELECT id FROM schema_migration").all())
      if (!currentMigrationIds.has(String(row.id)))
        throw new Error("SESSION_MIGRATION_UNKNOWN_SCHEMA: unknown schema migration");
  }
}

export function assertCurrentColumns(source: DatabaseSync, target: DatabaseSync): void {
  for (const table of BUSINESS_TABLES) {
    const sourceColumns = source
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((row) => row.name);
    const targetColumns = target
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all()
      .map((row) => row.name);
    if (fingerprint(sourceColumns) !== fingerprint(targetColumns))
      throw new Error(`SESSION_MIGRATION_UNKNOWN_SCHEMA: unexpected columns in ${table}`);
  }
}
export function mergeOwnedRows(
  source: DatabaseSync,
  target: DatabaseSync,
  manifest: LegacySessionOwnershipManifest,
): number {
  assertCurrentColumns(source, target);
  // 只缓存闭包关系；正文、工具输出和 DWF 事件按行复制，避免把另一产品整库内容堆进内存。
  const relationColumns: Record<string, readonly string[]> = {
    session: ["id", "parent_id", "directory", "workspace_id", "project_id"],
    workflow_run: ["id", "parent_session_id", "definition_id"],
    workflow_activity: ["run_id", "child_session_id"],
    session_task_link: [
      "id",
      "parent_session_id",
      "child_session_id",
      "root_workflow_run_id",
      "parent_link_id",
    ],
    dwf_run: ["id", "parent_session_id", "resumed_from"],
    dwf_actor: ["run_id", "session_id"],
  };
  const all = new Map<string, Row[]>(
    Object.entries(relationColumns).map(([table, columns]) => [
      table,
      relationRows(source, table, columns),
    ]),
  );
  const sessions = new Map(all.get("session")!.map((row) => [String(row.id), row]));
  const selected = new Set<string>();
  for (const owned of manifest.sessions) {
    const row = sessions.get(owned.sessionId);
    if (
      !row ||
      row.directory !== owned.workspacePath ||
      (key(row.workspace_id) ?? owned.workspacePath) !==
        (owned.workspaceIdentity?.trim() || owned.workspacePath)
    )
      throw ownershipError("session identity or directory mismatch");
    selected.add(owned.sessionId);
  }
  const workflows = new Set<string>();
  const dwfs = new Set<string>();
  const links = new Set<string>();
  let changed = true;
  const includeChild = (id: SQLInputValue | undefined) => {
    const child = key(id);
    if (!child) return false;
    if (!sessions.has(child)) throw ownershipError("associated child session missing");
    return add(selected, child);
  };
  while (changed) {
    changed = false;
    for (const row of all.get("session")!)
      if (selected.has(String(row.parent_id))) changed = includeChild(row.id) || changed;
    for (const row of all.get("workflow_run")!)
      if (selected.has(String(row.parent_session_id))) changed = add(workflows, row.id) || changed;
    for (const row of all.get("dwf_run")!)
      if (selected.has(String(row.parent_session_id))) changed = add(dwfs, row.id) || changed;
    for (const row of all.get("workflow_activity")!)
      if (workflows.has(String(row.run_id)))
        changed = includeChild(row.child_session_id) || changed;
    for (const row of all.get("dwf_actor")!)
      if (dwfs.has(String(row.run_id))) changed = includeChild(row.session_id) || changed;
    for (const row of all.get("session_task_link")!)
      if (
        selected.has(String(row.parent_session_id)) ||
        selected.has(String(row.child_session_id)) ||
        workflows.has(String(row.root_workflow_run_id)) ||
        links.has(String(row.parent_link_id))
      ) {
        changed = add(links, row.id) || changed;
        changed = includeChild(row.child_session_id) || changed;
      }
  }
  for (const id of selected) {
    const parent = key(sessions.get(id)!.parent_id);
    if (parent && !selected.has(parent)) throw ownershipError("foreign parent session");
  }
  for (const row of all.get("session_task_link")!)
    if (links.has(String(row.id))) {
      if (key(row.parent_session_id) && !selected.has(String(row.parent_session_id)))
        throw ownershipError("foreign linked parent");
      if (key(row.root_workflow_run_id) && !workflows.has(String(row.root_workflow_run_id)))
        throw ownershipError("foreign workflow link");
    }
  for (const row of all.get("dwf_run")!)
    if (dwfs.has(String(row.id)) && key(row.resumed_from) && !dwfs.has(String(row.resumed_from)))
      throw ownershipError("foreign resumed workflow");
  const projects = new Set([...selected].map((id) => String(sessions.get(id)!.project_id)));
  const workspaces = new Set(
    [...selected]
      .flatMap((id) => [key(sessions.get(id)!.directory), key(sessions.get(id)!.workspace_id)])
      .filter((id): id is string => !!id),
  );
  const ambiguousProjects = new Set<string>();
  const ambiguousWorkspaces = new Set<string>();
  for (const [id, row] of sessions)
    if (!selected.has(id)) {
      if (projects.has(String(row.project_id))) ambiguousProjects.add(String(row.project_id));
      for (const value of [key(row.directory), key(row.workspace_id)])
        if (value && workspaces.has(value)) ambiguousWorkspaces.add(value);
    }
  const assertSharedScope = (scope: "project" | "workspace", scopeId: string) => {
    if ((scope === "project" ? ambiguousProjects : ambiguousWorkspaces).has(scopeId))
      throw ownershipError("shared scope contains sessions outside the UWork ownership manifest");
  };
  const definitions = new Set(
    all
      .get("workflow_run")!
      .filter((row) => workflows.has(String(row.id)))
      .map((row) => key(row.definition_id))
      .filter((id): id is string => !!id),
  );
  const shouldInclude = (table: string, row: Row): boolean => {
    if (table === "session") return selected.has(String(row.id));
    if (table === "part") {
      const message = source
        .prepare("SELECT session_id FROM message WHERE id=?")
        .get(row.message_id!);
      const included =
        selected.has(String(row.session_id)) || selected.has(String(message?.session_id));
      if (included && row.session_id !== message?.session_id)
        throw ownershipError("part and message belong to different sessions");
      return included;
    }
    if (SESSION_TABLES.includes(table as never)) {
      if (selected.has(String(row.session_id))) return true;
      if (
        table === "input_history" &&
        row.session_id === null &&
        projects.has(String(row.project_id))
      ) {
        assertSharedScope("project", String(row.project_id));
        return true;
      }
      return false;
    }
    if (table === "permission") {
      const included = projects.has(String(row.project_id));
      if (included) assertSharedScope("project", String(row.project_id));
      return included;
    }
    if (table === "local_setting") {
      if (row.scope === "session") return selected.has(String(row.scope_id));
      const scopeId = String(row.scope_id);
      if (row.scope === "project" && projects.has(scopeId)) {
        assertSharedScope("project", scopeId);
        return true;
      }
      if (row.scope === "workspace" && workspaces.has(scopeId)) {
        assertSharedScope("workspace", scopeId);
        return true;
      }
      return false;
    }
    if (table === "workflow_run") return workflows.has(String(row.id));
    if (table === "workflow_activity" || table === "workflow_event")
      return workflows.has(String(row.run_id));
    if (table === "workflow_definition") return definitions.has(String(row.id));
    if (table === "session_task_link") return links.has(String(row.id));
    if (table === "dwf_run") return dwfs.has(String(row.id));
    return dwfs.has(String(row.run_id));
  };
  // 在 stage 内关闭 FK 合并整个闭包；提交前统一验证，不让父子循环迫使按序猜测或丢字段。
  target.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    for (const table of BUSINESS_TABLES) {
      const columns = target.prepare(`PRAGMA table_info(${quote(table)})`).all() as {
        name: string;
        pk: number;
      }[];
      const names = columns.map((c) => c.name);
      const primary = columns
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      if (primary.length === 0)
        throw new Error("SESSION_MIGRATION_UNKNOWN_SCHEMA: primary key missing");
      const find = target.prepare(
        `SELECT * FROM ${quote(table)} WHERE ${primary.map((c) => `${quote(c)} IS ?`).join(" AND ")}`,
      );
      const insert = target.prepare(
        `INSERT INTO ${quote(table)}(${names.map(quote).join(",")}) VALUES(${names.map(() => "?").join(",")})`,
      );
      const foreignKeys = source.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all() as {
        table: string;
        from: string;
        to: string;
      }[];
      for (const row of iterateRows(source, table)) {
        if (!shouldInclude(table, row)) continue;
        for (const foreignKey of foreignKeys) {
          const value = row[foreignKey.from];
          if (value === null || value === undefined) continue;
          const parent = source
            .prepare(`SELECT * FROM ${quote(foreignKey.table)} WHERE ${quote(foreignKey.to)} IS ?`)
            .get(value) as Row | undefined;
          if (!parent || !shouldInclude(foreignKey.table, parent))
            throw ownershipError("foreign key leaves the owned closure");
        }
        const existing = find.get(...primary.map((c) => row[c]!)) as Row | undefined;
        if (existing) {
          if (fingerprint(names.map((c) => existing[c])) !== fingerprint(names.map((c) => row[c])))
            throw new Error(`SESSION_MIGRATION_CONFLICT: ${table}`);
          continue;
        }
        insert.run(...names.map((c) => row[c]!));
      }
    }
    if (target.prepare("PRAGMA foreign_key_check").all().length)
      throw ownershipError("incomplete foreign key closure");
    target.exec("COMMIT");
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  } finally {
    target.exec("PRAGMA foreign_keys=ON");
  }
  // 检查每一列，触发器也不能在迁移时悄悄重写 sequence 等业务事实。
  for (const table of BUSINESS_TABLES) {
    const columns = target.prepare(`PRAGMA table_info(${quote(table)})`).all() as {
      name: string;
      pk: number;
    }[];
    const primary = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    for (const row of iterateRows(source, table)) {
      if (!shouldInclude(table, row)) continue;
      const actual = target
        .prepare(
          `SELECT * FROM ${quote(table)} WHERE ${primary.map((c) => `${quote(c.name)} IS ?`).join(" AND ")}`,
        )
        .get(...primary.map((c) => row[c.name]!)) as Row;
      if (
        fingerprint(columns.map((c) => actual[c.name])) !==
        fingerprint(columns.map((c) => row[c.name]))
      )
        throw new Error(`SESSION_MIGRATION_VERIFY: ${table}`);
    }
  }
  return selected.size;
}

import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { backup, DatabaseSync } from "node:sqlite";
import { syncStagedFile } from "./copyReceipt.js";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function isSqliteDatabase(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.equals(SQLITE_HEADER);
  } finally {
    await file.close();
  }
}

function assertHealthy(db: DatabaseSync): void {
  const checks = db.prepare("PRAGMA quick_check").iterate();
  for (const row of checks) {
    if (row.quick_check !== "ok") throw new Error("UWork SQLite snapshot integrity check failed");
  }
  for (const _row of db.prepare("PRAGMA foreign_key_check").iterate()) {
    throw new Error("UWork SQLite snapshot has incomplete foreign key references");
  }
}

function valueFingerprint(value: unknown): unknown {
  if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("base64")];
  if (typeof value === "bigint") return ["integer", value.toString()];
  return [typeof value, value];
}

/** 逐行比较 schema 与全部表内容，不以不含 WAL 的主文件字节作为一致性证据。 */
function databaseFingerprint(db: DatabaseSync): string {
  const digest = createHash("sha256");
  const schema = db
    .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
    .all();
  digest.update(JSON.stringify(schema));
  for (const table of schema.filter((row) => row.type === "table")) {
    const name = String(table.name);
    const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
    const primary = [...columns].filter((column) => Number(column.pk) > 0);
    primary.sort((a, b) => Number(a.pk) - Number(b.pk));
    const order = (primary.length ? primary : columns).map((column) => quote(String(column.name)));
    const statement = db.prepare(
      `SELECT * FROM ${quote(name)}${order.length ? ` ORDER BY ${order.join(",")}` : ""}`,
    );
    statement.setReadBigInts(true);
    digest.update(JSON.stringify(["table", name]));
    for (const row of statement.iterate()) {
      digest.update(
        JSON.stringify(Object.entries(row).map(([key, value]) => [key, valueFingerprint(value)])),
      );
      digest.update("\n");
    }
  }
  return digest.digest("hex");
}

export async function copySqliteSnapshot(source: string, target: string): Promise<void> {
  const original = new DatabaseSync(source, { readOnly: true });
  let expected: string;
  try {
    // 同一只读事务固定 WAL 视图；不能把两个时间点的主文件/WAL 拼成新库。
    original.exec("BEGIN");
    assertHealthy(original);
    expected = databaseFingerprint(original);
    await backup(original, target);
    original.exec("ROLLBACK");
  } finally {
    original.close();
  }
  const copied = new DatabaseSync(target);
  try {
    // 备份产物自包含，不能将旧 WAL/SHM 随新主库发布。
    copied.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE");
    assertHealthy(copied);
    if (databaseFingerprint(copied) !== expected) {
      throw new Error("UWork SQLite snapshot content verification failed");
    }
  } finally {
    copied.close();
  }
  await syncStagedFile(target);
}

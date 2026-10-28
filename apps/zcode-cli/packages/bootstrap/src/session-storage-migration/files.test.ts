import { mkdtemp, readdir, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, expect, vi } from "vitest";

const fault = vi.hoisted(() => ({ failNext: false }));
vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  return {
    ...actual,
    async backup(
      db: Parameters<typeof actual.backup>[0],
      path: Parameters<typeof actual.backup>[1],
      options?: Parameters<typeof actual.backup>[2],
    ) {
      if (fault.failNext) {
        fault.failNext = false;
        const fs = await import("node:fs/promises");
        await fs.writeFile(path, Buffer.alloc(1024 * 1024));
        throw Object.assign(new Error("injected backup disk full"), { code: "ENOSPC" });
      }
      return options === undefined ? actual.backup(db, path) : actual.backup(db, path, options);
    },
  };
});
import { snapshot } from "./files.js";
const roots: string[] = [];
afterEach(async () => {
  fault.failNext = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe("SQLite snapshot publication", () => {
  it("removes an unpublished partial backup after ENOSPC and retries with a real SQLite snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "uwork-snapshot-failure-"));
    roots.push(root);
    const source = join(root, "source.sqlite");
    const destination = join(root, "backup.sqlite");
    const db = new DatabaseSync(source);
    db.exec(
      "CREATE TABLE facts(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO facts VALUES(1,'retained')",
    );
    db.close();
    const before = await readFile(source);
    fault.failNext = true;
    await expect(snapshot(source, destination)).rejects.toMatchObject({ code: "ENOSPC" });
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.includes(".snapshot"))).toEqual([]);
    expect(await readFile(source)).toEqual(before);
    await snapshot(source, destination);
    const backup = new DatabaseSync(destination, { readOnly: true });
    try {
      expect(backup.prepare("SELECT * FROM facts").all()).toEqual([{ id: 1, value: "retained" }]);
    } finally {
      backup.close();
    }
    expect((await readdir(root)).filter((name) => name.includes(".snapshot"))).toEqual([]);
  });
});

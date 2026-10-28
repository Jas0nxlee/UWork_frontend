import { mkdir, mkdtemp, readFile, writeFile, rm, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fixture, directories } from "./test-fixture.js";
it("fails closed when an internal temporary file disappears during writer inventory", async () => {
  const f = await fixture();
  const originalSettings = await readFile(f.settingsFile, "utf8");
  const temporary = join(f.source, ".uwork", "aaa.tmp");
  await writeFile(temporary, "temporary source entry");
  const originalLstat = fsPromises.lstat;
  let removed = false;
  const probe = vi.spyOn(fsPromises, "lstat").mockImplementation(async (...args) => {
    if (String(args[0]) === temporary && !removed) {
      removed = true;
      await rm(temporary);
    }
    return originalLstat(...args);
  });
  syncBuiltinESMExports();
  const copy = vi.fn(f.files.copyDataDirectory);
  const writers = vi.fn(async () => {
    throw Object.assign(new Error("live source writer"), { kind: "legacy_writer_active" });
  });
  try {
    await expect(
      f.api.executePendingDataDirectoryMigration({ assertNoWriters: writers, copy }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(removed).toBe(true);
    expect(copy).not.toHaveBeenCalled();
    expect(await readFile(f.settingsFile, "utf8")).toBe(originalSettings);
    await expect(stat(join(f.target, ".uwork"))).rejects.toMatchObject({ code: "ENOENT" });
    const source = new DatabaseSync(join(f.source, ".uwork", "cli", "db", "db.sqlite"), {
      readOnly: true,
    });
    try {
      expect(source.prepare("SELECT body FROM history").get()?.body).toBe("preserved");
    } finally {
      source.close();
    }
  } finally {
    probe.mockRestore();
    syncBuiltinESMExports();
  }
});
it("copies only in the cold owner and commits settings after SQLite and receipt validation", async () => {
  const f = await fixture();
  const request = (await f.service.get()).pendingDataDirectoryMigration;
  const check = vi.fn(async (path: string) => {
    expect(path).toContain("db.sqlite");
    expect((await f.service.get()).pendingDataDirectoryMigration).toEqual(request);
  });
  await f.api.executePendingDataDirectoryMigration({ assertNoWriters: check });
  expect(check).toHaveBeenCalled();
  expect((await f.service.get()).dataBaseDir).toBe(f.target);
  expect((await f.service.get()).pendingDataDirectoryMigration).toBeUndefined();
  const db = new DatabaseSync(join(f.target, ".uwork", "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    expect(db.prepare("SELECT * FROM history").get()).toEqual({ id: "old", body: "preserved" });
  } finally {
    db.close();
  }
  expect((await stat(join(f.source, ".uwork", "cli", "db", "db.sqlite"))).isFile()).toBe(true);
  expect((await f.api.inspectDataDirectoryStartup()).required).toBe(false);
});
it("recovers activation completed before settings commit without copying the target again", async () => {
  const f = await fixture();
  let activated = false;
  const request = (await f.service.get()).pendingDataDirectoryMigration;
  await expect(
    f.api.executePendingDataDirectoryMigration({
      assertNoWriters: async () => {},
      copy: async (...args) => {
        await f.files.copyDataDirectory(...args);
        activated = true;
        throw new Error("crash before commit");
      },
    }),
  ).rejects.toThrow("crash before commit");
  expect(activated).toBe(true);
  expect((await f.service.get()).pendingDataDirectoryMigration).toEqual(request);
  const operation = join(
    f.owner.dataDirectoryMigrationControlPaths().operationDirectory,
    "operation.json",
  );
  if (process.platform !== "win32") expect((await stat(operation)).mode & 0o777).toBe(0o600);
  await f.api.executePendingDataDirectoryMigration({ assertNoWriters: async () => {} });
  expect((await f.service.get()).dataBaseDir).toBe(f.target);
  await expect(stat(operation)).rejects.toMatchObject({ code: "ENOENT" });
});
it("keeps a missing bootstrap outside the target until the file owner restores it", async () => {
  const f = await fixture(true);
  const retired = join(f.home, "retired-bootstrap");
  await expect(
    f.api.executePendingDataDirectoryMigration({
      assertNoWriters: async () => {},
      copy: async () => {
        await rename(join(f.home, ".uwork"), retired);
        throw new Error("retired before activation");
      },
    }),
  ).rejects.toThrow("retired before activation");
  expect((await f.api.inspectDataDirectoryStartup()).required).toBe(true);
  const copy = vi.fn(async (...args: Parameters<typeof f.files.copyDataDirectory>) => {
    await expect(stat(f.settingsFile)).rejects.toMatchObject({ code: "ENOENT" });
    await rename(retired, join(f.home, ".uwork"));
    await f.files.copyDataDirectory(...args);
  });
  await f.api.executePendingDataDirectoryMigration({ assertNoWriters: async () => {}, copy });
  expect(copy).toHaveBeenCalledOnce();
  expect((await f.service.get()).dataBaseDir).toBeUndefined();
  expect((await f.service.get()).pendingDataDirectoryMigration).toBeUndefined();
});
it("fails closed for corrupt pending settings and never changes the active root", async () => {
  const f = await fixture();
  const invalid = JSON.stringify({
    dataBaseDir: f.source,
    pendingDataDirectoryMigration: { requestId: "invalid" },
  });
  await writeFile(f.settingsFile, invalid);
  expect((await f.api.inspectDataDirectoryStartup()).required).toBe(true);
  const copy = vi.fn();
  await expect(
    f.api.executePendingDataDirectoryMigration({ assertNoWriters: async () => {}, copy }),
  ).rejects.toMatchObject({ kind: "corrupt" });
  expect(copy).not.toHaveBeenCalled();
  expect(await readFile(f.settingsFile, "utf8")).toBe(invalid);
  await expect(f.service.get()).rejects.toMatchObject({ kind: "corrupt" });
});
it("serializes the shared request and performs a successful copy only once", async () => {
  const f = await fixture();
  const copy = vi.fn(f.files.copyDataDirectory);
  await Promise.all([
    f.api.executePendingDataDirectoryMigration({ assertNoWriters: async () => {}, copy }),
    f.api.executePendingDataDirectoryMigration({ assertNoWriters: async () => {}, copy }),
  ]);
  expect(copy).toHaveBeenCalledOnce();
  expect((await f.service.get()).dataBaseDir).toBe(f.target);
});
it("isolates settings and operation metadata in desktop home B when parent HOME points to A", async () => {
  const a = await mkdtemp(join(tmpdir(), "uwork-parent-home-A-"));
  const b = await mkdtemp(join(tmpdir(), "uwork-desktop-home-B-"));
  const target = await mkdtemp(join(tmpdir(), "uwork-desktop-target-B-"));
  directories.push(a, b, target);
  await mkdir(join(a, ".uwork", "v2"), { recursive: true });
  await mkdir(join(a, ".uwork-data-directory-migration"), { recursive: true });
  await mkdir(join(b, ".uwork", "v2"), { recursive: true });
  const rawA = JSON.stringify({
    pendingDataDirectoryMigration: {
      requestId: "12345678-1234-4234-8234-123456789012",
      sourceBaseDir: a,
      targetBaseDir: join(a, "do-not-create"),
      resetToDefault: false,
    },
  });
  const operationA = "A operation must not be read or changed";
  await writeFile(join(a, ".uwork", "v2", "setting.json"), rawA);
  await writeFile(join(a, ".uwork-data-directory-migration", "operation.json"), operationA);
  vi.stubEnv("HOME", a);
  vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", b);
  vi.stubEnv("UWORK_DATA_BASE_DIR", "");
  vi.stubEnv("ZCODE_DATA_BASE_DIR", "");
  vi.resetModules();
  const owner = await import("../../setting/settingService.js");
  const api = await import("../cold-startup-entry.js");
  const paths = await import("../../paths.js");
  expect(paths.getDataBaseDir()).toBe(b);
  expect((await api.inspectDataDirectoryStartup(b)).required).toBe(false);
  await writeFile(join(b, ".uwork", "v2", "B.txt"), "B history");
  const service = owner.createSettingService();
  await service.updateDataBaseDir(target);
  expect((await service.get()).pendingDataDirectoryMigration?.sourceBaseDir).toBe(b);
  await api.executePendingDataDirectoryMigration({ assertNoWriters: async () => {} });
  expect((await service.get()).dataBaseDir).toBe(target);
  expect(await readFile(join(a, ".uwork", "v2", "setting.json"), "utf8")).toBe(rawA);
  expect(await readFile(join(a, ".uwork-data-directory-migration", "operation.json"), "utf8")).toBe(
    operationA,
  );
  await expect(stat(join(a, "do-not-create"))).rejects.toMatchObject({ code: "ENOENT" });
});

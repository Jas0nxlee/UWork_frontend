import { mkdir, mkdtemp, readFile, writeFile, rm, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { fixture, directories } from "../test-fixture.js";
it("cancels an uncommitted activated copy without deleting either data tree", async () => {
  const f = await fixture();
  await expect(
    f.api.executePendingDataDirectoryMigration({
      assertNoWriters: async () => {},
      copy: async (...args) => {
        await f.files.copyDataDirectory(...args);
        throw new Error("before settings commit");
      },
    }),
  ).rejects.toThrow("before settings commit");
  expect(await f.api.canCancelPendingDataDirectoryMigration()).toBe(true);
  await f.api.cancelPendingDataDirectoryMigration();
  expect((await f.service.get()).pendingDataDirectoryMigration).toBeUndefined();
  expect((await f.service.get()).dataBaseDir).toBeUndefined();
  for (const base of [f.source, f.target])
    expect((await stat(join(base, ".uwork", "cli", "db", "db.sqlite"))).isFile()).toBe(true);
  expect((await f.api.inspectDataDirectoryStartup()).required).toBe(false);
});
it("restores missing bootstrap for cancellation and preserves recovered pre-ready hardware choice", async () => {
  const f = await fixture(true);
  await f.service.update({ desktopChromiumHardwareAccelerationEnabled: false });
  const retired = join(f.home, "retired-owner");
  await expect(
    f.api.executePendingDataDirectoryMigration({
      assertNoWriters: async () => {},
      copy: async () => {
        await rename(join(f.home, ".uwork"), retired);
        throw new Error("retired owner");
      },
    }),
  ).rejects.toThrow("retired owner");
  expect(
    (await f.api.inspectDataDirectoryStartup(f.home)).desktopChromiumHardwareAccelerationEnabled,
  ).toBe(false);
  expect(await f.api.canCancelPendingDataDirectoryMigration()).toBe(true);
  await f.api.cancelPendingDataDirectoryMigration();
  const settings = await f.service.get();
  expect(settings.dataBaseDir).toBe(f.source);
  expect(settings.pendingDataDirectoryMigration).toBeUndefined();
  expect(settings.desktopChromiumHardwareAccelerationEnabled).toBe(false);
  expect((await stat(join(f.source, ".uwork", "cli", "db", "db.sqlite"))).isFile()).toBe(true);
});
it("never rolls a committed root back when a recovery record is left behind", async () => {
  const f = await fixture();
  const request = (await f.service.get()).pendingDataDirectoryMigration!;
  await expect(
    f.api.executePendingDataDirectoryMigration({
      assertNoWriters: async () => {},
      copy: async (...args) => {
        await f.files.copyDataDirectory(...args);
        throw new Error("activation done");
      },
    }),
  ).rejects.toThrow("activation done");
  await f.owner.createSettingServiceWithMigrations().commitPendingDataDirectoryMigration(request);
  expect(await f.api.canCancelPendingDataDirectoryMigration()).toBe(false);
  await expect(f.api.cancelPendingDataDirectoryMigration()).rejects.toThrow("already committed");
  await writeFile(join(f.target, ".uwork", "later.txt"), "accepted newer data");
  const copy = vi.fn();
  await f.api.executePendingDataDirectoryMigration({ assertNoWriters: async () => {}, copy });
  expect(copy).not.toHaveBeenCalled();
  expect((await f.service.get()).dataBaseDir).toBe(f.target);
  expect(await readFile(join(f.target, ".uwork", "later.txt"), "utf8")).toBe("accepted newer data");
});
it("rejects an empty recovery file instead of admitting a missing bootstrap as a fresh profile", async () => {
  const f = await fixture();
  const controls = f.owner.dataDirectoryMigrationControlPaths();
  await mkdir(controls.operationDirectory, { recursive: true });
  await writeFile(join(controls.operationDirectory, "operation.json"), "");
  await rm(f.settingsFile);
  expect((await f.api.inspectDataDirectoryStartup()).required).toBe(true);
  const copy = vi.fn();
  await expect(
    f.api.executePendingDataDirectoryMigration({ assertNoWriters: async () => {}, copy }),
  ).rejects.toMatchObject({ kind: "corrupt" });
  expect(copy).not.toHaveBeenCalled();
  expect(await f.api.canCancelPendingDataDirectoryMigration()).toBe(false);
  await expect(f.api.cancelPendingDataDirectoryMigration()).rejects.toMatchObject({
    kind: "corrupt",
  });
});
it.each(["file", "ancestor"] as const)(
  "rejects a dangling bootstrap %s symlink without a recovery record",
  async (kind) => {
    const { symlink } = await import("node:fs/promises");
    const f = await fixture();
    if (kind === "file") {
      await rm(f.settingsFile);
      await symlink(join(f.home, "offline.json"), f.settingsFile, "file");
    } else {
      await rename(join(f.home, ".uwork", "v2"), join(f.home, "retired-v2"));
      await symlink(join(f.home, "offline-v2"), join(f.home, ".uwork", "v2"), "dir");
    }
    expect((await f.api.inspectDataDirectoryStartup()).required).toBe(true);
    await expect(
      f.api.executePendingDataDirectoryMigration({ assertNoWriters: async () => {} }),
    ).rejects.toMatchObject({ kind: "corrupt" });
    expect(await f.api.canCancelPendingDataDirectoryMigration()).toBe(false);
  },
);
it("uses the same injected initial default when Host env contains its different active root", async () => {
  const home = await mkdtemp(join(tmpdir(), "uwork-default-owner-"));
  const active = await mkdtemp(join(tmpdir(), "uwork-active-root-"));
  const initial = await mkdtemp(join(tmpdir(), "uwork-initial-default-"));
  directories.push(home, active, initial);
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", home);
  vi.stubEnv("UWORK_DATA_BASE_DIR", active);
  vi.resetModules();
  const owner = await import("../../../setting/settingService.js");
  const paths = await import("../../../paths.js");
  const api = await import("../../cold-startup-entry.js");
  paths.setDataBaseDir(active);
  await mkdir(join(home, ".uwork", "v2"), { recursive: true });
  await writeFile(
    join(home, ".uwork", "v2", "setting.json"),
    JSON.stringify({ dataBaseDir: active }),
  );
  await mkdir(join(active, ".uwork"), { recursive: true });
  await writeFile(join(active, ".uwork", "history.txt"), "active history");
  const service = owner.createSettingService({ defaultDataBaseDir: initial });
  expect(await service.getDataDirectoryInfo()).toEqual({
    activeBaseDir: active,
    defaultBaseDir: initial,
  });
  await service.updateDataBaseDir(undefined);
  expect((await service.get()).pendingDataDirectoryMigration).toMatchObject({
    sourceBaseDir: active,
    targetBaseDir: initial,
    resetToDefault: true,
  });
  await api.executePendingDataDirectoryMigration({
    defaultDataBaseDir: initial,
    assertNoWriters: async () => {},
  });
  expect((await service.get()).dataBaseDir).toBeUndefined();
  expect((await service.get()).pendingDataDirectoryMigration).toBeUndefined();
  expect(await readFile(join(initial, ".uwork", "history.txt"), "utf8")).toBe("active history");
});

it("refreshes recovery bytes on the same request before a retry retires the bootstrap", async () => {
  const f = await fixture(true);
  await f.service.update({ locale: "en-US" });
  const request = (await f.service.get()).pendingDataDirectoryMigration;
  await expect(
    f.api.executePendingDataDirectoryMigration({
      assertNoWriters: async () => {},
      copy: async () => {
        throw new Error("first copy failed");
      },
    }),
  ).rejects.toThrow("first copy failed");
  // 第一次失败后其他设置仍可由同一 owner 合法更新；请求身份不变。
  await f.service.update({ locale: "zh-CN" });
  expect((await f.service.get()).pendingDataDirectoryMigration).toEqual(request);
  const latestBootstrap = await readFile(f.settingsFile, "utf8");
  await expect(
    f.api.executePendingDataDirectoryMigration({
      assertNoWriters: async () => {},
      copy: async () => {
        // 真实 rename 模拟 reset 激活已 retire 唯一 owner、尚未恢复原文件的故障窗口。
        await rename(join(f.home, ".uwork"), join(f.home, "retired-retry-owner"));
        throw new Error("retry retired bootstrap");
      },
    }),
  ).rejects.toThrow("retry retired bootstrap");
  const operationFile = join(
    f.owner.dataDirectoryMigrationControlPaths().operationDirectory,
    "operation.json",
  );
  expect(JSON.parse(await readFile(operationFile, "utf8")).originalSettings).toBe(latestBootstrap);
  // bootstrap 暂缺时下一次重试不得用默认值重写唯一已验证恢复记录。
  const recoveryBefore = await readFile(operationFile, "utf8");
  await expect(
    f.api.executePendingDataDirectoryMigration({
      assertNoWriters: async () => {},
      copy: async () => {
        throw new Error("still retired");
      },
    }),
  ).rejects.toThrow("still retired");
  expect(await readFile(operationFile, "utf8")).toBe(recoveryBefore);
  await f.api.cancelPendingDataDirectoryMigration();
  const settings = await f.service.get();
  expect(settings.locale).toBe("zh-CN");
  expect(settings.dataBaseDir).toBe(f.source);
  expect(settings.pendingDataDirectoryMigration).toBeUndefined();
});

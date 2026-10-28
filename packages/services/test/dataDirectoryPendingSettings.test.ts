import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "uwork-pending-source-"));
  const target = await mkdtemp(join(tmpdir(), "uwork-pending-target-"));
  directories.push(home, target);
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", home);
  vi.stubEnv("UWORK_DATA_BASE_DIR", "");
  vi.resetModules();
  const { createSettingService } = await import("../src/setting/settingService.js");
  const { setDataBaseDir } = await import("../src/paths.js");
  setDataBaseDir(home);
  await mkdir(join(home, ".uwork", "v2"), { recursive: true });
  await writeFile(join(home, ".uwork", "v2", "history.txt"), "unchanged history");
  return { home, target, service: createSettingService() };
}
it("records a cold migration request without copying or changing the active directory", async () => {
  const { home, target, service } = await fixture();
  await service.updateDataBaseDir(target);
  const settings = await service.get();
  expect(settings.dataBaseDir).toBeUndefined();
  expect(settings.pendingDataDirectoryMigration).toMatchObject({
    sourceBaseDir: home,
    targetBaseDir: target,
    resetToDefault: false,
  });
  expect(settings.pendingDataDirectoryMigration?.requestId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(stat(join(target, ".uwork"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(home, ".uwork", "v2", "history.txt"), "utf8")).toBe(
    "unchanged history",
  );
  const request = settings.pendingDataDirectoryMigration;
  await service.updateDataBaseDir(target);
  expect((await service.get()).pendingDataDirectoryMigration).toEqual(request);
});
it("selecting the active directory cancels an unexecuted request", async () => {
  const { home, target, service } = await fixture();
  await service.updateDataBaseDir(target);
  await service.updateDataBaseDir(home);
  expect((await service.get()).pendingDataDirectoryMigration).toBeUndefined();
  expect((await service.get()).dataBaseDir).toBeUndefined();
  await expect(stat(join(target, ".uwork"))).rejects.toMatchObject({ code: "ENOENT" });
});

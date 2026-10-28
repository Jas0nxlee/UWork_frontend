import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, vi } from "vitest";
export const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
export async function fixture(custom = false) {
  const home = await mkdtemp(join(tmpdir(), "uwork-cold-home-"));
  const target = await mkdtemp(join(tmpdir(), "uwork-cold-target-"));
  const source = custom ? await mkdtemp(join(tmpdir(), "uwork-cold-custom-")) : home;
  directories.push(home, target, ...(custom ? [source] : []));
  vi.stubEnv("HOME", home);
  vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", home);
  vi.stubEnv("UWORK_DATA_BASE_DIR", "");
  vi.resetModules();
  const owner = await import("../../setting/settingService.js");
  const paths = await import("../../paths.js");
  paths.setDataBaseDir(source);
  await mkdir(join(home, ".uwork", "v2"), { recursive: true });
  if (custom)
    await writeFile(
      join(home, ".uwork", "v2", "setting.json"),
      JSON.stringify({ dataBaseDir: source }),
    );
  await mkdir(join(source, ".uwork", "cli", "db"), { recursive: true });
  const dbPath = join(source, ".uwork", "cli", "db", "db.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE history(id TEXT PRIMARY KEY,body TEXT);INSERT INTO history VALUES('old','preserved')",
  );
  db.close();
  const service = owner.createSettingService();
  await service.updateDataBaseDir(custom ? undefined : target);
  const api = await import("../cold-startup-entry.js");
  const files = await import("../../dataDirectoryMigration.js");
  return {
    home,
    target: custom ? home : target,
    source,
    service,
    api,
    files,
    owner,
    settingsFile: join(home, ".uwork", "v2", "setting.json"),
  };
}

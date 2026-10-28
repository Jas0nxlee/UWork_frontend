import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createDataDirectoryStartup, resolveDesktopLifecycleIdentity } from "../index.js";

it("waits for the owned storage Worker to close before admitting the next startup stage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uwork-cold-worker-"));
  const entry = join(dir, "worker.cjs");
  await writeFile(
    entry,
    `const {parentPort}=require('node:worker_threads');parentPort.postMessage({type:'progress',phase:'checking'});parentPort.postMessage({type:'done'});parentPort.close();`,
  );
  const phases: string[] = [];
  try {
    await createDataDirectoryStartup(pathToFileURL(entry)).prepare(
      (phase) => phases.push(phase),
      new AbortController().signal,
    );
    expect(phases).toEqual(["checking"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("does not admit business startup after a structured Worker failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uwork-cold-worker-error-"));
  const entry = join(dir, "worker.cjs");
  await writeFile(
    entry,
    `const {parentPort}=require('node:worker_threads');parentPort.postMessage({type:'failed',errorCode:'permission_denied',systemCode:'EACCES'});parentPort.close();`,
  );
  try {
    await expect(
      createDataDirectoryStartup(pathToFileURL(entry)).prepare(
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: "permission_denied", code: "EACCES" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("keeps Chromium-managed userData independent of the migrated business root", () => {
  let readAppData = false;
  const value = resolveDesktopLifecycleIdentity(
    false,
    "stable",
    {
      ZCODE_DESKTOP_APPLICATION_NAME: "Isolated",
      ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA: "1",
      UWORK_DATA_BASE_DIR: "/new/business",
    },
    () => {
      readAppData = true;
      return "/appData";
    },
  );
  expect(value.runtimeApplicationName).toBe("Isolated");
  expect(value.runtimeUserDataPath).toBeUndefined();
  expect(readAppData).toBe(false);
});
it("preserves the compiled local-development packaged identity before and after cold migration", () => {
  const value = resolveDesktopLifecycleIdentity(true, "stable", {}, () => "/appData", true);
  expect(value.runtimeApplicationName).toBe("UWork Local Development");
  expect(value.runtimeUserDataPath).toBe(join("/appData", "UWork"));
  expect(
    resolveDesktopLifecycleIdentity(
      true,
      "stable",
      { UWORK_BUILD_PROFILE: "local-development" },
      () => "/appData",
    ).runtimeApplicationName,
  ).toBe("UWork");
});
it("passes the effective desktop home to the real Worker without changing parent HOME", async () => {
  const { mkdir, readFile } = await import("node:fs/promises");
  const { vi } = await import("vitest");
  const dir = await mkdtemp(join(tmpdir(), "uwork-cold-home-isolation-"));
  const a = join(dir, "A");
  const b = join(dir, "B");
  const entry = join(dir, "worker.cjs");
  const output = join(dir, "env.json");
  await mkdir(join(a, ".uwork", "v2"), { recursive: true });
  await mkdir(join(b, ".uwork", "v2"), { recursive: true });
  await writeFile(join(a, ".uwork", "v2", "setting.json"), "A must remain unchanged");
  await writeFile(join(b, ".uwork", "v2", "setting.json"), "B selected");
  vi.stubEnv("HOME", a);
  vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", b);
  await writeFile(
    entry,
    `const fs=require('node:fs');const path=require('node:path');const {parentPort}=require('node:worker_threads');fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({home:process.env.HOME,user:process.env.USERPROFILE,desktop:process.env.ZCODE_DESKTOP_HOME_DIR,contents:fs.readFileSync(path.join(process.env.ZCODE_DESKTOP_HOME_DIR,'.uwork','v2','setting.json'),'utf8')}));parentPort.postMessage({type:'done'});parentPort.close();`,
  );
  try {
    await createDataDirectoryStartup(pathToFileURL(entry), b).prepare(
      () => {},
      new AbortController().signal,
    );
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      home: b,
      user: b,
      desktop: b,
      contents: "B selected",
    });
    expect(process.env.HOME).toBe(a);
    expect(await readFile(join(a, ".uwork", "v2", "setting.json"), "utf8")).toBe(
      "A must remain unchanged",
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

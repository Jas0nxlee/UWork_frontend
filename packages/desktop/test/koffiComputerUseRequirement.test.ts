import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  isKoffiRequiredByComputerUse,
  stageKoffiIntoBundledAgents,
  verifyStagedKoffi,
} from "../scripts/koffi-package-assets.mjs";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});
async function fixture(manifest: Record<string, unknown> | null) {
  const root = await mkdtemp(join(tmpdir(), "uwork-koffi-dependency-"));
  roots.push(root);
  const desktopPackageRoot = join(root, "packages", "desktop");
  const producer = join(desktopPackageRoot, "node_modules", "@zcode", "zcode-cua");
  if (manifest) {
    await mkdir(producer, { recursive: true });
    await writeFile(join(producer, "package.json"), JSON.stringify(manifest));
  }
  return {
    root,
    desktopPackageRoot,
    glmDir: join(root, "glm"),
    targetPlatform: { os: "darwin", arch: "arm64" },
  };
}

it("新公开 producer 不声明 koffi 时不因真实 producer 身份加载额外 FFI", async () => {
  const f = await fixture({ dependencies: { "@trycua/cua-driver": "0.28.2" } });
  expect(isKoffiRequiredByComputerUse(f)).toBe(false);
});

it.each(["dependencies", "optionalDependencies", "peerDependencies"])(
  "保留旧 producer 的 %s koffi 依赖声明",
  async (field) => {
    const f = await fixture({ [field]: { koffi: "2.12.0" } });
    expect(isKoffiRequiredByComputerUse(f)).toBe(true);
  },
);

it("最近的无koffi producer 覆盖上层旧依赖声明；缺包时不需要koffi", async () => {
  const f = await fixture({ dependencies: {} });
  const hoisted = join(f.root, "node_modules", "@zcode", "zcode-cua");
  await mkdir(hoisted, { recursive: true });
  await writeFile(
    join(hoisted, "package.json"),
    JSON.stringify({ dependencies: { koffi: "2.12.0" } }),
  );
  expect(isKoffiRequiredByComputerUse(f)).toBe(false);
  const absent = await fixture(null);
  expect(isKoffiRequiredByComputerUse(absent)).toBe(false);
});

it("无koffi声明时跳过native校验并清除该插件陈旧生成物", async () => {
  const f = await fixture({ dependencies: { "@trycua/cua-driver": "0.28.2" } });
  const stale = join(f.glmDir, "node_modules", "koffi");
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "index.js"), "stale runtime");
  expect(
    stageKoffiIntoBundledAgents({ ...f, koffiPackageRoot: join(f.root, "missing-package") }),
  ).toBeUndefined();
  expect(existsSync(stale)).toBe(false);
  expect(verifyStagedKoffi({ ...f, resourcesDir: f.root })).toEqual([]);
});

it("旧producer声明koffi时仍暂存真实目标文件并保留缺文件校验", async () => {
  const f = await fixture({ dependencies: { koffi: "2.12.0" } });
  expect(verifyStagedKoffi({ ...f, resourcesDir: f.root })).not.toEqual([]);
  const source = join(f.root, "koffi-source");
  const nativeDir = join(source, "build", "koffi", "darwin_arm64");
  await mkdir(nativeDir, { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "koffi", version: "2.12.0" }),
  );
  await writeFile(join(source, "index.js"), "export default {};");
  await writeFile(join(source, "index.d.ts"), "export {};");
  await writeFile(join(nativeDir, "koffi.node"), Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
  const pluginDir = join(f.glmDir, "packages", "zcode-cua-plugin");
  const staged = stageKoffiIntoBundledAgents({ ...f, glmDir: pluginDir, koffiPackageRoot: source });
  expect(await readFile(staged!)).toEqual(Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
  expect(verifyStagedKoffi({ ...f, resourcesDir: f.root })).toEqual([]);
});

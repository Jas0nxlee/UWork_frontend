import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { readVerifiedNotices } from "../third-party-notices.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("copied Material Icon roots are available from a checkout without generated mirrors", async () => {
  const copied = JSON.parse(
    await readFile(resolve(repositoryRoot, "third-party/copied-components.json"), "utf8"),
  );
  const icons = copied.find((component) => component.id === "Material Icon Theme");
  assert.ok(icons, "Material Icon Theme must retain its copied-source declaration");
  for (const root of icons.roots) {
    // 合并后 Share 已复用 Web 图标；登记生成镜像会让本地副本掩盖干净检出的 ENOENT。
    const { stdout } = await exec("git", ["ls-files", "-z", "--", root], {
      cwd: repositoryRoot,
    });
    const files = stdout.split("\0").filter(Boolean);
    assert.ok(files.length > 0, `Copied icon root has no tracked sources: ${root}`);
    for (const file of files) await readFile(resolve(repositoryRoot, file));
  }
});

test("generated notices retain workspace patches and reject changed patch files", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "uwork-notice-patches-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const patchFile = "patches/example.patch";
  const patchContent = "diff --git a/example.js b/example.js\n";
  const fixtureFiles = {
    "package.json": JSON.stringify({
      name: "fixture",
      pnpm: { patchedDependencies: { "legacy@1.0.0": "patches/missing-legacy.patch" } },
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": `patchedDependencies:\n  example@1.0.0: ${patchFile}\n`,
    [patchFile]: patchContent,
    "third-party/npm-overrides.json": "[]",
    "third-party/copied-components.json": "[]",
    "third-party/embedded-components.json": "[]",
    "third-party/runtime/sources.json": JSON.stringify({ node: [] }),
    "third-party/native-search/sources.json": JSON.stringify({
      inputs: {},
      components: [],
      archives: [],
      scope: "fixture",
    }),
    "scripts/license-texts/Apache-2.0.txt": "fixture license text\n",
  };
  for (const [file, content] of Object.entries(fixtureFiles)) {
    const path = resolve(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  // 依赖安装图不属于此回归；生成、补丁读取、声明输出和新鲜度检查均运行真实实现。
  await exec(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "-e",
      `
        import { mock } from "node:test";
        import { hashBytes } from "./scripts/third-party-npm.mjs";
        mock.module("./scripts/third-party-npm.mjs", { namedExports: {
          hashBytes,
          collectNpmNotices: async () => ({ packages: [], notInstalled: [], workspaceManifests: [] }),
        }});
        const { generateThirdPartyNotices } = await import("./scripts/generate-third-party-notices.mjs");
        await generateThirdPartyNotices(process.argv[1]);
      `,
      root,
    ],
    { cwd: repositoryRoot },
  );
  const inventory = JSON.parse(await readFile(resolve(root, "third-party/inventory.json"), "utf8"));
  assert.deepEqual(inventory.patches, [
    { package: "example@1.0.0", file: patchFile, sha256: hash(patchContent) },
  ]);
  assert.equal(inventory.inputs[patchFile], hash(patchContent));
  const notices = await readVerifiedNotices(root);
  assert.match(notices.toString("utf8"), /example@1\.0\.0: modified by ZCode/);
  assert.doesNotMatch(notices.toString("utf8"), /legacy@1\.0\.0/);
  await writeFile(resolve(root, patchFile), `${patchContent}changed\n`);
  await assert.rejects(
    readVerifiedNotices(root),
    /Third-party input changed: patches\/example.patch/,
  );
});

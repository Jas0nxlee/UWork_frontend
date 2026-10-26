import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createCuaHelperBuildPlan, stageCuaDriverRuntime } from "../build-cua-helper-app.mjs";

test("dev 与随包 Helper 使用各自明确的身份和现有落点", () => {
  const options = { repoRoot: "/repo", arch: "arm64", version: "0.1.2" };
  const production = createCuaHelperBuildPlan(options);
  const development = createCuaHelperBuildPlan({ ...options, development: true });
  assert.equal(
    production.appPath,
    "/repo/packages/desktop/bundled-cua-helper/arm64/ZCode Computer Use.app",
  );
  assert.equal(
    development.appPath,
    "/repo/packages/desktop/dist-cua-helper/ZCode Computer Use Dev.app",
  );
  assert.equal(production.bundleId, "dev.zcode.cua-helper");
  assert.equal(development.bundleId, "dev.zcode.cua-helper.dev");
  assert.equal(production.allowUnsignedLauncher, false);
  assert.equal(development.allowUnsignedLauncher, true);
  assert.throws(() => createCuaHelperBuildPlan({ ...options, arch: "../arm64" }), /architecture/);
  assert.throws(() => createCuaHelperBuildPlan({ ...options, version: "<unsafe>" }), /version/);
});

test("runtime stage 保留真实依赖与许可，只携带目标平台原生产物", async () => {
  const root = await mkdtemp(join(tmpdir(), "uwork-cua-build-"));
  try {
    const source = join(root, "source");
    const destination = join(root, "target");
    const writePackage = async (name, manifest, file = "module.js") => {
      const path = join(source, "node_modules", name);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "package.json"), JSON.stringify({ name, ...manifest }));
      await writeFile(join(path, file), "native-or-js");
      await writeFile(join(path, "LICENSE"), "fixture license");
    };
    await writePackage("@trycua/cua-driver", {
      dependencies: { "@ubjs/node": "1" },
      optionalDependencies: {
        "@trycua/cua-driver-darwin-universal": "1",
        "@trycua/cua-driver-win32-x64-msvc": "1",
      },
    });
    await writePackage("@ubjs/node", {});
    await writePackage("@trycua/cua-driver-darwin-universal", { os: ["darwin"] }, "native.node");
    await writePackage(
      "@trycua/cua-driver-win32-x64-msvc",
      { os: ["win32"], cpu: ["x64"] },
      "native.node",
    );
    const modules = await stageCuaDriverRuntime({
      producerRoot: source,
      destination,
      platform: "darwin",
      arch: "arm64",
    });
    assert.deepEqual(
      modules.sort(),
      ["@trycua/cua-driver", "@trycua/cua-driver-darwin-universal", "@ubjs/node"].sort(),
    );
    assert.equal(
      await readFile(join(destination, "node_modules/@trycua/cua-driver/LICENSE"), "utf8"),
      "fixture license",
    );
    await rm(join(source, "node_modules/@ubjs/node"), { recursive: true });
    await assert.rejects(
      stageCuaDriverRuntime({
        producerRoot: source,
        destination: join(root, "broken"),
        platform: "darwin",
        arch: "arm64",
      }),
      /@ubjs\/node/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  buildHelperOpenArgs,
  createCuaHelperInstaller,
  resolveCuaHelperInstallRoot,
} from "../broker-server.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "uwci-"));
  roots.push(root);
  const appPath = join(root, "source", "ZCode Computer Use.app");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents", "Info.plist"), "fixture");
  await writeFile(join(appPath, "Contents", "MacOS", "Helper"), "version-one");
  const env = {
    HOME: root,
    ZCODE_HOME: join(root, "data"),
    ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
  };
  const dependencies = {
    readPlist: async () => ({
      CFBundleIdentifier: "dev.zcode.cua-helper",
      CFBundleExecutable: "Helper",
      CFBundleDisplayName: "UWork Computer Use",
    }),
    readExecutableArchs: async () => [process.arch],
    verifyCodeSignature: async () => {},
    readTeamIdentifier: async () => "TESTTEAM",
    verifyGatekeeper: async () => {},
  };
  return { root, appPath, env, dependencies };
}

async function signedParentFixture(
  options: {
    parentId?: string;
    parentTeam?: string;
    helperTeam?: string;
    unsignedParent?: boolean;
  } = {},
) {
  const f = await fixture();
  const parentApp = join(f.root, "UWork.app");
  const bundledHelper = join(
    parentApp,
    "Contents",
    "Resources",
    "cua-helper",
    "ZCode Computer Use.app",
  );
  await cp(f.appPath, bundledHelper, { recursive: true });
  const checks: string[] = [];
  const dependencies = {
    ...f.dependencies,
    readPlist: async (appPath: string) => ({
      CFBundleIdentifier:
        appPath === parentApp ? (options.parentId ?? "dev.zcode.app") : "dev.zcode.cua-helper",
      CFBundleExecutable: "Helper",
      CFBundleDisplayName: "UWork Computer Use",
    }),
    verifyCodeSignature: async (appPath: string) => {
      checks.push(appPath);
      if (appPath === parentApp && options.unsignedParent)
        throw new Error("Parent App signature is invalid");
    },
    readTeamIdentifier: async (appPath: string) =>
      appPath === parentApp
        ? (options.parentTeam ?? "TESTTEAM01")
        : (options.helperTeam ?? "TESTTEAM01"),
  };
  return {
    ...f,
    parentApp,
    bundledHelper,
    checks,
    dependencies,
    env: { HOME: f.root, ZCODE_HOME: join(f.root, "signed-data") },
  };
}

it.each(["dev.zcode.app", "dev.zcode.app.preview"])(
  "正式发行缺省锚定已验签父 App 的相同 Team：%s",
  async (parentId) => {
    const f = await signedParentFixture({ parentId });
    const installed = await createCuaHelperInstaller({
      env: f.env,
      bundledAppPath: f.bundledHelper,
      dependencies: f.dependencies,
    }).ensureInstalled();
    expect(await readFile(join(installed, "Contents", "MacOS", "Helper"), "utf8")).toBe(
      "version-one",
    );
    expect(f.checks).toContain(f.parentApp);
  },
);

it("无法用 Helper 自己的 Team 替代未签名父 App 的信任锚点", async () => {
  const f = await signedParentFixture({ unsignedParent: true });
  await expect(
    createCuaHelperInstaller({
      env: f.env,
      bundledAppPath: f.bundledHelper,
      dependencies: f.dependencies,
    }).ensureInstalled(),
  ).rejects.toThrow(/signature/i);
});

it.each([
  { parentId: "other.vendor.app" },
  { parentTeam: "not set" },
  { helperTeam: "OTHERTEAM1" },
])("正式发行拒绝错误父 bundle、ad-hoc 或不一致 Helper Team：%j", async (options) => {
  const f = await signedParentFixture(options);
  await expect(
    createCuaHelperInstaller({
      env: f.env,
      bundledAppPath: f.bundledHelper,
      dependencies: f.dependencies,
    }).ensureInstalled(),
  ).rejects.toThrow(/bundle|team/i);
});

it("显式 Team 配置也必须与已验签父 App 一致", async () => {
  const f = await signedParentFixture({ helperTeam: "OTHERTEAM1" });
  await expect(
    createCuaHelperInstaller({
      env: { ...f.env, ZCODE_CUA_HELPER_TEAM_ID: "OTHERTEAM1" },
      bundledAppPath: f.bundledHelper,
      dependencies: f.dependencies,
    }).ensureInstalled(),
  ).rejects.toThrow(/team/i);
});

it("显式 Team 不能让伪造 bundled 路径成为正式来源", async () => {
  const f = await fixture();
  await expect(
    createCuaHelperInstaller({
      env: { HOME: f.root, ZCODE_CUA_HELPER_TEAM_ID: "TESTTEAM" },
      bundledAppPath: f.appPath,
      dependencies: f.dependencies,
    }).ensureInstalled(),
  ).rejects.toThrow(/bundle|source|parent|team/i);
});

it("形式正确但经 symlink 逃出父 App 的 source 仍然拒绝", async () => {
  const f = await signedParentFixture();
  const from = join(f.parentApp, "Contents", "Resources", "cua-helper");
  const outside = join(f.root, "outside-resources");
  await rename(from, outside);
  await symlink(outside, from);
  await expect(
    createCuaHelperInstaller({
      env: f.env,
      bundledAppPath: f.bundledHelper,
      dependencies: f.dependencies,
    }).ensureInstalled(),
  ).rejects.toThrow(/bundle|source|parent|team/i);
});

it("只从显式 bundled source 原子安装，并刷新同版本内容", async () => {
  const f = await fixture();
  const installer = createCuaHelperInstaller({
    env: f.env,
    bundledAppPath: f.appPath,
    dependencies: f.dependencies,
  });
  const installed = await installer.ensureInstalled();
  expect(installed.startsWith(resolveCuaHelperInstallRoot(f.env)!)).toBe(true);
  expect(await readFile(join(installed, "Contents", "MacOS", "Helper"), "utf8")).toBe(
    "version-one",
  );
  await writeFile(join(f.appPath, "Contents", "MacOS", "Helper"), "version-two");
  await installer.ensureInstalled();
  expect(await readFile(join(installed, "Contents", "MacOS", "Helper"), "utf8")).toBe(
    "version-two",
  );
});

it("错误 bundle 身份拒绝且不覆盖已安装 Helper", async () => {
  const f = await fixture();
  const installer = createCuaHelperInstaller({
    env: f.env,
    bundledAppPath: f.appPath,
    dependencies: f.dependencies,
  });
  const installed = await installer.ensureInstalled();
  f.dependencies.readPlist = async () => ({
    CFBundleIdentifier: "different.app",
    CFBundleExecutable: "Helper",
    CFBundleDisplayName: "UWork Computer Use",
  });
  await expect(
    createCuaHelperInstaller({
      env: f.env,
      bundledAppPath: f.appPath,
      dependencies: f.dependencies,
    }).ensureInstalled(),
  ).rejects.toThrow(/bundle/i);
  expect(await readFile(join(installed, "Contents", "MacOS", "Helper"), "utf8")).toBe(
    "version-one",
  );
});

it("正式模式未锚定签名 team 时拒绝；错误 team 同样拒绝", async () => {
  const f = await fixture();
  const env = { HOME: f.root, ZCODE_HOME: join(f.root, "production") };
  await expect(
    createCuaHelperInstaller({
      env,
      bundledAppPath: f.appPath,
      dependencies: f.dependencies,
    }).ensureInstalled(),
  ).rejects.toThrow(/team/i);
  await expect(
    createCuaHelperInstaller({
      env: { ...env, ZCODE_CUA_HELPER_TEAM_ID: "OTHERTEAM" },
      bundledAppPath: f.appPath,
      dependencies: f.dependencies,
    }).ensureInstalled(),
  ).rejects.toThrow(/team/i);
});

it("启动参数必须经 LaunchServices 指向精确 app 和 socket", () => {
  expect(
    buildHelperOpenArgs({ appPath: "/fixture/Helper.app", socketPath: "/tmp/private/b.sock" }),
  ).toEqual(["-n", "-a", "/fixture/Helper.app", "--args", "--socket", "/tmp/private/b.sock"]);
});

it("开发 launcher/client 例外只按显式布尔标记写入 argv", () => {
  const spec = { appPath: "/fixture/Helper.app", socketPath: "/tmp/private/b.sock" };
  expect(
    buildHelperOpenArgs({
      ...spec,
      allowUnsignedLauncherLocalDev: true,
      allowExternalBrokerClientLocalDev: true,
    }).slice(-2),
  ).toEqual(["--allow-unsigned-launcher-local-dev", "--allow-external-broker-client-local-dev"]);
  expect(
    buildHelperOpenArgs({
      ...spec,
      allowUnsignedLauncherLocalDev: false,
      allowExternalBrokerClientLocalDev: false,
    }),
  ).not.toContain("--allow-unsigned-launcher-local-dev");
});

it("拒绝把 bundle 外的运行时代码经符号链接带进 Helper", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "outside.js"), "external code");
  await symlink(join(f.root, "outside.js"), join(f.appPath, "Contents", "outside.js"));
  await expect(
    createCuaHelperInstaller({
      env: f.env,
      bundledAppPath: f.appPath,
      dependencies: f.dependencies,
    }).ensureInstalled(),
  ).rejects.toThrow(/escape|outside/i);
});

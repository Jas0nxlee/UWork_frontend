import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { CuaHelperError } from "./broker.js";
import {
  DEV_CUA_HELPER_BUNDLE_ID,
  DEV_HELPER_APP_NAME,
  HELPER_APP_NAME,
  HELPER_BUNDLE_ID,
} from "./broker-helper-constants.js";

const runFile = promisify(execFile);
const installers = new Map();
const normalizeArch = (arch) => ({ x86_64: "x64", amd64: "x64", aarch64: "arm64" })[arch] ?? arch;

export function isCuaLocalDevelopmentRuntime(
  env = process.env,
  compiledLocalDevelopmentRuntime = true,
) {
  return (
    compiledLocalDevelopmentRuntime &&
    env.ZCODE_RUNTIME_ENV !== "production" &&
    env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL === "1"
  );
}

export function resolveHelperAppName(env = process.env) {
  return isCuaLocalDevelopmentRuntime(env) ? DEV_HELPER_APP_NAME : HELPER_APP_NAME;
}

export function resolveCuaHelperInstallRoot(env = process.env) {
  const root =
    env.ZCODE_STORAGE_DIR?.trim() ||
    env.UWORK_HOME?.trim() ||
    env.ZCODE_HOME?.trim() ||
    join(
      env.UWORK_DATA_BASE_DIR?.trim() || env.ZCODE_DATA_BASE_DIR?.trim() || env.HOME || homedir(),
      ".uwork",
    );
  const variant = env.ZCODE_CUA_HELPER_INSTALL_VARIANT?.trim();
  if (variant && !/^[a-zA-Z0-9_-]+$/u.test(variant))
    throw new CuaHelperError("Invalid Computer Use Helper install variant");
  return join(root, "computer-use", ...(variant ? [variant] : []));
}

export function standaloneHelperCandidatePaths(env = process.env) {
  return [join(resolveCuaHelperInstallRoot(env), resolveHelperAppName(env))];
}

export function buildHelperOpenArgs(spec, launcherPid) {
  if (!spec?.appPath || (!spec.socketPath && !spec.permissionStatusFile))
    throw new CuaHelperError("Helper launch requires an app and socket or permission status file");
  const args = ["-n", "-a", spec.appPath, "--args"];
  if (spec.socketPath) args.push("--socket", spec.socketPath);
  if (spec.permissionStatusFile) args.push("--permission-status-file", spec.permissionStatusFile);
  if (launcherPid) args.push("--launcher-pid", String(launcherPid));
  if (spec.allowUnsignedLauncherLocalDev === true) args.push("--allow-unsigned-launcher-local-dev");
  if (spec.allowExternalBrokerClientLocalDev === true)
    args.push("--allow-external-broker-client-local-dev");
  return args;
}

async function readPlist(appPath) {
  const { stdout } = await runFile(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", join(appPath, "Contents", "Info.plist")],
    { timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function identityFromPlist(appPath, plist) {
  if (
    typeof plist.CFBundleExecutable !== "string" ||
    basename(plist.CFBundleExecutable) !== plist.CFBundleExecutable
  )
    throw new CuaHelperError("Invalid Helper bundle executable");
  const executablePath = join(appPath, "Contents", "MacOS", plist.CFBundleExecutable);
  const physicalApp = await realpath(appPath);
  const physicalExecutable = await realpath(executablePath);
  const child = relative(physicalApp, physicalExecutable);
  if (!child || child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child))
    throw new CuaHelperError("Helper executable escapes its bundle");
  return {
    appPath,
    executablePath,
    displayName:
      plist.CFBundleDisplayName || plist.CFBundleName || HELPER_APP_NAME.replace(/\.app$/u, ""),
    bundleId: plist.CFBundleIdentifier,
  };
}

export async function resolveHelperPermissionSubjectIdentity(appPath) {
  return identityFromPlist(appPath, await readPlist(appPath));
}

export const defaultCuaHelperVerifierDependencies = {
  readPlist,
  async readExecutableArchs(executablePath) {
    const { stdout } = await runFile("/usr/bin/lipo", ["-archs", executablePath], {
      timeout: 5000,
    });
    return stdout.trim().split(/\s+/u).map(normalizeArch);
  },
  async verifyCodeSignature(appPath) {
    await runFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
      timeout: 15000,
    });
  },
  async readTeamIdentifier(appPath) {
    const { stderr } = await runFile("/usr/bin/codesign", ["-d", "--verbose=4", appPath], {
      timeout: 5000,
    });
    return /^TeamIdentifier=(.+)$/mu.exec(stderr)?.[1]?.trim();
  },
  async verifyTeamIdentifier(appPath, expected) {
    const actual = await this.readTeamIdentifier(appPath);
    if (!expected || actual !== expected)
      throw new CuaHelperError("Computer Use Helper signing team does not match the expected team");
  },
  async verifyGatekeeper(appPath) {
    await runFile("/usr/sbin/spctl", ["-a", "-vv", "-t", "exec", appPath], { timeout: 15000 });
  },
};

async function treeDigest(path) {
  const hash = createHash("sha256");
  const root = await realpath(path);
  const walk = async (current, key) => {
    const stat = await lstat(current);
    hash.update(`${key}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) {
      const linkTarget = relative(root, await realpath(current));
      // 原因：签名 bundle 的资源引用不能借 symlink 越过安装来源边界去加载外部代码。
      if (linkTarget === ".." || linkTarget.startsWith(`..${sep}`) || isAbsolute(linkTarget))
        throw new CuaHelperError("Computer Use Helper symlink escapes its bundle");
      hash.update(`link:${await readlink(current)}`);
      return;
    }
    if (stat.isDirectory()) {
      for (const child of (await readdir(current)).sort())
        await walk(join(current, child), `${key}/${child}`);
    } else if (stat.isFile()) hash.update(await readFile(current));
    else throw new CuaHelperError("Unsupported file in Computer Use Helper bundle");
  };
  await walk(path, "");
  return hash.digest("hex");
}

async function expectedTeamFromBundledParent(source, env, dependencies) {
  const sourcePath = typeof source === "string" && isAbsolute(source) ? resolve(source) : "";
  const parentApp = sourcePath ? resolve(sourcePath, "../../../..") : "";
  const expectedSource = join(parentApp, "Contents", "Resources", "cua-helper", HELPER_APP_NAME);
  if (!sourcePath || !parentApp.endsWith(".app") || sourcePath !== expectedSource) {
    throw new CuaHelperError(
      "Computer Use signing team cannot be anchored: source is not inside the bundled UWork App",
    );
  }
  const [parentStat, physicalParent, physicalSource] = await Promise.all([
    lstat(parentApp),
    realpath(parentApp),
    realpath(sourcePath),
  ]);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    physicalSource !== join(physicalParent, "Contents", "Resources", "cua-helper", HELPER_APP_NAME)
  ) {
    throw new CuaHelperError("Computer Use Helper source escapes the parent App bundle");
  }
  // 原因：正式桌面不会下发开发环境 Team 变量。只从固定随包位置的已验签 UWork 主 App
  // 派生默认锚点；不能把待安装 Helper 自报的 Team 当成信任来源，显式配置也不能换掉父 App 的 Team。
  await dependencies.verifyCodeSignature(parentApp);
  const parentPlist = await dependencies.readPlist(parentApp);
  if (!["dev.zcode.app", "dev.zcode.app.preview"].includes(parentPlist.CFBundleIdentifier)) {
    throw new CuaHelperError("Computer Use Helper parent bundle identifier does not match UWork");
  }
  const parentTeam = await dependencies.readTeamIdentifier(parentApp);
  if (typeof parentTeam !== "string" || !/^[A-Z0-9]{10}$/u.test(parentTeam)) {
    throw new CuaHelperError("Computer Use Helper parent App has no valid non-ad-hoc signing team");
  }
  const configuredTeam = env.ZCODE_CUA_HELPER_TEAM_ID?.trim();
  if (configuredTeam && configuredTeam !== parentTeam) {
    throw new CuaHelperError(
      "Configured Computer Use Helper signing team differs from its parent App",
    );
  }
  await dependencies.verifyGatekeeper(parentApp);
  return parentTeam;
}

export function createCuaHelperInstaller(options = {}) {
  const env = options.env ?? process.env;
  const dependencies = { ...defaultCuaHelperVerifierDependencies, ...options.dependencies };
  const source =
    options.bundledAppPath ??
    (isCuaLocalDevelopmentRuntime(env) ? env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH?.trim() : undefined);
  const installRoot = resolveCuaHelperInstallRoot(env);
  const target = join(installRoot, resolveHelperAppName(env));
  const verifyInstalled = async (appPath) => {
    const appStat = await lstat(appPath);
    if (!appStat.isDirectory() || appStat.isSymbolicLink())
      throw new CuaHelperError("Helper bundle is not a regular app directory");
    const plist = await dependencies.readPlist(appPath);
    const identity = await identityFromPlist(appPath, plist);
    const allowedIds = isCuaLocalDevelopmentRuntime(env)
      ? [HELPER_BUNDLE_ID, DEV_CUA_HELPER_BUNDLE_ID]
      : [HELPER_BUNDLE_ID];
    if (!allowedIds.includes(identity.bundleId))
      throw new CuaHelperError("Computer Use Helper bundle identifier does not match");
    const archs = (await dependencies.readExecutableArchs(identity.executablePath)).map(
      normalizeArch,
    );
    if (!archs.includes(normalizeArch(process.arch)))
      throw new CuaHelperError("Computer Use Helper architecture does not match this host");
    // 修复依据：正式安装必须有明确的签名锚点，不能把任意非 ad-hoc team 当作可信来源。
    await dependencies.verifyCodeSignature(appPath);
    if (!isCuaLocalDevelopmentRuntime(env)) {
      const expectedTeam = await expectedTeamFromBundledParent(source, env, dependencies);
      const actualTeam = await dependencies.readTeamIdentifier(appPath);
      if (actualTeam !== expectedTeam)
        throw new CuaHelperError(
          "Computer Use Helper signing team does not match the expected team",
        );
      await dependencies.verifyGatekeeper(appPath);
    }
  };
  const install = async () => {
    if (!source || !isAbsolute(source))
      throw new CuaHelperError("A bundled Computer Use Helper source is required");
    await verifyInstalled(source);
    const sourceDigest = await treeDigest(source);
    if (resolve(source) === resolve(target)) return target;
    try {
      await verifyInstalled(target);
      if ((await treeDigest(target)) === sourceDigest) return target;
    } catch (error) {
      if (error?.code !== "ENOENT")
        options.logger?.debug?.(
          undefined,
          "Replacing Helper after source validation",
          error instanceof Error ? error.message : String(error),
        );
    }
    await mkdir(installRoot, { recursive: true, mode: 0o700 });
    const staging = join(installRoot, `.install-${randomUUID()}.app`);
    const backup = join(installRoot, `.backup-${randomUUID()}.app`);
    let backedUp = false;
    let promoted = false;
    try {
      await cp(source, staging, {
        recursive: true,
        dereference: false,
        force: false,
        errorOnExist: true,
      });
      await verifyInstalled(staging);
      if (
        (await treeDigest(staging)) !== sourceDigest ||
        (await treeDigest(source)) !== sourceDigest
      )
        throw new CuaHelperError("Computer Use Helper changed during installation");
      try {
        await rename(target, backup);
        backedUp = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(staging, target);
      promoted = true;
      await verifyInstalled(target);
      if (backedUp) await rm(backup, { recursive: true, force: true });
      return target;
    } catch (error) {
      if (promoted) await rm(target, { recursive: true, force: true });
      if (backedUp) await rename(backup, target);
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };
  return {
    verifyInstalled,
    async ensureInstalled() {
      // 同进程的 Main/Host 调用者共享安装 single-flight；目标只有一条 promotion 写入路径。
      const identity = JSON.stringify([
        source,
        isCuaLocalDevelopmentRuntime(env),
        env.ZCODE_CUA_HELPER_TEAM_ID ?? "",
      ]);
      const pending = installers.get(target);
      if (pending && pending.identity !== identity)
        throw new CuaHelperError(
          "A different Computer Use Helper installation is already in progress",
        );
      if (!pending)
        installers.set(target, {
          identity,
          promise: install().finally(() => installers.delete(target)),
        });
      return installers.get(target).promise;
    },
  };
}

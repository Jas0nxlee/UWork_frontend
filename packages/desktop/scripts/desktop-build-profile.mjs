import { join } from "node:path";

export function createLocalDevelopmentPackageArgs(arch) {
  if (!["arm64", "x64"].includes(arch))
    throw new Error("Unsupported local development architecture");
  // electron-builder 不自动发现此仓库的 JS 配置；漏传会绕过版本、Helper 和原生资源合同。
  return [
    "--filter",
    "@zcode/desktop",
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.config.js",
    "--dir",
    "--mac",
    `--${arch}`,
    "--publish",
    "never",
  ];
}

export function resolveDesktopBuildProfile(env = process.env) {
  const profile = env.UWORK_DESKTOP_BUILD_PROFILE?.trim() || "release";
  if (!["release", "local-development"].includes(profile))
    throw new Error("Invalid UWORK_DESKTOP_BUILD_PROFILE; expected release or local-development");
  return profile;
}

export function isLocalDevelopmentBuild(env = process.env) {
  return resolveDesktopBuildProfile(env) === "local-development";
}

export function resolveDesktopDisplayVersion(version, env = process.env) {
  return isLocalDevelopmentBuild(env) ? `${version}-local-development` : version;
}

export function resolveDesktopHelperPackaging(repoRoot, arch, env = process.env) {
  const development = isLocalDevelopmentBuild(env);
  const appName = development ? "ZCode Computer Use Dev.app" : "ZCode Computer Use.app";
  return {
    appName,
    source: development
      ? join(repoRoot, "packages/desktop/dist-cua-helper", appName)
      : join(repoRoot, "packages/desktop/bundled-cua-helper", arch, appName),
    development,
    bundleId: development ? "dev.zcode.cua-helper.dev" : "dev.zcode.cua-helper",
  };
}

export function validateDesktopHelperBuildManifest(manifest, env = process.env) {
  const expected = resolveDesktopHelperPackaging("", "", env);
  if (manifest.development !== expected.development || manifest.bundleId !== expected.bundleId)
    throw new Error("Computer Use Helper does not match the Desktop build profile");
}

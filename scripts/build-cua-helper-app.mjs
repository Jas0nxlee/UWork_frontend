#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isLocalDevelopmentBuild } from "../packages/desktop/scripts/desktop-build-profile.mjs";

const exec = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
const requireFromCli = createRequire(join(repositoryRoot, "apps/zcode-cli/package.json"));

export function createCuaHelperBuildPlan({ repoRoot, arch, version, development = false }) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("Unsupported Helper architecture");
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error("Invalid Helper version");
  const appName = development ? "ZCode Computer Use Dev.app" : "ZCode Computer Use.app";
  return {
    appPath: development
      ? join(repoRoot, "packages/desktop/dist-cua-helper", appName)
      : join(repoRoot, "packages/desktop/bundled-cua-helper", arch, appName),
    appName,
    bundleId: development ? "dev.zcode.cua-helper.dev" : "dev.zcode.cua-helper",
    displayName: development ? "UWork Computer Use Dev" : "UWork Computer Use",
    executableName: "UWork Computer Use",
    version,
    allowUnsignedLauncher: development,
  };
}

async function packageRootFrom(name, from) {
  let path = from;
  while (true) {
    const candidate = join(path, "node_modules", name);
    try {
      await readFile(join(candidate, "package.json"));
      return await realpath(candidate);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = dirname(path);
    if (parent === path) throw new Error(`Missing Helper runtime dependency: ${name}`);
    path = parent;
  }
}

function acceptsTarget(manifest, platform, arch) {
  const accepts = (allowed, actual) =>
    !allowed || (allowed.includes(actual) && !allowed.includes(`!${actual}`));
  return accepts(manifest.os, platform) && accepts(manifest.cpu, arch);
}

/** 原生依赖必须落在 Helper 内；只暂存目标平台，保留包内所有许可文件。 */
export async function stageCuaDriverRuntime({ producerRoot, destination, platform, arch }) {
  const visited = new Set();
  const visit = async (name, from, optional = false) => {
    if (visited.has(name)) return;
    let source;
    try {
      source = await packageRootFrom(name, from);
    } catch (error) {
      if (optional) return;
      throw error;
    }
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    if (!acceptsTarget(manifest, platform, arch)) return;
    visited.add(name);
    const target = join(destination, "node_modules", name);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, {
      recursive: true,
      dereference: true,
      filter: (path) =>
        path === source ||
        !path
          .slice(source.length + 1)
          .split(/[\\/]/)
          .includes("node_modules"),
    });
    for (const child of Object.keys(manifest.dependencies ?? {})) await visit(child, source);
    for (const child of Object.keys(manifest.optionalDependencies ?? {}))
      await visit(child, source, true);
  };
  await visit("@trycua/cua-driver", producerRoot);
  return [...visited];
}

async function nativeFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await nativeFiles(path)));
    else if (/\.(node|dylib)$/.test(entry.name)) files.push(path);
  }
  return files;
}

async function removeExternalJavaScript(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await removeExternalJavaScript(path);
    else if (/\.(?:[cm]?js|map|ts)$/.test(entry.name)) await rm(path);
  }
}

const xml = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export async function buildCuaHelperApp(options = {}) {
  if (process.platform !== "darwin") throw new Error("macOS Helper must be built on macOS");
  if (!process.version.startsWith("v24.14.0"))
    throw new Error("Helper SEA requires pinned Node 24.14.0");
  const repoRoot = options.repoRoot ?? repositoryRoot;
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const plan = createCuaHelperBuildPlan({
    repoRoot,
    arch: options.arch ?? process.arch,
    version: options.version ?? manifest.version,
    development: options.development,
  });
  if ((options.arch ?? process.arch) !== process.arch)
    throw new Error("Helper SEA cross compilation requires the matching Node binary");
  const temporary = await mkdtemp(join(tmpdir(), "uwork-helper-build-"));
  const stagedApp = join(temporary, plan.appName);
  const contents = join(stagedApp, "Contents");
  const resources = join(contents, "Resources");
  const executable = join(contents, "MacOS", plan.executableName);
  try {
    await mkdir(dirname(executable), { recursive: true });
    await mkdir(resources, { recursive: true });
    const runtime = join(resources, "runtime");
    const modules = await stageCuaDriverRuntime({
      producerRoot: join(repoRoot, "packages/zcode-cua"),
      destination: runtime,
      platform: "darwin",
      arch: options.arch ?? process.arch,
    });
    const peerLibrary = join(resources, "libuwork_cua_peer.dylib");
    const peerAddon = join(resources, "peer-addon.node");
    const nativeSource = join(repoRoot, "packages/zcode-cua/native");
    await exec("/usr/bin/xcrun", [
      "swiftc",
      join(nativeSource, "peer-validator.swift"),
      "-emit-library",
      "-parse-as-library",
      "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
      "-O",
      "-o",
      peerLibrary,
      "-framework",
      "Security",
      "-framework",
      "AppKit",
      "-Xlinker",
      "-install_name",
      "-Xlinker",
      "@rpath/libuwork_cua_peer.dylib",
    ]);
    const nodeHeaders = resolve(dirname(process.execPath), "../include/node");
    await readFile(join(nodeHeaders, "node_api.h"));
    await exec("/usr/bin/xcrun", [
      "clang++",
      "-shared",
      "-fPIC",
      "-std=c++17",
      "-DNAPI_VERSION=8",
      "-mmacosx-version-min=13.0",
      "-I",
      nodeHeaders,
      join(nativeSource, "peer-addon.cc"),
      "-L",
      resources,
      "-luwork_cua_peer",
      "-Wl,-rpath,@loader_path",
      "-undefined",
      "dynamic_lookup",
      "-o",
      peerAddon,
    ]);
    await cp(join(repoRoot, "THIRD-PARTY-NOTICES.md"), join(resources, "THIRD-PARTY-NOTICES.md"));
    const { build } = requireFromCli("esbuild");
    const bundledEntry = join(temporary, "helper.cjs");
    await build({
      entryPoints: [join(repoRoot, "packages/zcode-cua/helper-entry.js")],
      outfile: bundledEntry,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "cjs",
      define: {
        __UWORK_CUA_HELPER_DEVELOPMENT__: JSON.stringify(plan.allowUnsignedLauncher),
        "import.meta.url": "undefined",
      },
      logLevel: "warning",
      plugins: [
        {
          name: "sealed-cua-native-loader",
          setup(plugin) {
            plugin.onLoad(
              { filter: /[\\/]@trycua[\\/]cua-driver[\\/]dist[\\/]native[\\/]node-runtime\.js$/ },
              async ({ path }) => {
                const source = await readFile(path, "utf8");
                const start = source.indexOf("const FfiType =");
                const end = source.indexOf("const sdkLibrary =");
                if (start < 0 || end <= start)
                  throw new Error("Pinned CUA native loader shape changed");
                // 所有 JS 都进入 SEA；仅以固定绝对路径加载受同 Team library validation 保护的原生库。
                const contents = `import {dirname,join} from 'node:path';\n${source.slice(start, end)}\nconst nativeRoot=join(dirname(process.execPath),'..','Resources','runtime','node_modules','@trycua','cua-driver-darwin-'+process.arch);\nfunction resolveLibPath(options){if(options.crateName!=='cua_driver_sdk')throw new Error('Unexpected native library');return join(nativeRoot,'libcua_driver_sdk.dylib');}\nconst nativeModule={exports:{}}; process.dlopen(nativeModule,join(nativeRoot,'cua_driver_node_runtime.node')); const {UniffiNativeModule}=nativeModule.exports; export default {FfiType,resolveLibPath,UniffiNativeModule};`;
                return { contents, loader: "js", resolveDir: dirname(path) };
              },
            );
          },
        },
      ],
    });
    await removeExternalJavaScript(runtime);
    const blob = join(temporary, "helper.blob");
    const config = join(temporary, "sea.json");
    // Node 24.14 的 SEA 默认允许 NODE_OPTIONS 扩展，会在鉴权代码之前 require 外部脚本。
    // 官方 execArgvExtension:none 同时封闭环境和命令行扩展，不能只在 JS 入口清理环境。
    await writeFile(
      config,
      JSON.stringify({
        main: bundledEntry,
        output: blob,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
        execArgvExtension: "none",
      }),
    );
    await exec(process.execPath, ["--experimental-sea-config", config]);
    await cp(process.execPath, executable);
    await chmod(executable, 0o755);
    await exec("/usr/bin/codesign", ["--remove-signature", executable]);
    const postjectManifestPath = requireFromCli.resolve("postject/package.json");
    const postjectManifest = JSON.parse(await readFile(postjectManifestPath, "utf8"));
    const postject = resolve(
      dirname(postjectManifestPath),
      typeof postjectManifest.bin === "string"
        ? postjectManifest.bin
        : postjectManifest.bin.postject,
    );
    await exec(
      process.execPath,
      [
        postject,
        executable,
        "NODE_SEA_BLOB",
        blob,
        "--sentinel-fuse",
        "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
        "--macho-segment-name",
        "NODE_SEA",
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const properties = {
      CFBundleIdentifier: plan.bundleId,
      CFBundleName: plan.displayName,
      CFBundleDisplayName: plan.displayName,
      CFBundleExecutable: plan.executableName,
      CFBundleShortVersionString: plan.version,
      CFBundleVersion: plan.version,
      CFBundlePackageType: "APPL",
      LSMinimumSystemVersion: "13.0",
    };
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(
      properties,
    )
      .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
      .join("")}<key>LSUIElement</key><true/></dict></plist>`;
    await writeFile(join(contents, "Info.plist"), plist);
    await writeFile(
      join(resources, "runtime-manifest.json"),
      JSON.stringify(
        {
          version: plan.version,
          bundleId: plan.bundleId,
          development: plan.allowUnsignedLauncher,
          peerAddon: "peer-addon.node",
          modules,
        },
        null,
        2,
      ),
    );
    const identity =
      options.signingIdentity ?? process.env.APPLE_SIGNING_IDENTITY ?? process.env.CSC_NAME ?? "-";
    // 原驱动 dylib 与 Node addon 的签名团队不同；一律按当前 Helper 身份先签内层，再签外层。
    for (const native of [...(await nativeFiles(runtime)), peerLibrary, peerAddon])
      await exec("/usr/bin/codesign", [
        "--force",
        "--sign",
        identity,
        ...(identity !== "-" ? ["--options", "runtime", "--timestamp"] : []),
        native,
      ]);
    const entitlements = join(repoRoot, "packages/desktop/build/entitlements.helper.plist");
    await exec("/usr/bin/codesign", [
      "--force",
      "--sign",
      identity,
      "--entitlements",
      entitlements,
      ...(identity !== "-" ? ["--options", "runtime", "--timestamp"] : []),
      stagedApp,
    ]);
    await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp]);
    await mkdir(dirname(plan.appPath), { recursive: true });
    await rm(plan.appPath, { recursive: true, force: true });
    await cp(stagedApp, plan.appPath, { recursive: true });
    return plan;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valueAfter = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const result = await buildCuaHelperApp({
    development: args.includes("--allow-unsigned-launcher-local-dev") || isLocalDevelopmentBuild(),
    version: valueAfter("--version"),
    arch: valueAfter("--arch"),
  });
  process.stdout.write(`Built Computer Use Helper: ${result.appPath}\n`);
}

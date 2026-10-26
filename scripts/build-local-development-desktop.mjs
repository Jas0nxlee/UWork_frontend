#!/usr/bin/env node
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createLocalDevelopmentPackageArgs } from "../packages/desktop/scripts/desktop-build-profile.mjs";

const run = promisify(execFile);
if (process.platform !== "darwin")
  throw new Error("Local Development App is a macOS-only build profile");
const root = resolve(import.meta.dirname, "..");
const env = {
  ...process.env,
  UWORK_DESKTOP_BUILD_PROFILE: "local-development",
  ZCODE_ENV: "production",
  ZCODE_PREVIEW_IDENTITY: "0",
  ZCODE_TARGET_OS: "darwin",
  ZCODE_TARGET_ARCH: process.arch,
  VITE_ZCODE_E2E_STORE_BRIDGE: "0",
  ZCODE_MAC_ADHOC_SIGN: "1",
  ZCODE_DESKTOP_DIST_DIR: "dist-local-development",
};
for (const args of [
  ["--filter", "@zcode/desktop", "prepare:runtime-assets"],
  ["--filter", "@zcode/desktop", "build:no-runtime-assets"],
  createLocalDevelopmentPackageArgs(process.arch),
]) {
  process.stdout.write(`[local-development] pnpm ${args.join(" ")}\n`);
  const { stdout, stderr } = await run("pnpm", args, {
    cwd: root,
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}
process.stdout.write(
  `Built ${resolve(root, "packages/desktop/dist-local-development", process.arch === "x64" ? "mac" : "mac-arm64", "UWork Local Development.app")}\n`,
);

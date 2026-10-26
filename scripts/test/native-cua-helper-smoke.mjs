// 显式本机集成验收：不纳入根全量 UT，不改 TCC、不截图、不发送输入。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createProductCuaHelperHost } from "../../packages/zcode-cua/broker-server.js";
import { callBrokerMethod } from "../../packages/zcode-cua/broker.js";

const appPath = resolve(
  process.argv[2] ?? "packages/desktop/dist-cua-helper/ZCode Computer Use Dev.app",
);
const directory = await mkdtemp(join(tmpdir(), "uwork-native-cua-"));
const marker = join(directory, "unexpected-preload");
const preload = join(directory, "preload.cjs");
const statusPath = join(directory, "preflight.json");
const executable = join(appPath, "Contents/MacOS/UWork Computer Use");
let handle;
try {
  await writeFile(
    preload,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'injected')`,
  );
  await promisify(execFile)(executable, ["--permission-status-file", statusPath], {
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
    timeout: 10000,
  });
  const injected = await stat(marker).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  assert.equal(injected, false, "SEA must ignore NODE_OPTIONS before any injected preload can run");
  const preflight = JSON.parse(await readFile(statusPath, "utf8"));
  assert.equal(typeof preflight.accessibility, "boolean");
  assert.equal(typeof preflight.screenRecording, "boolean");
  // 无 token 的直接启动也不能利用外置 JS 或 .node→JS symlink 获得 Helper 的 TCC 身份。
  const copy = join(directory, "Tampered.app");
  await cp(appPath, copy, { recursive: true });
  const sdkJs = join(
    copy,
    "Contents/Resources/runtime/node_modules/@trycua/cua-driver/dist/index.js",
  );
  await mkdir(resolve(sdkJs, ".."), { recursive: true });
  await writeFile(
    sdkJs,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'external-js')`,
  );
  const copyExecutable = join(copy, "Contents/MacOS/UWork Computer Use");
  await promisify(execFile)(
    copyExecutable,
    ["--permission-status-file", join(directory, "sealed-sdk-status.json")],
    { timeout: 10000 },
  );
  await assert.rejects(stat(marker), { code: "ENOENT" });
  const nativeModule = join(
    copy,
    `Contents/Resources/runtime/node_modules/@trycua/cua-driver-darwin-${process.arch}/cua_driver_node_runtime.node`,
  );
  await rm(nativeModule);
  await symlink(preload, nativeModule);
  await assert.rejects(
    promisify(execFile)(
      copyExecutable,
      ["--permission-status-file", join(directory, "native-symlink-status.json")],
      { timeout: 10000 },
    ),
  );
  await assert.rejects(stat(marker), { code: "ENOENT" });
  const env = {
    ...process.env,
    ZCODE_STORAGE_DIR: join(directory, ".uwork"),
    ZCODE_CUA_HELPER_INSTALL_VARIANT: "native-smoke",
    ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
    ZCODE_RUNTIME_ENV: "development",
    ZCODE_CUA_PERMISSION_BROKER_SOCKET: "",
  };
  const host = createProductCuaHelperHost({
    env,
    bundledHelperAppPath: appPath,
    healthTimeoutMs: 10000,
  });
  try {
    handle = await host.start();
    assert.equal(handle.bundleId, "dev.zcode.cua-helper.dev");
    const permissions = await host.queryPermissionStatus();
    assert.ok(["granted", "denied"].includes(permissions.accessibility));
    assert.ok(["granted", "denied"].includes(permissions.screen_recording));
    await assert.rejects(
      callBrokerMethod({ socketPath: handle.socketPath, method: "execute", params: {} }),
      /authority/,
    );
    const result = await callBrokerMethod({
      socketPath: handle.socketPath,
      token: handle.pluginAuthority,
      method: "execute",
      params: {
        toolName: "list_apps",
        context: {
          sessionId: "native-smoke",
          workspacePath: directory,
          workspaceKey: directory,
          runtimeScope: "main",
          deliveryKind: "desktop-continuous",
        },
      },
      timeoutMs: 15000,
    });
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.ok(Array.isArray(result.structuredContent?.apps));
    assert.ok(result.structuredContent.apps.length > 0);
    process.stdout.write(
      `${JSON.stringify({ bundleId: handle.bundleId, permissions, observedApps: result.structuredContent.apps.length, nodeOptionsIgnored: true, externalSdkJsIgnored: true, nativeSymlinkJsRejected: true })}\n`,
    );
  } finally {
    if (handle)
      await callBrokerMethod({
        socketPath: handle.socketPath,
        method: "shutdown",
        token: handle.pluginAuthority,
      }).catch(() => {});
    await host.stop();
    if (handle) await rm(dirname(handle.socketPath), { recursive: true, force: true });
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

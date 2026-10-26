import { link, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isSea } from "node:sea";
import { createCuaDriverRuntime } from "./cua-driver-runtime.js";
import { createCuaHelperServer } from "./helper-server.js";
import { createCuaPeerAuthorizer } from "./peer-authorization.js";
import {
  DEV_CUA_HELPER_BUNDLE_ID,
  HELPER_BUNDLE_ID,
  HELPER_DISPLAY_NAME,
} from "./broker-helper-constants.js";

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--") || !isAbsolute(value)) {
    throw new Error(`${name} requires an absolute path`);
  }
  if (argv.lastIndexOf(name) !== index) throw new Error(`Duplicate ${name}`);
  return value;
}

export async function loadCuaDriverSdk() {
  // 必须是 literal import：构建器把整棵 SDK JS 嵌入 SEA。不能在取得 TCC 权限后
  // require 用户可写 Resources 下的 JS；macOS library validation 只验证原生映像。
  return await import("@trycua/cua-driver");
}

export function scheduleCuaHelperIdleClose({ close, idleTimeoutMs = 300_000, onError = fail }) {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error("Helper idle timeout must be a positive finite duration");
  }
  let timer;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };
  const onRequestActivity = ({ inflight }) => {
    clearTimeout(timer);
    if (stopped || inflight > 0) return;
    // 只调度空闲释放，不发健康探测、不采屏。最后一个请求完成后才重新计时。
    timer = setTimeout(() => {
      stop();
      void Promise.resolve().then(close).catch(onError);
    }, idleTimeoutMs);
    timer.unref?.();
  };
  onRequestActivity({ inflight: 0 });
  return { onRequestActivity, stop };
}

export function trackCuaRuntimeActivity(runtime, onActivity) {
  let inflight = 0;
  const track = async (operation) => {
    onActivity(++inflight);
    try {
      return await operation();
    } finally {
      onActivity(--inflight);
    }
  };
  return {
    execute: (input) => track(() => runtime.execute(input)),
    closeSession: (context) => track(() => runtime.closeSession(context)),
    dispose: () => runtime.dispose(),
  };
}

export async function startCuaHelper(options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new Error("This Computer Use Helper is available only on macOS");
  }
  const argv = options.argv ?? process.argv.slice(2);
  const development =
    options.development ??
    (typeof __UWORK_CUA_HELPER_DEVELOPMENT__ !== "undefined" && __UWORK_CUA_HELPER_DEVELOPMENT__);
  const statusFile = optionValue(argv, "--permission-status-file");
  const socketPath = optionValue(argv, "--socket");
  const sdk = await (options.loadSdk ?? loadCuaDriverSdk)();
  const readPermissions = () => {
    // 只读 API 最终调用 AXIsProcessTrusted / CGPreflightScreenCaptureAccess。
    // requestMacOsPermissions 和截图探针会提示用户，不允许用于设置页状态刷新。
    const status = sdk.currentMacOsPermissionStatus();
    if (typeof status?.accessibility !== "boolean" || typeof status.screenRecording !== "boolean") {
      throw new Error("Native Helper returned an invalid permission snapshot");
    }
    return status;
  };
  if (statusFile) {
    // 独立短命进程读取 TCC，避免常驻进程的 Screen Recording 预检缓存被当作新授权。
    const temporary = `${statusFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(readPermissions()), { mode: 0o600, flag: "wx" });
      // 先写完整快照，再原子公布；link 保留 wx 的不覆盖语义，避免 Host 读到半份 JSON。
      await link(temporary, statusFile);
    } finally {
      await rm(temporary, { force: true });
    }
    return null;
  }
  if (!socketPath) throw new Error("Computer Use Helper requires --socket");
  const nativeRuntime = createCuaDriverRuntime({
    loadDriver: async () => sdk.CuaDriver.create(undefined),
    readPermissions,
  });
  let idle;
  let requestInflight = 0;
  let nativeInflight = 0;
  const refreshIdle = () => idle?.onRequestActivity({ inflight: requestInflight + nativeInflight });
  // 超时响应不代表原生调用已结束；原生 Promise 的真实生命期也必须阻止 idle 退出。
  const runtime = trackCuaRuntimeActivity(nativeRuntime, (inflight) => {
    nativeInflight = inflight;
    refreshIdle();
  });
  runtime.dispose = () => {
    idle?.stop();
    return nativeRuntime.dispose();
  };
  const server = await createCuaHelperServer({
    socketPath,
    runtime,
    readPermissions,
    authorizePeer: createCuaPeerAuthorizer({
      nativeAddonPath: join(dirname(process.execPath), "..", "Resources", "peer-addon.node"),
      development,
      allowUnsignedLocalDev:
        argv.includes("--allow-unsigned-launcher-local-dev") &&
        argv.includes("--allow-external-broker-client-local-dev"),
    }),
    bundleId: development ? DEV_CUA_HELPER_BUNDLE_ID : HELPER_BUNDLE_ID,
    displayName: development ? `${HELPER_DISPLAY_NAME} Dev` : HELPER_DISPLAY_NAME,
    onRequestActivity(activity) {
      requestInflight = activity.inflight;
      refreshIdle();
    },
  });
  idle = scheduleCuaHelperIdleClose({
    close: () => server.close(),
    idleTimeoutMs: options.idleTimeoutMs,
  });
  refreshIdle();
  return {
    ...server,
    async close() {
      idle.stop();
      await server.close();
    },
  };
}

if (isSea() || basename(process.argv[1] ?? "") === "helper-entry.js") {
  startCuaHelper().then((server) => {
    if (!server) return;
    const close = () => {
      void server.close().then(() => process.exit(0), fail);
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
  }, fail);
}

function fail(error) {
  process.stderr.write(
    `Computer Use Helper: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

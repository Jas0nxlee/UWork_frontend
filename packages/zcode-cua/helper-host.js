import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  callBrokerMethod,
  CuaHelperError,
  probeHelperHealth,
  resolveBrokerSocketPath,
} from "./broker.js";
import { DEV_CUA_HELPER_BUNDLE_ID, HELPER_BUNDLE_ID } from "./broker-helper-constants.js";
import {
  buildHelperOpenArgs,
  createCuaHelperInstaller,
  isCuaLocalDevelopmentRuntime,
} from "./helper-installer.js";
const runFile = promisify(execFile);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function readAuthority(socketPath) {
  const path = `${socketPath}.authority`;
  const [file, parent] = await Promise.all([lstat(path), lstat(dirname(path))]);
  const uid = process.getuid?.();
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    (file.mode & 0o077) !== 0 ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    (uid !== undefined && (file.uid !== uid || parent.uid !== uid))
  )
    throw new CuaHelperError("Computer Use authority file is not private");
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await descriptor.stat();
    if (opened.dev !== file.dev || opened.ino !== file.ino)
      throw new CuaHelperError("Computer Use authority changed while opening");
    const authority = (await descriptor.readFile("utf8")).trim();
    if (!/^[a-f0-9]{64}$/u.test(authority))
      throw new CuaHelperError("Computer Use authority file is invalid");
    return authority;
  } finally {
    await descriptor.close();
  }
}

export function createProductCuaHelperHost(options = {}) {
  const env = options.env ?? process.env;
  const installer =
    options.helperInstaller ??
    createCuaHelperInstaller({
      env,
      bundledAppPath: options.bundledHelperAppPath,
      logger: options.logger,
    });
  const socketPath = resolveBrokerSocketPath({ env });
  const launch =
    options.launchHelper ??
    (async (appPath, args) => {
      await runFile("/usr/bin/open", args, { timeout: 5000 });
    });
  let handle;
  let appPath;
  let starting;
  let restarting;
  let stopping;
  let freshPermissionQuery;
  let epoch = 0;
  const health = async (timeoutMs = options.healthTimeoutMs ?? 15000) => {
    const report = await probeHelperHealth(socketPath, { timeoutMs });
    if (
      ![
        HELPER_BUNDLE_ID,
        ...(isCuaLocalDevelopmentRuntime(env) ? [DEV_CUA_HELPER_BUNDLE_ID] : []),
      ].includes(report.bundleId)
    )
      throw new CuaHelperError("Running Computer Use Helper has the wrong bundle identity");
    return report;
  };
  const beginStart = async () => {
    if (starting) return starting;
    const generation = epoch;
    starting = (async () => {
      if (handle) {
        try {
          await health(300);
        } catch {
          handle = undefined;
        }
        if (generation !== epoch)
          throw new CuaHelperError("Computer Use Helper startup was disposed");
        if (handle) return handle;
      }
      appPath = await installer.ensureInstalled();
      if (generation !== epoch)
        throw new CuaHelperError("Computer Use Helper startup was disposed");
      let report = await health(200).catch(() => undefined);
      if (!report) {
        await launch(
          appPath,
          buildHelperOpenArgs({
            appPath,
            socketPath,
            ...(isCuaLocalDevelopmentRuntime(env)
              ? { allowUnsignedLauncherLocalDev: true, allowExternalBrokerClientLocalDev: true }
              : {}),
          }),
        );
        report = await health();
      }
      const pluginAuthority = await readAuthority(socketPath);
      if (generation !== epoch) {
        // 原因：多个窗口共享物理 Helper；已 detach 的窗口不得接管晚到进程，也不能替其他窗口关闭它。
        // standalone Helper 由自身的无请求/无在途工作 idle 策略回收。
        throw new CuaHelperError("Computer Use Helper startup was disposed");
      }
      handle = {
        socketPath,
        launchSocketPath: socketPath,
        pluginAuthority,
        helperAppPath: appPath,
        bundleId: report.bundleId,
        pid: report.pid,
      };
      return handle;
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  };
  const stop = async () => {
    if (stopping) return stopping;
    epoch += 1;
    stopping = (async () => {
      await starting?.catch(() => undefined);
      handle = undefined;
    })().finally(() => {
      stopping = undefined;
    });
    return stopping;
  };
  const restart = (restartOptions = {}) => {
    if (restarting) return restarting;
    const generation = epoch;
    restarting = (async () => {
      await starting?.catch(() => undefined);
      if (!handle) await beginStart();
      const authority = handle.pluginAuthority;
      handle = undefined;
      // 只有显式权限恢复执行物理重启；普通窗口 dispose 仅 detach。
      await callBrokerMethod({ socketPath, method: "shutdown", token: authority, timeoutMs: 5000 });
      const deadline = Date.now() + 5000;
      let stopped = false;
      while (Date.now() < deadline) {
        try {
          await health(100);
        } catch {
          stopped = true;
          break;
        }
        await delay(50);
      }
      if (!stopped)
        throw new CuaHelperError("Computer Use Helper did not stop before its restart boundary");
      if (generation !== epoch)
        throw new CuaHelperError("Computer Use Helper restart was disposed");
      restartOptions.beforeFreshStart?.();
      const next = await beginStart();
      if (next.pluginAuthority !== authority)
        throw new CuaHelperError("Computer Use Helper changed authority during restart");
      return { handle: next, reused: true };
    })().finally(() => {
      restarting = undefined;
    });
    return restarting;
  };
  const start = async () => {
    if (stopping) await stopping;
    if (restarting) return (await restarting).handle;
    return beginStart();
  };
  const permissionReport = async () => {
    // 原因：共享 Helper 会自行 idle 退出，缓存 handle 不代表 socket 仍存活。
    // 显式只读查询在请求边缘复用 start 的 health/single-flight 恢复，不增加后台探活或 spawn IO。
    await start();
    return callBrokerMethod({ socketPath, method: "permission_status", timeoutMs: 3000 });
  };
  const queryPermissionStatusFresh = () => {
    if (freshPermissionQuery) return freshPermissionQuery;
    freshPermissionQuery = (async () => {
      // 不能直接 exec 二进制：TCC 可能把责任归给父应用而产生假的 AX granted。
      // 每次先复用安装器验签，再由 LS 新实例发布一份完整快照；常驻 Helper 不受影响。
      const verifiedApp = await installer.ensureInstalled();
      const directory = await mkdtemp(join(tmpdir(), "uwc-permission-"));
      const resultFile = join(directory, "status.json");
      try {
        await launch(
          verifiedApp,
          buildHelperOpenArgs({ appPath: verifiedApp, permissionStatusFile: resultFile }),
        );
        const report = JSON.parse(await readFile(resultFile, "utf8"));
        if (
          typeof report.accessibility !== "boolean" ||
          typeof report.screenRecording !== "boolean"
        )
          throw new CuaHelperError("Computer Use fresh permission status is invalid");
        return {
          accessibility: report.accessibility ? "granted" : "denied",
          screen_recording: report.screenRecording ? "granted" : "denied",
        };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    })().finally(() => {
      freshPermissionQuery = undefined;
    });
    return freshPermissionQuery;
  };
  return {
    get running() {
      return Boolean(handle);
    },
    get socketPath() {
      return handle?.socketPath ?? null;
    },
    get pluginAuthority() {
      return handle?.pluginAuthority ?? null;
    },
    get reservedTransport() {
      return handle ? { socketPath, pluginAuthority: handle.pluginAuthority } : undefined;
    },
    start,
    stop,
    restart: async () => (await restart()).handle,
    restartAfterCurrentStart: async () => (await restart()).handle,
    restartAfterCurrentStartPreservingTransport: restart,
    waitForTransport: async () => {
      const value = await start();
      return { socketPath: value.socketPath, pluginAuthority: value.pluginAuthority };
    },
    checkHealth: health,
    queryPermissionStatus: permissionReport,
    queryPermissionStatusFresh,
    async queryScreenCaptureProbe() {
      await start();
      return callBrokerMethod({
        socketPath,
        token: handle.pluginAuthority,
        method: "screen_capture_probe",
        timeoutMs: 5000,
      });
    },
    async queryScreenRecordingPreflight() {
      return (await queryPermissionStatusFresh()).screen_recording;
    },
  };
}

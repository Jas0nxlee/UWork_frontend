// Derived from Zcode-CE/Zcode-CE 7fc3bfe252e7fb1833dc06113e3c2c012910996d (Apache-2.0).
// Modified by ZCode: UWork independent Helper, macOS protocol, identity isolation and stop admission.
// SPDX-License-Identifier: Apache-2.0
// Adapted from https://github.com/Zcode-CE/Zcode-CE at
// 7fc3bfe252e7fb1833dc06113e3c2c012910996d (packages/zcode-cua).
import { CuaBrokerError } from "./cua-driver-errors.js";
import { matchesRef, pickWindow, usableWindows } from "./cua-driver-targets.js";

/** Helper 全局 app 表是派生缓存；原生窗口路由通过同一个串行驱动端口查询。 */
export function createCuaDriverApps(callDriver) {
  /** list_apps 的原始行。命中缓存避免每个动作都重扫 800 个进程。 */
  let appCache;
  const loadApps = async (signal, { fresh = false } = {}) => {
    if (!appCache || fresh) {
      const envelope = await callDriver("list_apps", {}, signal);
      appCache = Array.isArray(envelope.structured.apps) ? envelope.structured.apps : [];
    }
    return appCache;
  };

  /**
   * app_ref → 运行中的应用行。
   * 未运行且有 launch_path 时按文档承诺透明拉起一次（getApp 的语义是「需要时后台启动」）。
   */
  const resolveApp = async (appRef, signal) => {
    if (!appRef || typeof appRef !== "object") {
      throw new CuaBrokerError("app_ref is required", { code: "invalid_request" });
    }
    const find = (apps) =>
      apps.find((app) => app.running && app.pid > 0 && matchesRef(app, appRef));
    let hit = find(await loadApps(signal));
    if (!hit) {
      const candidate = (await loadApps(signal)).find((app) => matchesRef(app, appRef));
      if (candidate?.launch_path || candidate?.name) {
        try {
          await callDriver(
            "launch_app",
            candidate.launch_path
              ? { launch_path: candidate.launch_path }
              : { name: candidate.name },
            signal,
          );
        } catch (error) {
          if (signal?.aborted) throw error;
          // 拉起失败不在这里抛：下面的重新查找会给出「找不到应用」这个更准确的结论。
        }
        appCache = undefined;
        hit = find(await loadApps(signal, { fresh: true }));
      }
    }
    if (!hit) {
      // 客户端把「target app is not running」当作可换字段重试的信号，文案必须保留这句。
      throw new CuaBrokerError(
        `target app is not running, and no installed application matched the ${appRef.bundle_id ? "bundle id" : "name"} ${appRef.bundle_id ?? appRef.name ?? appRef.pid}`,
        { code: "element_unavailable", details: { appRef } },
      );
    }
    return hit;
  };

  const listWindowsOf = async (pid, signal) => {
    const envelope = await callDriver("list_windows", pid ? { pid } : {}, signal);
    return usableWindows(envelope.structured.windows);
  };

  const resolveAppWindow = async (appRef, signal) => {
    const app = await resolveApp(appRef, signal);
    const windows = await listWindowsOf(app.pid, signal);
    const wanted = typeof appRef.window_id === "number" ? appRef.window_id : undefined;
    const window = pickWindow(windows, wanted);
    if (!window) {
      throw new CuaBrokerError(
        wanted === undefined
          ? `app "${app.name}" has no open window`
          : `window ${wanted} of "${app.name}" is not open; call list_windows to pick a fresh window_id`,
        { code: "element_unavailable" },
      );
    }
    return { app, window };
  };

  return { loadApps, resolveApp, listWindowsOf, resolveAppWindow };
}

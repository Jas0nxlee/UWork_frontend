// Derived from Zcode-CE/Zcode-CE 7fc3bfe252e7fb1833dc06113e3c2c012910996d (Apache-2.0).
// Modified by ZCode: UWork independent Helper, macOS protocol, identity isolation and stop admission.
// SPDX-License-Identifier: Apache-2.0
// Adapted from https://github.com/Zcode-CE/Zcode-CE at
// 7fc3bfe252e7fb1833dc06113e3c2c012910996d (packages/zcode-cua).
/**
 * Computer Use 运行时：把 ZCode 的 CUA broker 协议适配到 MIT 许可的
 * `@trycua/cua-driver`（Rust 原生 SDK；本 Helper 仅承接 macOS）。
 *
 * 为什么需要这一层：两侧的接口面**不同构**，不能直接转发。
 * - ZCode 的模型可见面是 14 个 capability method（computer-use-client.mjs 的
 *   COMPUTER_METHOD_NAMES），按 Codex 的 `cua` 形状定义：`app_ref` 定位应用、
 *   `target` 定位元素/坐标、观察结果回传 `state_id` 与元素表。
 * - cua-driver 的工具面是 59 个 MCP 风格工具，按 `pid` + `window_id` 定位窗口，
 *   元素必须带 `element_token` 或 `snapshot_id` 才允许点击。
 * 所以这里是**协议翻译**：应用名 → pid、窗口解析、元素索引 → element_token、
 * 观察结果 → state_id，以及驱动错误码 → broker 错误码。目标解析的细节在
 * `./cua-driver-targets.js`，信封与错误码在 `./cua-driver-errors.js`。
 *
 * 安全语义（三条，来自 DSH 的 GUIDANCE，必须保留）：
 * 1. 后台投递优先。**拒绝不代表可以改用前台重投** —— 本文件从不传
 *    `delivery_mode: "foreground"`（那个值会真的激活目标窗口抢用户焦点）。
 *    驱动返回 background_unavailable 时映射成 FOREGROUND_REQUIRED 交给模型，
 *    由模型改走元素/键盘路径，而不是我们替它升级。
 * 2. 动作下发成功 ≠ 结果达成。收据里的 `delivery`/`effect` 原样带出去，
 *    让模型自己从**新的观察**里确认结果。
 * 3. 取消后已完成的输入不会回滚：`actionSent` 只在收据明确说下发过时才置 true，
 *    模型据此先观察再决定重试。
 */

import { createHash } from "node:crypto";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  CuaBrokerError,
  actionDelivered,
  brokerCodeForDriverCode,
  errorResult,
  jsonBlock,
  okResult,
  readDriverEnvelope,
  refusalOf,
  textBlock,
} from "./cua-driver-errors.js";
import { CUA_ACTIONS } from "./cua-driver-actions.js";
import { createCuaDriverApps } from "./cua-driver-apps.js";
import { appKeyOf, resolveTarget, toElement, usableWindows } from "./cua-driver-targets.js";

/** 驱动只由独立 Helper 注入；宿主和 node_repl 不允许动态加载原生能力。 */
export function createCuaDriverRuntime(options = {}) {
  const loadDriver =
    options.loadDriver ??
    (async () => {
      throw new Error("Native driver must be loaded by the independent Helper");
    });
  let driverPromise;
  let driverInstance;
  let disposed = false;
  /** 运行时生命周期信号：dispose() 时 abort，取消在途的原生调用。 */
  const lifetime = new AbortController();
  /** 串行化驱动调用：原生句柄不保证可重入。 */
  let queue = Promise.resolve();
  /** 每个 (sessionId, appKey) 最近一次观察，供元素索引解析与 state_id 回传。 */
  const observations = new Map();
  /**
   * 已被 stop_computer_control 关闭的 session。
   *
   * kill switch 必须在**会话生命周期内**持续生效：文档要求「Stop immediately after
   * agent.computerUse.stop()… and do not switch to a different UI-automation technology」。
   * 如果 stop 之后的下一次调用悄悄重建隐式会话，模型只要再发一个 cell 就能继续操作桌面 ——
   * 那等于没有 kill switch。这里把它钉到会话结束（closeSession）为止。
   */
  const stoppedSessions = new Set();
  const startedSessions = new Set();
  const discoveryTools = new Set(["list_apps", "list_windows"]);
  const actuationTools = new Set([
    "click",
    "drag",
    "type_text",
    "scroll",
    "set_value",
    "press_key",
  ]);

  const serialize = (run) => {
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const active = new Map();
  const epochs = new Map();
  const stopOperations = new Map();
  let currentDriverSession;
  let cleanupFailure;
  const sessionKeyOf = (context) =>
    JSON.stringify([
      context?.workspaceIdentity?.trim() || context?.workspacePath || context?.workspaceKey,
      context?.remoteSessionId || "",
      context?.sessionId,
    ]);
  const driverSessionOf = (key) =>
    `uwork-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
  const clearObservations = (key) => {
    for (const observationKey of observations.keys()) {
      if (observationKey.startsWith(`${key}|`)) observations.delete(observationKey);
    }
  };
  const localContext = (context) =>
    context?.runtimeScope === "main" &&
    typeof context.sessionId === "string" &&
    Boolean(context.sessionId.trim()) &&
    Boolean(context.workspaceIdentity?.trim() || context.workspacePath || context.workspaceKey) &&
    !context.remoteSessionId &&
    !context.remoteTarget &&
    !isRemoteWorkspaceIdentity(context.workspaceIdentity?.trim() || context.workspaceKey || "") &&
    (context.deliveryKind ?? context.clientMode) === "desktop-continuous";
  const stoppedResult = () =>
    errorResult({
      code: "controller_busy",
      message:
        "Computer Use control was stopped for this session. Do not continue; ask the user to start a new session.",
    });

  const ensureDriver = async () => {
    if (disposed)
      throw new CuaBrokerError("Computer Use runtime is disposed", { code: "internal" });
    if (!driverPromise) {
      driverPromise = (async () => {
        try {
          driverInstance = await loadDriver();
        } catch (error) {
          // 平台二进制缺失（optionalDependencies 未装到本平台）会走到这里。
          // 归 broker_unavailable → HELPER_UNAVAILABLE：这是「本机没有可用后端」，
          // 不是可以盲目重试的暂时故障。
          throw new CuaBrokerError(
            `Computer Use driver is unavailable on this platform: ${error instanceof Error ? error.message : String(error)}`,
            { code: "broker_unavailable" },
          );
        }
        return driverInstance;
      })().catch((error) => {
        // 启动失败必须回滚，否则后续每次调用都复用一个已死的 promise，
        // 且 driverInstance 会留下半初始化的句柄。
        driverPromise = undefined;
        throw error;
      });
    }
    return await driverPromise;
  };

  /**
   * 调一次驱动工具，返回原始信封。
   *
   * **必须**传 signal，且不能传 undefined：`@ubjs/core@0.31.0-3` 的 async-rust-call
   * 里写的是 `asyncOpts?.signal.aborted` —— 可选链只护住了 `asyncOpts`，没护住
   * `signal`。于是 `{}`、`{signal: undefined}` 都会抛
   * "Cannot read properties of undefined (reading 'aborted')"，而 `{signal}` 正常。
   * 实测：no-signal / undef-signal 抛错，signal 通过。这是上游缺陷，不是我们的用法问题，
   * 所以这里永远合成一个信号，而不是把参数原样透传。
   *
   * 合成用 lifetime.signal：dispose() 时 abort 它，让在途的原生调用真正被取消，
   * 而不是等 Rust future 自己跑完。
   */
  const callDriverOnce = async (toolName, args, signal) => {
    const driver = await ensureDriver();
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    if (combined.aborted) throw combined.reason ?? new DOMException("aborted", "AbortError");
    const payload = JSON.stringify({
      ...args,
      ...(discoveryTools.has(toolName) ? {} : { session: currentDriverSession }),
    });
    let envelope;
    try {
      const raw = await driver.callTool(toolName, payload, { signal: combined });
      envelope = readDriverEnvelope(raw.rawJson);
    } catch (error) {
      if (!actuationTools.has(toolName)) throw error;
      // 原生调用后的异常没有“未发送”收据；输入可能已经生效，取消/崩溃也不能让模型盲重放。
      throw new CuaBrokerError(error instanceof Error ? error.message : String(error), {
        code: error?.name === "AbortError" ? "aborted" : "internal",
        actionSent: true,
        details: { tool: toolName },
      });
    }
    const refusal = refusalOf(envelope);
    if (refusal) {
      throw new CuaBrokerError(refusal.message, {
        code: brokerCodeForDriverCode(refusal.code),
        actionSent: actionDelivered(envelope),
        details: { driverCode: refusal.code, tool: toolName },
      });
    }
    return envelope;
  };

  const callDriver = async (toolName, args, signal) => {
    if (!discoveryTools.has(toolName) && !startedSessions.has(currentDriverSession)) {
      // 0.28.2 初始动作可隐式建 lifecycle，但 end 后 label 留 tombstone；必须显式 start 才能复用。
      // 在首次具名观察/输入前声明，不以失败重试的方式补发任何可能已经下发的输入。
      await callDriverOnce("start_session", {}, signal);
      startedSessions.add(currentDriverSession);
    }
    return callDriverOnce(toolName, args, signal);
  };

  // ─────────────────────────────────────────── 应用与窗口解析

  const { loadApps, resolveApp, listWindowsOf, resolveAppWindow } = createCuaDriverApps(callDriver);

  // ─────────────────────────────────────────── 观察状态

  const observationKey = (context, appRef) => `${sessionKeyOf(context)}|${appKeyOf(appRef)}`;

  // ─────────────────────────────────────────── 方法实现

  const methodListApps = async (context, signal) => {
    const apps = await loadApps(signal, { fresh: true });
    // 驱动在 Linux 上把 800+ 个进程全当应用返回（systemd/kworker 都在里面）。
    // 只保留用户可寻址的目标：XDG 桌面项，或当前持有窗口的进程 —— 否则单次
    // list_apps 就有 ~130KB 进模型上下文。
    const owners = new Set(
      usableWindows((await callDriver("list_windows", {}, signal)).structured.windows).map(
        (w) => w.pid,
      ),
    );
    const visible = apps.filter(
      (app) => app.kind === "desktop" || (app.running && app.pid > 0 && owners.has(app.pid)),
    );
    return okResult({
      content: [jsonBlock({ apps: visible })],
      structuredContent: { apps: visible },
    });
  };

  const methodListWindows = async (context, args, signal) => {
    const appRef = args?.app_ref;
    const pid = appRef ? (await resolveApp(appRef, signal)).pid : undefined;
    const windows = await listWindowsOf(pid, signal);
    return okResult({
      content: [jsonBlock({ windows })],
      structuredContent: { windows },
    });
  };

  const observe = async (context, args, signal) => {
    const appRef = args?.app_ref;
    const { app, window } = await resolveAppWindow(appRef, signal);
    const envelope = await callDriver(
      "get_window_state",
      {
        pid: app.pid,
        window_id: window.window_id,
        include_accessibility_tree: args?.include_accessibility_tree !== false,
        include_screenshot: args?.include_screenshot === true,
        ...(args?.max_elements === undefined ? {} : { max_elements: args.max_elements }),
      },
      signal,
    );
    const structured = envelope.structured;
    const elements = (Array.isArray(structured.elements) ? structured.elements : []).map(toElement);
    const snapshot = structured.snapshot_id;
    const stateId =
      typeof snapshot === "string" || Number.isSafeInteger(snapshot) ? String(snapshot) : undefined;
    const state = {
      state_id: stateId,
      app: {
        pid: app.pid,
        name: app.name ?? null,
        bundle_id: app.bundle_id ?? null,
        active: app.active === true,
      },
      window: {
        window_id: window.window_id,
        title: structured.window_title ?? window.title ?? null,
        bounds: structured.window_bounds ?? window.bounds ?? null,
      },
      elements,
      text: typeof structured.tree_markdown === "string" ? structured.tree_markdown : "",
      element_count: structured.element_count ?? elements.length,
      ...(structured.elements_complete === false ? { elements_complete: false } : {}),
      ...(typeof structured.truncation_reason === "string"
        ? { non_actionable_reason: structured.truncation_reason }
        : {}),
    };
    observations.set(observationKey(context, appRef), {
      stateId,
      elements,
      windowId: window.window_id,
      pid: app.pid,
    });
    return { state, envelope };
  };

  const methodGetAppState = async (context, args, signal) => {
    const { state, envelope } = await observe(context, args, signal);
    const content = [];
    if (state.text) content.push(textBlock(state.text));
    for (const block of envelope.images) {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
    }
    const screenshotError = envelope.structured.screenshot_error;
    // 请求了像素却没拿到，必须说清原因：否则模型只能猜，历史上会升级成抢焦点。
    const reason = !screenshotError
      ? undefined
      : typeof screenshotError === "string"
        ? screenshotError
        : (screenshotError.reason ?? screenshotError.code);
    if (reason) content.push(textBlock(`[screenshot unavailable: ${reason}]`));
    return okResult({
      content,
      structuredContent: { ...state, ...(reason ? { non_actionable_reason: reason } : {}) },
    });
  };

  /** 动作类方法共用：解析目标 + 调驱动 + 把收据原样回传。 */
  const runAction = async (context, args, signal, plan) => {
    const appRef = args?.app_ref;
    const { app, window } = await resolveAppWindow(appRef, signal);
    // target 是**可选**的：`type` / `key` 的签名里 target 可省略（输入落到当前焦点），
    // `scroll` / `click` 等则必填。只有调用方确实给了目标才解析 —— 把 undefined 丢给
    // resolveTarget 会把「合法的不带目标输入」误判成参数错误。
    const requested = plan.target?.(args);
    const observation = observations.get(observationKey(context, appRef));
    if (
      requested &&
      observation &&
      (observation.windowId !== window.window_id || observation.pid !== app.pid)
    ) {
      throw new CuaBrokerError("Window changed; observe the target window again before acting", {
        code: "element_unavailable",
      });
    }
    const target = requested === undefined ? {} : resolveTarget(requested, observation);
    const envelope = await callDriver(
      plan.tool,
      { pid: app.pid, window_id: window.window_id, ...target, ...plan.args(args) },
      signal,
    );
    // **不**在动作后清掉观察记录。
    //
    // 官方契约（computer-use.md「Workflow」）明确允许复用同一个索引：
    // 「several actions may reuse one index without re-observing between them —
    // click an index, then type into it, in the same cell」。而 computer-use-client.mjs
    // 里那段注释记录了为什么客户端**移除**了同类守卫。真正知道元素是否还有效的是驱动：
    // element_token 自带快照身份，被新快照取代后返回 stale_element_token，元素消失时
    // fail closed。所以失效判定交给驱动，适配层不提前否决 —— 否则按文档写的
    // click(9); setValue(9, …) 会必然失败。
    return okResult({
      content: envelope.texts.filter(Boolean).map(textBlock),
      structuredContent: envelope.structured,
    });
  };

  const methodRequestAccess = async () => {
    if (typeof options.readPermissions !== "function") {
      throw new CuaBrokerError("Helper permission probe is unavailable", {
        code: "broker_unavailable",
      });
    }
    const grants = await options.readPermissions();
    if (typeof grants?.accessibility !== "boolean" || typeof grants.screenRecording !== "boolean") {
      throw new CuaBrokerError("Helper returned an invalid permission snapshot", {
        code: "broker_unavailable",
      });
    }
    const status = {
      ready: grants.accessibility && grants.screenRecording,
      accessibility: grants.accessibility ? "granted" : "denied",
      screenRecording: grants.screenRecording ? "granted" : "denied",
    };
    return okResult({ content: [jsonBlock(status)], structuredContent: status });
  };

  const cleanupSession = async (key) => {
    clearObservations(key);
    currentDriverSession = driverSessionOf(key);
    if (!driverInstance || !startedSessions.has(currentDriverSession)) return;
    try {
      await callDriverOnce("end_session", {}, lifetime.signal);
    } catch (error) {
      // 清理失败时不能继续 admission：原生输入可能仍被按住，必须由 Helper 重启释放。
      cleanupFailure = error;
      throw error;
    } finally {
      startedSessions.delete(currentDriverSession);
    }
  };
  const stopSession = (context, args) => {
    const key = sessionKeyOf(context);
    if (stopOperations.has(key)) return stopOperations.get(key);
    // 入队前封禁本会话并取消当前调用，已排队动作必须在 admission 再检查此标记。
    stoppedSessions.add(key);
    active.get(key)?.abort(new DOMException("Computer Use control stopped", "AbortError"));
    const operation = serialize(async () => {
      await cleanupSession(key);
      return okResult({ structuredContent: { stopped: true, reason: args?.reason ?? null } });
    });
    stopOperations.set(key, operation);
    return operation;
  };

  const handlers = {
    list_apps: (context, args, signal) => methodListApps(context, signal),
    list_windows: methodListWindows,
    get_app_state: methodGetAppState,
    request_access: methodRequestAccess,
    ...Object.fromEntries(
      Object.entries(CUA_ACTIONS).map(([name, build]) => [
        name,
        (context, args, signal) => runAction(context, args, signal, build(args ?? {})),
      ]),
    ),
  };

  const convertError = (error, signal) => {
    if (error instanceof CuaBrokerError) return errorResult(error);
    if (error?.name === "AbortError" || signal?.aborted) throw error;
    return errorResult({
      code: "internal",
      message: error instanceof Error ? error.message : String(error),
    });
  };
  return {
    async execute({ toolName, arguments: args, context, signal }) {
      if (!localContext(context))
        return errorResult({
          code: "not_authorized",
          message: "Computer Use requires a local main desktop-continuous context",
        });
      if (disposed || cleanupFailure)
        return errorResult({
          code: "broker_unavailable",
          message: cleanupFailure
            ? "Native input cleanup failed; restart Helper before continuing"
            : "Computer Use runtime is disposed",
        });
      const key = sessionKeyOf(context);
      const epoch = epochs.get(key) ?? 0;
      try {
        if (toolName === "stop_computer_control") return await stopSession(context, args);
        const handler = handlers[toolName];
        if (!handler)
          return errorResult({
            code: "unimplemented",
            message: `Computer Use method "${toolName}" has no equivalent in this driver`,
          });
        return await serialize(async () => {
          if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
          if (disposed || cleanupFailure)
            throw new CuaBrokerError("Computer Use Helper requires restart", {
              code: "broker_unavailable",
            });
          if (stoppedSessions.has(key) || epoch !== (epochs.get(key) ?? 0)) return stoppedResult();
          const controller = new AbortController();
          active.set(key, controller);
          currentDriverSession = driverSessionOf(key);
          const combined = AbortSignal.any([
            controller.signal,
            lifetime.signal,
            ...(signal ? [signal] : []),
          ]);
          try {
            return await handler(context, args ?? {}, combined);
          } finally {
            if (active.get(key) === controller) active.delete(key);
          }
        });
      } catch (error) {
        return convertError(error, signal);
      }
    },
    async closeSession(context) {
      if (!localContext(context)) return;
      const key = sessionKeyOf(context);
      stoppedSessions.add(key);
      epochs.set(key, (epochs.get(key) ?? 0) + 1);
      active.get(key)?.abort(new DOMException("Computer Use session closed", "AbortError"));
      await serialize(() => cleanupSession(key));
      stoppedSessions.delete(key);
      stopOperations.delete(key);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort(new DOMException("Computer Use runtime is disposed", "AbortError"));
      await serialize(async () => {
        observations.clear();
        startedSessions.clear();
        const instance = driverInstance;
        driverInstance = undefined;
        driverPromise = undefined;
        if (!instance) return;
        try {
          await instance.shutdown({ signal: new AbortController().signal });
        } finally {
          instance.uniffiDestroy();
        }
      });
    },
  };
}

/** 平台是否具备驱动预编译二进制的目标三元组。用于在装配点给出可诊断的不可用原因。 */
export const CUA_DRIVER_SUPPORTED_PLATFORMS = Object.freeze(["darwin-x64", "darwin-arm64"]);

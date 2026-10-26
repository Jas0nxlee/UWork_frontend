import { describe, expect, it, vi } from "vitest";
import { createCuaDriverRuntime } from "../cua-driver-runtime.js";

const context = (identity = "local-a", sessionId = "same-session") => ({
  sessionId,
  runtimeScope: "main",
  workspaceKey: "/project",
  workspacePath: "/project",
  workspaceIdentity: identity,
  deliveryKind: "desktop-continuous",
});
const app = { pid: 10, name: "Editor", running: true, kind: "desktop" };
const window = { pid: 10, window_id: 5, bounds: { x: 40, y: 50, width: 400, height: 300 } };
const result = (structuredContent = {}) => ({
  rawJson: JSON.stringify({ content: [], structuredContent }),
});
function fakeDriver() {
  return {
    callTool: vi.fn(async (name: string) => {
      if (name === "list_apps") return result({ apps: [app] });
      if (name === "list_windows") return result({ windows: [window] });
      if (name === "get_window_state") {
        return result({
          snapshot_id: 42,
          elements: [{ element_index: 9, element_token: "element-9", role: "button" }],
        });
      }
      return result({ delivery: { delivered_count: 1 } });
    }),
    shutdown: vi.fn(async () => {}),
    uniffiDestroy: vi.fn(),
  };
}

describe("Helper-owned native driver runtime", () => {
  it.each(["Error", "AbortError"])(
    "marks an actuation %s after dispatch as possibly sent without replay",
    async (kind) => {
      const driver = fakeDriver();
      const native = driver.callTool.getMockImplementation()!;
      const controller = new AbortController();
      driver.callTool.mockImplementation(async (name) => {
        if (name === "click") {
          const cause =
            kind === "AbortError"
              ? new DOMException("native canceled", "AbortError")
              : new Error("native crashed after dispatch");
          if (kind === "AbortError") controller.abort(cause);
          throw cause;
        }
        return native(name);
      });
      const runtime = createCuaDriverRuntime({ loadDriver: async () => driver });
      try {
        await runtime.execute({
          toolName: "get_app_state",
          arguments: { app_ref: { pid: 10 } },
          context: context(),
        });
        expect(
          await runtime.execute({
            toolName: "left_click",
            arguments: { app_ref: { pid: 10 }, target: { type: "element", index: 9 } },
            context: context(),
            signal: controller.signal,
          }),
        ).toMatchObject({
          isError: true,
          structuredContent: { action_sent: true, dispatch_status: "possibly_sent" },
        });
        expect(driver.callTool.mock.calls.filter(([name]) => name === "click")).toHaveLength(1);
      } finally {
        await runtime.dispose();
      }
    },
  );

  it("does not mark a failed observation as native input dispatch", async () => {
    const driver = fakeDriver();
    const native = driver.callTool.getMockImplementation()!;
    driver.callTool.mockImplementation(async (name) => {
      if (name === "get_window_state") throw new Error("observation failed");
      return native(name);
    });
    const runtime = createCuaDriverRuntime({ loadDriver: async () => driver });
    try {
      const output = await runtime.execute({
        toolName: "get_app_state",
        arguments: { app_ref: { pid: 10 } },
        context: context(),
      });
      expect(output).toMatchObject({ isError: true });
      expect(output.structuredContent).not.toHaveProperty("action_sent");
    } finally {
      await runtime.dispose();
    }
  });

  it.each([0, 1])(
    "keeps an explicit native refusal receipt with delivered count %s",
    async (delivered) => {
      const driver = fakeDriver();
      const native = driver.callTool.getMockImplementation()!;
      driver.callTool.mockImplementation(async (name) =>
        name === "click"
          ? {
              rawJson: JSON.stringify({
                isError: true,
                structuredContent: {
                  code: "permission_denied",
                  delivery: { delivered_count: delivered },
                },
              }),
            }
          : native(name),
      );
      const runtime = createCuaDriverRuntime({ loadDriver: async () => driver });
      try {
        await runtime.execute({
          toolName: "get_app_state",
          arguments: { app_ref: { pid: 10 } },
          context: context(),
        });
        const output = await runtime.execute({
          toolName: "left_click",
          arguments: { app_ref: { pid: 10 }, target: { type: "element", index: 9 } },
          context: context(),
        });
        expect(output).toMatchObject({
          isError: true,
          structuredContent: { code: "permission_denied" },
        });
        expect(output.structuredContent.action_sent === true).toBe(delivered > 0);
        expect(driver.callTool.mock.calls.filter(([name]) => name === "click")).toHaveLength(1);
      } finally {
        await runtime.dispose();
      }
    },
  );

  it("declares named sessions for native observations and explicitly revives them only after close", async () => {
    const driver = fakeDriver();
    const native = driver.callTool.getMockImplementation()!;
    const started = new Set<string>();
    driver.callTool.mockImplementation(async (name, argsJson) => {
      const args = JSON.parse(argsJson);
      if (name === "start_session") {
        started.add(args.session);
        return result({ active: true });
      }
      if (name === "end_session") {
        started.delete(args.session);
        return result({ ended: true });
      }
      // 固定 0.28.2 可在首个动作自动建 lifecycle，但 end 后保留 tombstone 必须 start 才能复用。
      // 此严格端口还要求首次显式声明，防止适配层依赖驱动隐式会话并混淆多个 workspace。
      if (name === "get_window_state" && !started.has(args.session)) {
        return {
          rawJson: JSON.stringify({
            isError: true,
            structuredContent: { code: "session_not_found" },
          }),
        };
      }
      return native(name);
    });
    const runtime = createCuaDriverRuntime({ loadDriver: async () => driver });
    const observe = (identity = "local-a") =>
      runtime.execute({
        toolName: "get_app_state",
        arguments: { app_ref: { pid: 10 } },
        context: context(identity),
      });
    try {
      expect(await observe()).toMatchObject({ structuredContent: { state_id: "42" } });
      expect(await observe()).not.toHaveProperty("isError", true);
      expect(driver.callTool.mock.calls.filter(([name]) => name === "start_session")).toHaveLength(
        1,
      );
      await runtime.closeSession(context());
      expect(await observe()).not.toHaveProperty("isError", true);
      expect(await observe("local-b")).not.toHaveProperty("isError", true);
      const starts = driver.callTool.mock.calls.filter(([name]) => name === "start_session");
      expect(starts).toHaveLength(3);
      expect(JSON.parse(starts[0]![1]).session).toBe(JSON.parse(starts[1]![1]).session);
      expect(JSON.parse(starts[0]![1]).session).not.toBe(JSON.parse(starts[2]![1]).session);
      await runtime.execute({ toolName: "stop_computer_control", context: context() });
      expect(await observe()).toMatchObject({
        isError: true,
        structuredContent: { code: "controller_busy" },
      });
      expect(driver.callTool.mock.calls.filter(([name]) => name === "start_session")).toHaveLength(
        3,
      );
      await runtime.closeSession(context());
      expect(await observe()).not.toHaveProperty("isError", true);
      expect(driver.callTool.mock.calls.filter(([name]) => name === "start_session")).toHaveLength(
        4,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("does not declare or end a named session for application/window discovery", async () => {
    const driver = fakeDriver();
    const runtime = createCuaDriverRuntime({ loadDriver: async () => driver });
    await runtime.execute({ toolName: "list_apps", context: context() });
    await runtime.execute({ toolName: "list_windows", context: context() });
    await runtime.closeSession(context());
    expect(
      driver.callTool.mock.calls.some(
        ([name]) => name === "start_session" || name === "end_session",
      ),
    ).toBe(false);
    for (const [name, args] of driver.callTool.mock.calls) {
      if (name === "list_apps" || name === "list_windows")
        expect(JSON.parse(args)).not.toHaveProperty("session");
    }
    await runtime.dispose();
  });

  it("does not silently turn a held key into a single key press", async () => {
    const driver = fakeDriver();
    const runtime = createCuaDriverRuntime({ loadDriver: async () => driver });
    try {
      expect(
        await runtime.execute({
          toolName: "key",
          arguments: { app_ref: { pid: 10 }, text: "a", hold_seconds: 2 },
          context: context(),
        }),
      ).toMatchObject({ isError: true, structuredContent: { code: "action_unavailable" } });
      expect(driver.callTool.mock.calls.some(([method]) => method === "press_key")).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });
  it("reports macOS grants without creating a driver or running capture", async () => {
    const loadDriver = vi.fn();
    const runtime = createCuaDriverRuntime({
      loadDriver,
      readPermissions: () => ({ accessibility: true, screenRecording: false }),
    });
    const status = await runtime.execute({ toolName: "request_access", context: context() });
    expect(status.structuredContent).toMatchObject({
      ready: false,
      accessibility: "granted",
      screenRecording: "denied",
    });
    expect(loadDriver).not.toHaveBeenCalled();
    await runtime.dispose();
  });

  it.each([
    { ...context(), runtimeScope: "subagent" },
    { ...context(), remoteSessionId: "ssh-session" },
    { ...context(), deliveryKind: "web-remote-replayable" },
    { ...context(), deliveryKind: undefined },
    { ...context(), workspaceIdentity: "remote:ssh:host:22:user:/project" },
  ])("rejects non-local contexts before native admission: %j", async (ctx) => {
    const loadDriver = vi.fn();
    const runtime = createCuaDriverRuntime({ loadDriver });
    expect(await runtime.execute({ toolName: "list_apps", context: ctx })).toMatchObject({
      isError: true,
      structuredContent: { code: "not_authorized" },
    });
    expect(loadDriver).not.toHaveBeenCalled();
  });

  it("resolves explicit element indexes and isolates observations by workspace identity", async () => {
    const driver = fakeDriver();
    const runtime = createCuaDriverRuntime({ loadDriver: async () => driver });
    const args = { app_ref: { pid: 10 } };
    expect(
      await runtime.execute({ toolName: "get_app_state", arguments: args, context: context() }),
    ).toMatchObject({ structuredContent: { state_id: "42" } });
    const click = { ...args, target: { type: "element", index: 9 } };
    expect(
      await runtime.execute({
        toolName: "left_click",
        arguments: click,
        context: context("local-b"),
      }),
    ).toMatchObject({ isError: true });
    expect(
      await runtime.execute({ toolName: "left_click", arguments: click, context: context() }),
    ).not.toHaveProperty("isError", true);
    const calls = driver.callTool.mock.calls;
    const clickCall = calls.find(([name]) => name === "click");
    expect(JSON.parse(clickCall![1])).toMatchObject({ element_token: "element-9" });
    await runtime.dispose();
  });

  it("refuses coordinates with no proven screenshot mapping before dispatch", async () => {
    const driver = fakeDriver();
    const runtime = createCuaDriverRuntime({ loadDriver: async () => driver });
    const output = await runtime.execute({
      toolName: "left_click",
      arguments: { app_ref: { pid: 10 }, target: { type: "coordinate", x: 20, y: 30 } },
      context: context(),
    });
    expect(output).toMatchObject({
      isError: true,
      structuredContent: { code: "action_unavailable" },
    });
    expect(driver.callTool.mock.calls.some(([name]) => name === "click")).toBe(false);
    await runtime.dispose();
  });

  it("rechecks stop at admission and waits for native cleanup before other sessions", async () => {
    const driver = fakeDriver();
    const runtime = createCuaDriverRuntime({ loadDriver: async () => driver });
    // 先建立真实具名控制会话；仅查询应用列表不再需要 end_session 清理。
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 10 } },
      context: context(),
    });
    driver.callTool.mockClear();
    let releaseFirst!: () => void;
    let releaseCleanup!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let first = true;
    const original = driver.callTool.getMockImplementation()!;
    driver.callTool.mockImplementation(async (name, ...args) => {
      if (first) {
        first = false;
        await firstGate;
      }
      if (name === "end_session") await cleanupGate;
      return original(name, ...args);
    });
    const active = runtime.execute({ toolName: "list_apps", context: context() });
    await vi.waitFor(() => expect(driver.callTool).toHaveBeenCalled());
    const queued = runtime.execute({ toolName: "list_apps", context: context() });
    const stopped = runtime.execute({ toolName: "stop_computer_control", context: context() });
    const other = runtime.execute({ toolName: "list_apps", context: context("local-b") });
    releaseFirst();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(await queued).toMatchObject({
      isError: true,
      structuredContent: { code: "controller_busy" },
    });
    await vi.waitFor(() =>
      expect(driver.callTool.mock.calls.some(([name]) => name === "end_session")).toBe(true),
    );
    let completed = false;
    void other.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    releaseCleanup();
    expect(await stopped).toMatchObject({ structuredContent: { stopped: true } });
    expect(await other).not.toHaveProperty("isError", true);
    expect(await runtime.execute({ toolName: "list_apps", context: context() })).toMatchObject({
      isError: true,
      structuredContent: { code: "controller_busy" },
    });
    await runtime.dispose();
  });

  it("does not admit an already aborted queued request", async () => {
    const driver = fakeDriver();
    const runtime = createCuaDriverRuntime({ loadDriver: async () => driver });
    const controller = new AbortController();
    controller.abort(new DOMException("cancel", "AbortError"));
    await expect(
      runtime.execute({ toolName: "list_apps", context: context(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(driver.callTool).not.toHaveBeenCalled();
    await runtime.dispose();
  });
});

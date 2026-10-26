import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createComputerUseRuntime } from "../index.js";
import { callBrokerMethod, resolveBrokerSocketPath } from "../broker.js";
import { isCuaPermissionStatusAvailable, shouldRunCuaScreenCaptureProbe } from "../broker-ports.js";
import { CuaHelperLifecycleManager } from "../broker-server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function broker(
  respond: (request: Record<string, any>, socket: import("node:net").Socket) => void,
) {
  const dir = await mkdtemp(join(tmpdir(), "uwcb-"));
  const socketPath = join(dir, "broker.sock");
  const requests: Record<string, any>[] = [];
  const server: Server = createServer((socket) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      if (!data.includes("\n")) return;
      const request = JSON.parse(data.slice(0, data.indexOf("\n")));
      requests.push(request);
      respond(request, socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { socketPath, requests };
}

const context = {
  sessionId: "s1",
  runtimeScope: "main" as const,
  workspaceKey: "/fixture",
  deliveryKind: "desktop-continuous" as const,
};

const primaryToken = "a".repeat(64);
const helperToken = "b".repeat(64);
async function routedClient(
  respondHelper?: (request: Record<string, any>, socket: import("node:net").Socket) => void,
) {
  const helper = await broker(
    respondHelper ??
      ((_request, socket) =>
        socket.end(`${JSON.stringify({ ok: true, result: { content: [] } })}\n`)),
  );
  const proxy = await broker((request, socket) =>
    socket.end(
      `${JSON.stringify(
        request.method === "resolve_transport" && request.token === primaryToken
          ? { ok: true, result: { socketPath: helper.socketPath, pluginAuthority: helperToken } }
          : { ok: false, error: { code: "not_authorized", message: "metadata only" } },
      )}\n`,
    ),
  );
  const runtime = createComputerUseRuntime({
    brokerSocketPath: proxy.socketPath,
    env: { ZCODE_CUA_PLUGIN_AUTHORITY: primaryToken },
  });
  return { helper, proxy, runtime };
}

describe("authenticated Helper client", () => {
  it("proxy 只解析 transport，node_repl 用真实 authority 直接连接 Helper 执行并清理", async () => {
    const { proxy, helper, runtime } = await routedClient();
    await expect(
      runtime.execute({ toolName: "list_apps", arguments: {}, context }),
    ).resolves.toEqual({ content: [] });
    expect(proxy.requests).toHaveLength(1);
    expect(proxy.requests[0]).toMatchObject({
      method: "resolve_transport",
      token: primaryToken,
      params: { context },
    });
    expect(helper.requests).toHaveLength(1);
    expect(helper.requests[0]).toMatchObject({
      method: "execute",
      token: helperToken,
      params: { toolName: "list_apps", context },
    });
    await runtime.dispose();
    expect(proxy.requests).toHaveLength(1);
    expect(helper.requests[1]).toMatchObject({ method: "close_session", token: helperToken });
  });

  it("缺少 authority 时不读取本机文件、不触碰 broker", async () => {
    const host = await broker((_request, socket) => socket.end("{}\n"));
    const runtime = createComputerUseRuntime({ brokerSocketPath: host.socketPath, env: {} });
    await expect(runtime.execute({ toolName: "list_apps", context })).resolves.toMatchObject({
      isError: true,
    });
    expect(host.requests).toHaveLength(0);
  });

  it.each([
    { ...context, runtimeScope: "subagent" as const },
    { ...context, workspaceIdentity: "remote:ssh:fixture:22:user:/workspace" },
    { ...context, remoteSessionId: "remote" },
    { ...context, deliveryKind: "web-remote-replayable" as const },
    { ...context, deliveryKind: undefined },
  ])("远端及 subagent 在发送前拒绝 %j", async (invalidContext) => {
    const host = await broker((_request, socket) => socket.end("{}\n"));
    const runtime = createComputerUseRuntime({
      brokerSocketPath: host.socketPath,
      env: { ZCODE_CUA_PLUGIN_AUTHORITY: "a".repeat(64) },
    });
    await expect(
      runtime.execute({ toolName: "left_click", context: invalidContext }),
    ).resolves.toMatchObject({ isError: true });
    expect(host.requests).toHaveLength(0);
  });

  it("本地 identity 合法且同 identity 的不同路径展示仍关闭同一会话", async () => {
    const { proxy, helper, runtime } = await routedClient();
    await runtime.execute({
      toolName: "list_apps",
      context: { ...context, workspaceIdentity: "local:fixture", workspacePath: "/one" },
    });
    await runtime.execute({
      toolName: "list_apps",
      context: { ...context, workspaceIdentity: "local:fixture", workspacePath: "/two" },
    });
    await runtime.dispose();
    expect(proxy.requests.map((request) => request.method)).toEqual([
      "resolve_transport",
      "resolve_transport",
    ]);
    expect(helper.requests.filter((request) => request.method === "execute")).toHaveLength(2);
    expect(helper.requests.filter((request) => request.method === "close_session")).toHaveLength(1);
  });

  it("未执行过的 context close/dispose 不启动 Helper、不请求 metadata", async () => {
    const { proxy, helper, runtime } = await routedClient();
    await runtime.closeSession(context);
    await runtime.dispose();
    expect(proxy.requests).toHaveLength(0);
    expect(helper.requests).toHaveLength(0);
  });

  it("显式 close_session 也只直连已使用的 Helper tuple", async () => {
    const { proxy, helper, runtime } = await routedClient();
    await runtime.execute({ toolName: "list_apps", context });
    await runtime.closeSession(context);
    await runtime.dispose();
    expect(proxy.requests.map((request) => request.method)).toEqual(["resolve_transport"]);
    expect(helper.requests.map((request) => request.method)).toEqual(["execute", "close_session"]);
    expect(helper.requests.every((request) => request.token === helperToken)).toBe(true);
  });

  it("metadata 失败没有 action_sent 且不会触碰 Helper", async () => {
    const helper = await broker((_request, socket) => socket.end("{}\n"));
    const proxy = await broker((_request, socket) =>
      socket.end(
        `${JSON.stringify({ ok: false, error: { code: "helper_unavailable", message: "missing bundle" } })}\n`,
      ),
    );
    const runtime = createComputerUseRuntime({
      brokerSocketPath: proxy.socketPath,
      env: { ZCODE_CUA_PLUGIN_AUTHORITY: primaryToken },
    });
    const result = (await runtime.execute({ toolName: "left_click", context })) as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "helper_unavailable" },
    });
    expect(result.structuredContent).not.toHaveProperty("action_sent");
    expect(proxy.requests[0].method).toBe("resolve_transport");
    await runtime.dispose();
    expect(helper.requests).toHaveLength(0);
  });

  it("Helper 动作连接中断保留 possibly_sent 并不重复 metadata 或动作", async () => {
    const { proxy, helper, runtime } = await routedClient((_request, socket) => socket.destroy());
    await expect(runtime.execute({ toolName: "left_click", context })).resolves.toMatchObject({
      isError: true,
      structuredContent: { action_sent: true, dispatch_status: "possibly_sent" },
    });
    expect(proxy.requests.map((request) => request.method)).toEqual(["resolve_transport"]);
    expect(helper.requests.map((request) => request.method)).toEqual(["execute"]);
  });

  it("resolve_transport 必须携带 token，不能匿名解析真实 Helper 连接材料", async () => {
    const proxy = await broker((_request, socket) => socket.end("{}\n"));
    await expect(
      callBrokerMethod({
        socketPath: proxy.socketPath,
        method: "resolve_transport",
        params: { context },
      }),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(proxy.requests).toHaveLength(0);
  });

  it("读取真实响应中的错误码", async () => {
    const host = await broker((_request, socket) =>
      socket.end(
        `${JSON.stringify({ ok: false, error: { code: "not_authorized", message: "denied" } })}\n`,
      ),
    );
    await expect(
      callBrokerMethod({ socketPath: host.socketPath, method: "execute", token: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });

  it("动作发出后超时保留可能已发送事实且不重试", async () => {
    const host = await broker(() => {});
    await expect(
      callBrokerMethod({
        socketPath: host.socketPath,
        method: "execute",
        token: "a".repeat(64),
        timeoutMs: 15,
      }),
    ).rejects.toMatchObject({ code: "timeout", actionSent: true });
    expect(host.requests).toHaveLength(1);
  });

  it("稳定 socket 按 data root/variant 隔离且短于 macOS 上限", () => {
    const env = { HOME: "/fixture", ZCODE_HOME: "/" + "a".repeat(200) };
    expect(resolveBrokerSocketPath({ env })).toBe(resolveBrokerSocketPath({ env }));
    expect(resolveBrokerSocketPath({ env }).length).toBeLessThan(104);
    expect(resolveBrokerSocketPath({ env })).not.toBe(
      resolveBrokerSocketPath({ env: { ...env, ZCODE_CUA_HELPER_INSTALL_VARIANT: "preview" } }),
    );
  });
});

describe("permission and lifecycle contracts", () => {
  it("接受 Host 既有省略 available 的完整权限快照", () => {
    expect(
      isCuaPermissionStatusAvailable({
        grantOwner: "helper",
        accessibility: "denied",
        screenRecording: "denied",
      }),
    ).toBe(true);
    expect(isCuaPermissionStatusAvailable({ available: false, reason: "not running" })).toBe(false);
    expect(isCuaPermissionStatusAvailable({} as never)).toBe(false);
  });
  it("功能抓屏探针必须显式选择且 TCC 已授权", () => {
    expect(shouldRunCuaScreenCaptureProbe("granted")).toBe(false);
    expect(shouldRunCuaScreenCaptureProbe("granted", { includeFunctionalProbes: true })).toBe(true);
    expect(shouldRunCuaScreenCaptureProbe("denied", { includeFunctionalProbes: true })).toBe(false);
  });
  it("生命周期 acquire 保留唯一当前 owner，dispose 后不可复活", async () => {
    let created = 0;
    const disposed: number[] = [];
    const lifecycle = new CuaHelperLifecycleManager<number>((value) => {
      disposed.push(value);
    });
    await lifecycle.acquire({ create: () => ++created });
    await lifecycle.acquire({ shouldRetainCurrent: () => true, create: () => ++created });
    expect(created).toBe(1);
    await lifecycle.dispose();
    expect(await lifecycle.acquire({ create: () => ++created })).toBeUndefined();
    expect(disposed).toEqual([1]);
  });
});

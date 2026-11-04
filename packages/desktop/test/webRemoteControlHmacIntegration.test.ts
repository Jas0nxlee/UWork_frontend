import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, WebRemoteControlAppPayload } from "@zcode/shared";
import { parseWebRemoteControlHmacQrParams } from "@zcode/shared";
import { createWebRemoteControlManager } from "@desktop/main/webRemoteControlManager.js";
import { createWebRemoteControlFeatureGate } from "@desktop/main/webRemoteControlFeatureGate.js";
import {
  createNodeWebRemoteControlRelayAuthProvider,
  createWebRemoteControlRelayAuthStorageProvider,
} from "../src/main/web-remote-relay/index.js";
import {
  WebRemoteControlEntry,
  WebRemoteControlHmacTerminalTransport,
  createBrowserWebRemoteControlRelayAuthProvider,
} from "../../web/src/web-remote-control/index.js";
import { createHmacTestRelay } from "./helpers/hmacRelay.js";
import {
  createEnterpriseIdentityService,
  disposeEnterpriseIdentityService,
} from "../../services/src/enterprise-identity/enterpriseIdentityService.js";
import {
  createSharedIdentitySessionStore,
  readEnterpriseIdentitySubject,
} from "../../services/src/enterprise-identity/identitySessionStore.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  options: {
    relayWsUrl?: string;
    includeTerminalSid?: boolean;
    remoteUrl?: string;
    enterpriseAuth?: {
      apiBaseUrl: string;
      identityApiBaseUrl?: string;
      allowSameOrgAnyUser: boolean;
      resolveLocalSubject?: () => Promise<{
        orgId: string;
        userId: string;
        displayName?: string;
      } | null>;
    };
  } = {},
) {
  const relay = await createHmacTestRelay({ includeTerminalSid: options.includeTerminalSid });
  cleanups.push(() => relay.close());
  const credentials = new Map<string, string>();
  const settings: AppSettings = { recentProjects: [] };
  const getLogin = vi.fn(async () => undefined);
  const clearLegacy = vi.fn(async () => {});
  const attachWorkspaceHost = vi.fn(async () => {
    throw new Error("No Host before explicit bridge open");
  });
  const authStorage = createWebRemoteControlRelayAuthStorageProvider({
    credentialService: {
      load: async (key) => credentials.get(key) ?? null,
      save: async (key, value) => {
        credentials.set(key, value);
      },
      delete: async (key) => {
        credentials.delete(key);
      },
    },
    loadSettings: async () => settings,
    patchSettings: async (patch) => {
      Object.assign(settings, patch);
    },
  });
  const manager = createWebRemoteControlManager({
    hmacRelay: {
      authProvider: createNodeWebRemoteControlRelayAuthProvider(),
      authStorageProvider: authStorage,
    },
    relayWsUrl: options.relayWsUrl ?? relay.wsUrl,
    mobileRemoteControlUrl: options.remoteUrl ?? `${relay.httpUrl}/remote/v4`,
    ...(options.enterpriseAuth ? { enterpriseAuth: options.enterpriseAuth } : {}),
    deviceMid: "test-desktop",
    deviceName: "UWork Desktop",
    appVersion: "3.16.6",
    getLogin,
    deviceStorage: { load: async () => undefined, save: async () => {}, clearLegacy },
    startupRestoreStorageProvider: {
      load: async () => settings.webRemoteControlLastEnabledContext,
      save: async (value) => {
        settings.webRemoteControlLastEnabledContext = value;
      },
      clear: async () => {
        settings.webRemoteControlLastEnabledContext = undefined;
      },
    },
    featureGate: createWebRemoteControlFeatureGate(true),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    platformHandlers: {
      isDockerAvailable: async () => false,
      listWSLDistros: async () => [],
      listDockerContainers: async () => [],
      listSSHConfigAliases: async () => [],
      loadMcpFromUserDirectory: async () => ({ servers: [] }),
      saveMcpToUserDirectory: async () => ({ success: true }),
      migrateLegacyCommonMcp: async () => ({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    },
    reconnectWorkspace: async () => {},
    attachWorkspaceHost,
    releaseWorkspaceHostAttachment: () => {},
    disposeWorkspaceHostAttachmentsForWindow: () => {},
    disposeWorkspaceHostAttachmentsForRemoteSession: () => {},
  });
  cleanups.push(async () => {
    await manager.suspend(1, "test-cleanup");
    await manager.suspend(2, "test-cleanup");
  });
  const context = { workspacePath: "/test-workspace" };
  const start = (windowId = 1) =>
    manager.startAuthorized(windowId, context, manager.authorizeStart(windowId, context));
  manager.syncAvailableWorkspaces(1, [{ ...context, label: "Test workspace", kind: "local" }]);
  return {
    relay,
    manager,
    start,
    settings,
    authStorage,
    getLogin,
    clearLegacy,
    attachWorkspaceHost,
  };
}

describe("UWork HMAC 双端真实 loopback 配对", () => {
  it("未配置自建端点时失败关闭，不向官方 V2 发送 HMAC 或读取账号", async () => {
    const f = await fixture({ relayWsUrl: "wss://zcode.z.ai/ws" });
    await expect(f.start()).rejects.toThrow("self-hosted relay endpoints are required");
    expect(f.relay.messages).toEqual([]);
    expect(f.getLogin).not.toHaveBeenCalled();
    expect(f.manager.getStatus(1)).toEqual({ status: "idle", entry: "qr" });
  });

  it("持久化 SID 从窗口1切到窗口2时先释放旧 device owner，保留配对材料且不争抢 socket", async () => {
    const f = await fixture();
    const first = parseWebRemoteControlHmacQrParams(
      new URL((await f.start(1)).qrUrl).searchParams,
    )!;
    const second = parseWebRemoteControlHmacQrParams(
      new URL((await f.start(2)).qrUrl).searchParams,
    )!;
    expect(second.deviceSid).toBe(first.deviceSid);
    expect(second.passHash).toBe(first.passHash);
    expect(f.manager.getStatus(1)).toEqual({ status: "idle", entry: "qr" });
    expect(f.manager.getStatus(2).status).toBe("running");
    expect(
      f.relay.messages.filter((message) => message.type === "device_register_init"),
    ).toHaveLength(1);
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: second.deviceSid,
      passHash: second.passHash,
    });
  });

  it("两个窗口同时首次开启时新 owner 撤销旧启动，只注册并保存当前窗口配对", async () => {
    const f = await fixture();
    const first = f.start(1).catch((error: unknown) => error);
    const second = f.start(2);
    expect(await first).toBeInstanceOf(Error);
    const result = await second;
    expect(f.manager.getStatus(1)).toEqual({ status: "idle", entry: "qr" });
    expect(f.manager.getStatus(2).status).toBe("running");
    const params = parseWebRemoteControlHmacQrParams(new URL(result.qrUrl).searchParams)!;
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: params.deviceSid,
      passHash: params.passHash,
    });
    expect(
      f.relay.messages.filter((message) => message.type === "device_register_init"),
    ).toHaveLength(1);
  });

  it("轮换撤销旧连接并注册新 SID/hash，不恢复旧配对材料", async () => {
    const f = await fixture();
    const before = parseWebRemoteControlHmacQrParams(
      new URL((await f.start()).qrUrl).searchParams,
    )!;
    const context = { workspacePath: "/test-workspace" };
    const result = await f.manager.resetPairingAuthorized(
      1,
      context,
      f.manager.authorizeStart(1, context),
    );
    const after = parseWebRemoteControlHmacQrParams(new URL(result.qrUrl).searchParams)!;
    expect(after.deviceSid).not.toBe(before.deviceSid);
    expect(after.passHash).not.toBe(before.passHash);
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: after.deviceSid,
      passHash: after.passHash,
    });
    expect(f.getLogin).not.toHaveBeenCalled();
  });

  it("stop 在慢配对读取期间撤销生命周期，迟到读取不能注册 relay 或复活 runtime", async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = vi.spyOn(f.authStorage, "load").mockImplementation(async () => {
      await pending;
      return undefined;
    });
    const starting = f.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const stopped = f.manager.stop(1);
    // 连接和 lease 同步撤销；磁盘清理按同一队列等待在途读取结算。
    expect(f.manager.getStatus(1).status).toBe("idle");
    release();
    await stopped;
    expect(await starting).toBeInstanceOf(Error);
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.relay.messages).toEqual([]);
  });

  it("轮换期间用户停止，迟到清理不能重新启动设备", async () => {
    const f = await fixture();
    await f.start();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.authStorage.clear.bind(f.authStorage);
    const clear = vi.spyOn(f.authStorage, "clear").mockImplementation(async () => {
      await pending;
      await original();
    });
    const context = { workspacePath: "/test-workspace" };
    const rotating = f.manager
      .resetPairingAuthorized(1, context, f.manager.authorizeStart(1, context))
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(clear).toHaveBeenCalled());
    const stopped = f.manager.stop(1);
    release();
    await stopped;
    expect(await rotating).toBeInstanceOf(Error);
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.settings.webRemoteControlLastEnabledContext).toBeUndefined();
  });

  it("stop 等待在途配对保存结算后清理启用意图，迟到保存不能复活 runtime", async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.authStorage.save.bind(f.authStorage);
    const save = vi.spyOn(f.authStorage, "save").mockImplementation(async (auth) => {
      await pending;
      await original(auth);
    });
    const starting = f.start().catch((error: unknown) => error);
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    const stopped = f.manager.stop(1);
    release();
    await stopped;
    expect(await starting).toBeInstanceOf(Error);
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.settings.webRemoteControlLastEnabledContext).toBeUndefined();
  });

  it("旧 owner 的失效凭据清理与新 owner 读取串行，不擦除新保存的配对", async () => {
    const f = await fixture();
    await f.authStorage.save({ deviceSid: "missing-room", passHash: "obsolete-hash" });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.authStorage.clear.bind(f.authStorage);
    const clear = vi.spyOn(f.authStorage, "clear").mockImplementation(async () => {
      await pending;
      await original();
    });
    const first = f.start(1).catch((error: unknown) => error);
    await vi.waitFor(() => expect(clear).toHaveBeenCalled());
    const second = f.start(2);
    release();
    expect(await first).toBeInstanceOf(Error);
    const result = await second;
    const params = parseWebRemoteControlHmacQrParams(new URL(result.qrUrl).searchParams)!;
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: params.deviceSid,
      passHash: params.passHash,
    });
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(f.manager.getStatus(2).status).toBe("running");
  });

  it("无 OAuth 桌面生成 QR，手机绕过登录并完成 workspace 请求；停止保留配对，再启动复用 SID", async () => {
    const f = await fixture();
    const result = await f.start();
    const params = parseWebRemoteControlHmacQrParams(new URL(result.qrUrl).searchParams)!;
    expect(params).toMatchObject({ deviceMid: "test-desktop", deviceName: "UWork Desktop" });
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: params.deviceSid,
      passHash: params.passHash,
    });
    expect(f.getLogin).not.toHaveBeenCalled();
    expect(f.clearLegacy).not.toHaveBeenCalled();
    const auth = {
      getZCodeJwtToken: vi.fn(() => null),
      getActiveAccount: vi.fn(() => null),
      startLogin: vi.fn(),
      logout: vi.fn(async () => {}),
    };
    const received: WebRemoteControlAppPayload[] = [];
    const devices = vi.fn(async () => []),
      token = vi.fn(async () => "should-not-read");
    const terminalStates: string[] = [];
    let terminal: WebRemoteControlHmacTerminalTransport | undefined;
    const entry = new WebRemoteControlEntry({
      protocol: "hmac-v1",
      auth,
      getHref: () => result.qrUrl,
      replaceHref: vi.fn(),
      storage: { getItem: () => null, setItem: () => {} },
      locale: "zh-CN",
      devices,
      token,
      subscribeVisible: () => () => {},
      onView: vi.fn(),
      connect: (connection) => {
        terminal = new WebRemoteControlHmacTerminalTransport({
          relayWsUrl: f.relay.wsUrl,
          deviceSid: connection.params.deviceSid,
          passHash: connection.params.passHash!,
          authProvider: createBrowserWebRemoteControlRelayAuthProvider(),
          WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
          onStateChange: (state) => {
            terminalStates.push(state);
          },
          onFailure: vi.fn(),
          onError: vi.fn(),
          reloadPage: vi.fn(),
          onPayload: (payload) => received.push(payload),
        });
        cleanups.push(() => terminal?.dispose());
        terminal.start();
        cleanups.push(() => entry.dispose());
      },
    });
    await entry.start();
    await vi.waitFor(() => expect(terminalStates).toContain("paired"));
    terminal!.sendPayload({ zcode_type: "workspace-list-request", requestId: "hmac-list" });
    await vi.waitFor(() =>
      expect(received).toContainEqual(
        expect.objectContaining({
          zcode_type: "workspace-list-response",
          requestId: "hmac-list",
          success: true,
        }),
      ),
    );
    expect(auth.getZCodeJwtToken).not.toHaveBeenCalled();
    expect(auth.startLogin).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
    expect(devices).not.toHaveBeenCalled();
    expect(f.attachWorkspaceHost).not.toHaveBeenCalled();
    await f.manager.notifyAuthStateChanged(1, { state: "signed-out" });
    expect(f.manager.getStatus(1).status).toBe("active");
    await f.manager.stop(1);
    expect(f.manager.getStatus(1).status).toBe("idle");
    expect(await f.authStorage.load()).toMatchObject({
      deviceSid: params.deviceSid,
      passHash: params.passHash,
    });
    const resumed = await f.start();
    expect(parseWebRemoteControlHmacQrParams(new URL(resumed.qrUrl).searchParams)).toMatchObject({
      deviceSid: params.deviceSid,
      passHash: params.passHash,
    });
  });
});

describe("手机远控的企业身份准入（方案 A）", () => {
  it("二维码带组织与准入基址；校验通过前丢弃其它 payload，通过后才放行", async () => {
    const refresh = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: "phone-token-2",
        user: { id: "user-1", org_id: "org-a", wecom_userid: "wx-1", name: "张三" },
      }),
    }));
    vi.stubGlobal("fetch", refresh);
    cleanups.push(() => vi.unstubAllGlobals());
    const f = await fixture({
      enterpriseAuth: {
        apiBaseUrl: "https://pivot.example.com",
        allowSameOrgAnyUser: false,
        resolveLocalSubject: async () => ({
          orgId: "org-a",
          userId: "user-1",
          displayName: "张三",
        }),
      },
    });
    const started = await f.start();
    const params = parseWebRemoteControlHmacQrParams(new URL(started.qrUrl).searchParams)!;
    expect(params.enterpriseOrg).toBe("org-a");
    expect(params.enterpriseAuth).toBe("https://pivot.example.com");

    const received: WebRemoteControlAppPayload[] = [];
    const terminal = new WebRemoteControlHmacTerminalTransport({
      relayWsUrl: f.relay.wsUrl,
      deviceSid: params.deviceSid,
      passHash: params.passHash,
      authProvider: createBrowserWebRemoteControlRelayAuthProvider(),
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      onStateChange: () => {},
      onFailure: vi.fn(),
      onError: vi.fn(),
      reloadPage: vi.fn(),
      onPayload: (payload) => received.push(payload),
    });
    cleanups.push(() => terminal.dispose());
    terminal.start();
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(0));
    await vi.waitFor(() => expect(f.manager.getStatus(1).mobileConnected).toBe(true));

    // 校验前：bootstrap-request 必须被丢弃（桌面不回应，也不排队）。
    terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "req-1" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.filter((payload) => payload.zcode_type === "bootstrap-response")).toHaveLength(
      0,
    );

    // 带上身份后：桌面向 control-plane 校验一次，随后放行。
    terminal.sendPayload({ zcode_type: "enterprise-identity", token: "phone-token" });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(String(refresh.mock.calls[0]?.[0])).toBe("https://pivot.example.com/api/auth/refresh");
    await vi.waitFor(() =>
      expect(
        received.filter((payload) => payload.zcode_type === "bootstrap-response"),
      ).toHaveLength(0),
    );
    terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "req-2" });
    await vi.waitFor(() =>
      expect(
        received.filter((payload) => payload.zcode_type === "bootstrap-response"),
      ).toHaveLength(1),
    );
  });

  it("backend=uwork 且登录在 pivot 时：身份证校验打 pivot，设备登记仍打自建后台", async () => {
    const refresh = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: "phone-token-2",
        user: { id: "user-1", org_id: "org-a", wecom_userid: "wx-1", name: "张三" },
      }),
    }));
    const deviceCalls: string[] = [];
    const fetchImpl = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const target = String(url);
      if (target.startsWith("https://pivot.example.com/api/auth/refresh")) return refresh();
      if (target.includes("/api/client/remote-devices/") && init?.method === "PUT") {
        deviceCalls.push(target);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (target.includes("/api/client/remote-pairings/next")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { ok: true, status: 200, json: async () => ({ pairing: null }) };
      }
      if (target.includes("/api/client/remote-devices/") && init?.method === "DELETE")
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${target}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    cleanups.push(() => vi.unstubAllGlobals());
    const f = await fixture({
      enterpriseAuth: {
        apiBaseUrl: "https://backend.example.com",
        identityApiBaseUrl: "https://pivot.example.com",
        allowSameOrgAnyUser: false,
        backend: "uwork",
        resolveLocalSubject: async () => ({ orgId: "org-a", userId: "user-1" }),
        resolveLocalSessionToken: async () => "desktop-pivot-token",
      },
    });
    const params = parseWebRemoteControlHmacQrParams(
      new URL((await f.start()).qrUrl).searchParams,
    )!;
    await vi.waitFor(() => expect(deviceCalls.length).toBeGreaterThan(0));
    // 设备登记打自建后台，手机令牌的身份校验打 pivot。
    expect(deviceCalls[0]).toContain("https://backend.example.com/api/client/remote-devices/");
    const received: WebRemoteControlAppPayload[] = [];
    const terminal = new WebRemoteControlHmacTerminalTransport({
      relayWsUrl: f.relay.wsUrl,
      deviceSid: params.deviceSid,
      passHash: params.passHash,
      authProvider: createBrowserWebRemoteControlRelayAuthProvider(),
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      onStateChange: () => {},
      onFailure: vi.fn(),
      onError: vi.fn(),
      reloadPage: vi.fn(),
      onPayload: (payload) => received.push(payload),
    });
    cleanups.push(() => terminal.dispose());
    terminal.start();
    await vi.waitFor(() => expect(f.manager.getStatus(1).mobileConnected).toBe(true));
    terminal.sendPayload({ zcode_type: "enterprise-identity", token: "phone-token" });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "req-1" });
    await vi.waitFor(() =>
      expect(
        received.filter((payload) => payload.zcode_type === "bootstrap-response"),
      ).toHaveLength(1),
    );
  });

  it("组织不符时拒绝连接并把原因回给手机", async () => {
    const refresh = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: "phone-token-2",
        user: { id: "user-2", org_id: "org-b", wecom_userid: "wx-2", name: "李四" },
      }),
    }));
    vi.stubGlobal("fetch", refresh);
    cleanups.push(() => vi.unstubAllGlobals());
    const f = await fixture({
      enterpriseAuth: {
        apiBaseUrl: "https://pivot.example.com",
        allowSameOrgAnyUser: false,
        resolveLocalSubject: async () => ({ orgId: "org-a", userId: "user-1" }),
      },
    });
    const params = parseWebRemoteControlHmacQrParams(
      new URL((await f.start()).qrUrl).searchParams,
    )!;
    const received: WebRemoteControlAppPayload[] = [];
    const terminal = new WebRemoteControlHmacTerminalTransport({
      relayWsUrl: f.relay.wsUrl,
      deviceSid: params.deviceSid,
      passHash: params.passHash,
      authProvider: createBrowserWebRemoteControlRelayAuthProvider(),
      WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
      onStateChange: () => {},
      onFailure: vi.fn(),
      onError: vi.fn(),
      reloadPage: vi.fn(),
      onPayload: (payload) => received.push(payload),
    });
    cleanups.push(() => terminal.dispose());
    terminal.start();
    await vi.waitFor(() => expect(f.manager.getStatus(1).mobileConnected).toBe(true));
    terminal.sendPayload({ zcode_type: "enterprise-identity", token: "phone-token" });
    await vi.waitFor(() =>
      expect(received.some((payload) => payload.zcode_type === "app-error")).toBe(true),
    );
    const error = received.find((payload) => payload.zcode_type === "app-error");
    expect(error).toMatchObject({ reason: "enterprise-identity-rejected" });
    expect(String(error?.error ?? "")).toContain("公司");
  });
});

async function connectEnterpriseTerminal(
  f: Awaited<ReturnType<typeof fixture>>,
  params: NonNullable<ReturnType<typeof parseWebRemoteControlHmacQrParams>>,
  mid: string,
) {
  const received: WebRemoteControlAppPayload[] = [];
  let paired = false;
  const terminal = new WebRemoteControlHmacTerminalTransport({
    relayWsUrl: f.relay.wsUrl,
    deviceSid: params.deviceSid,
    deviceMid: mid,
    passHash: params.passHash,
    authProvider: createBrowserWebRemoteControlRelayAuthProvider(),
    WebSocketCtor: WebSocket as unknown as typeof globalThis.WebSocket,
    onStateChange: (state) => {
      if (state === "paired") paired = true;
    },
    onFailure: vi.fn(),
    onError: vi.fn(),
    reloadPage: vi.fn(),
    onPayload: (payload) => received.push(payload),
  });
  cleanups.push(() => terminal.dispose());
  terminal.start();
  await vi.waitFor(() => expect(paired).toBe(true));
  return { terminal, received };
}
const acceptedEnterpriseIdentity = () => ({
  ok: true,
  status: 200,
  json: async () => ({ user: { id: "user-1", org_id: "org-a" } }),
});
const enterpriseFixture = {
  apiBaseUrl: "https://auth.example.com",
  allowSameOrgAnyUser: false,
  resolveLocalSubject: async () => ({ orgId: "org-a", userId: "user-1" }),
};

it("新手机替换已验证终端后，必须重新提交企业身份，不能复用旧资格", async () => {
  const refresh = vi.fn(async () => acceptedEnterpriseIdentity());
  vi.stubGlobal("fetch", refresh);
  cleanups.push(() => vi.unstubAllGlobals());
  const f = await fixture({ enterpriseAuth: enterpriseFixture });
  const params = parseWebRemoteControlHmacQrParams(new URL((await f.start()).qrUrl).searchParams)!;
  const a = await connectEnterpriseTerminal(f, params, "phone-a");
  a.terminal.sendPayload({ zcode_type: "enterprise-identity", token: "token-a" });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  a.terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "authorized-a" });
  await vi.waitFor(() =>
    expect(a.received.some((p) => p.zcode_type === "bootstrap-response")).toBe(true),
  );
  const b = await connectEnterpriseTerminal(f, params, "phone-b");
  b.terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "unverified-b" });
  b.terminal.sendPayload({ zcode_type: "enterprise-identity", token: "token-b" });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(b.received.some((p) => p.zcode_type === "mobile-task-view-request")).toBe(true),
  );
  expect(
    b.received.some((p) => p.zcode_type === "bootstrap-response" && p.requestId === "unverified-b"),
  ).toBe(false);
  b.terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "authorized-b" });
  await vi.waitFor(() =>
    expect(
      b.received.some(
        (p) => p.zcode_type === "bootstrap-response" && p.requestId === "authorized-b",
      ),
    ).toBe(true),
  );
});

it("旧手机的迟到身份验证不能放行替换后的新手机", async () => {
  let release!: (response: ReturnType<typeof acceptedEnterpriseIdentity>) => void;
  let readOldResponse = false;
  const refresh = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockImplementation(async () => acceptedEnterpriseIdentity());
  vi.stubGlobal("fetch", refresh);
  cleanups.push(() => vi.unstubAllGlobals());
  const f = await fixture({ enterpriseAuth: enterpriseFixture });
  const params = parseWebRemoteControlHmacQrParams(new URL((await f.start()).qrUrl).searchParams)!;
  const a = await connectEnterpriseTerminal(f, params, "phone-a");
  a.terminal.sendPayload({ zcode_type: "enterprise-identity", token: "late-a" });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  const b = await connectEnterpriseTerminal(f, params, "phone-b");
  release({
    ok: true,
    status: 200,
    json: async () => {
      readOldResponse = true;
      return { user: { id: "user-1", org_id: "org-a" } };
    },
  });
  await vi.waitFor(() => expect(readOldResponse).toBe(true));
  b.terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "unverified-late-b" });
  b.terminal.sendPayload({ zcode_type: "enterprise-identity", token: "fresh-b" });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(b.received.some((p) => p.zcode_type === "mobile-task-view-request")).toBe(true),
  );
  expect(
    b.received.some(
      (p) => p.zcode_type === "bootstrap-response" && p.requestId === "unverified-late-b",
    ),
  ).toBe(false);
});

it("启用企业门禁但relay未提供终端身份时拒绝，不退回已验证窗口资格", async () => {
  const refresh = vi.fn(async () => acceptedEnterpriseIdentity());
  vi.stubGlobal("fetch", refresh);
  cleanups.push(() => vi.unstubAllGlobals());
  const f = await fixture({ includeTerminalSid: false, enterpriseAuth: enterpriseFixture });
  const params = parseWebRemoteControlHmacQrParams(new URL((await f.start()).qrUrl).searchParams)!;
  const phone = await connectEnterpriseTerminal(f, params, "phone-without-id");
  phone.terminal.sendPayload({ zcode_type: "enterprise-identity", token: "token" });
  await vi.waitFor(() =>
    expect(
      phone.received.some(
        (p) => p.zcode_type === "app-error" && p.reason === "enterprise-identity-rejected",
      ),
    ).toBe(true),
  );
  expect(refresh).not.toHaveBeenCalled();
});

it.each(["switch", "logout", "resolver-error"])(
  "企业身份%s撤销已验证HMAC会话，同人续期保持",
  async (change) => {
    let subject: { orgId: string; userId: string } | null = { orgId: "org-a", userId: "user-1" };
    let resolverFails = false;
    const refresh = vi.fn(async () => acceptedEnterpriseIdentity());
    vi.stubGlobal("fetch", refresh);
    cleanups.push(() => vi.unstubAllGlobals());
    const f = await fixture({
      enterpriseAuth: {
        ...enterpriseFixture,
        resolveLocalSubject: async () => {
          if (resolverFails) throw new Error("identity unavailable");
          return subject;
        },
      },
    });
    const params = parseWebRemoteControlHmacQrParams(
      new URL((await f.start()).qrUrl).searchParams,
    )!;
    const phone = await connectEnterpriseTerminal(f, params, "phone-a");
    phone.terminal.sendPayload({ zcode_type: "enterprise-identity", token: "token-a" });
    await vi.waitFor(() =>
      expect(phone.received.some((p) => p.zcode_type === "mobile-task-view-request")).toBe(true),
    );
    await f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
    expect(f.manager.getStatus(1).mobileConnected).toBe(true);
    subject = change === "switch" ? { orgId: "org-a", userId: "user-2" } : null;
    resolverFails = change === "resolver-error";
    await f.manager.notifyAuthStateChanged(1, {
      state: change === "switch" ? "signed-in" : "signed-out",
    });
    expect(f.manager.getStatus(1).status).toBe("idle");
  },
);

it("旧企业身份读取迟到不能停止新窗口runtime", async () => {
  let subject = { orgId: "org-a", userId: "user-1" };
  let pendingRead: Promise<typeof subject> | undefined;
  let release!: (value: typeof subject) => void;
  const f = await fixture({
    enterpriseAuth: {
      ...enterpriseFixture,
      resolveLocalSubject: async () => {
        if (pendingRead) {
          const current = pendingRead;
          pendingRead = undefined;
          return current;
        }
        return subject;
      },
    },
  });
  await f.start();
  pendingRead = new Promise((resolve) => {
    release = resolve;
  });
  const oldNotification = f.manager.notifyAuthStateChanged(1, { state: "signed-in" });
  subject = { orgId: "org-a", userId: "user-2" };
  await f.start();
  release({ orgId: "org-a", userId: "user-1" });
  await oldNotification;
  expect(f.manager.getStatus(1).status).toBe("running");
});

it("桌面注销后迟到的手机验证不能复活已停止runtime", async () => {
  let subject: { orgId: string; userId: string } | null = { orgId: "org-a", userId: "user-1" };
  let release!: (value: ReturnType<typeof acceptedEnterpriseIdentity>) => void;
  let readResponse = false;
  const refresh = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal("fetch", refresh);
  cleanups.push(() => vi.unstubAllGlobals());
  const f = await fixture({
    enterpriseAuth: { ...enterpriseFixture, resolveLocalSubject: async () => subject },
  });
  const params = parseWebRemoteControlHmacQrParams(new URL((await f.start()).qrUrl).searchParams)!;
  const phone = await connectEnterpriseTerminal(f, params, "phone-a");
  phone.terminal.sendPayload({ zcode_type: "enterprise-identity", token: "late-a" });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  subject = null;
  await f.manager.notifyAuthStateChanged(1, { state: "signed-out" });
  release({
    ok: true,
    status: 200,
    json: async () => {
      readResponse = true;
      return { user: { id: "user-1", org_id: "org-a" } };
    },
  });
  await vi.waitFor(() => expect(readResponse).toBe(true));
  expect(f.manager.getStatus(1).status).toBe("idle");
});

it("真实身份owner先清空UI、延迟提交注销后，Main仍会重新读取并撤销已验证终端", async () => {
  const values = new Map<string, string>();
  let releaseTombstone!: () => void;
  let tombstoneStarted!: () => void;
  const writingTombstone = new Promise<void>((resolve) => {
    tombstoneStarted = resolve;
  });
  const tombstoneGate = new Promise<void>((resolve) => {
    releaseTombstone = resolve;
  });
  const credentials = {
    load: async (key: string) => values.get(key) ?? null,
    save: async (key: string, value: string) => {
      if (JSON.parse(value).session === null) {
        tombstoneStarted();
        await tombstoneGate;
      }
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
  let writes: Promise<unknown> = Promise.resolve();
  const store = createSharedIdentitySessionStore(credentials, <T>(operation: () => Promise<T>) => {
    const result = writes.then(operation, operation);
    writes = result.catch(() => {});
    return result;
  });
  const session = {
    profile: { id: "user-1", tenantId: "org-a", provider: "wecom" as const, displayName: "User" },
    token: "desktop-token",
    expiresAt: Date.now() + 600_000,
  };
  await store.write(session, 0, () => true);
  const owner = createEnterpriseIdentityService({
    credentials,
    sessionStore: store,
    adapter: {
      listOrganizations: () => [],
      resolveOrganization: () => undefined,
      start: async () => {
        throw new Error("Login is outside this regression");
      },
      restore: async () => session,
    },
  });
  await owner.restoreSession();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => acceptedEnterpriseIdentity()),
  );
  cleanups.push(() => vi.unstubAllGlobals());
  const f = await fixture({
    enterpriseAuth: {
      ...enterpriseFixture,
      resolveLocalSubject: () => readEnterpriseIdentitySubject(credentials),
    },
  });
  const notifications: Promise<void>[] = [];
  const subscription = owner.onDidChange((view) => {
    notifications.push(
      f.manager.notifyAuthStateChanged(1, {
        state: view.status === "authenticated" ? "signed-in" : "signed-out",
      }),
    );
  });
  cleanups.push(async () => {
    subscription.dispose();
    await disposeEnterpriseIdentityService(owner);
  });
  const params = parseWebRemoteControlHmacQrParams(new URL((await f.start()).qrUrl).searchParams)!;
  const phone = await connectEnterpriseTerminal(f, params, "phone-owner-logout");
  phone.terminal.sendPayload({ zcode_type: "enterprise-identity", token: "phone-token" });
  await vi.waitFor(() =>
    expect(phone.received.some((p) => p.zcode_type === "mobile-task-view-request")).toBe(true),
  );
  const logout = owner.logout();
  await writingTombstone;
  await Promise.all(notifications);
  expect((await owner.getView()).status).toBe("signed-out");
  expect(f.manager.getStatus(1).mobileConnected).toBe(true);
  releaseTombstone();
  await logout;
  await Promise.all(notifications);
  expect(await readEnterpriseIdentitySubject(credentials)).toBeNull();
  expect(f.manager.getStatus(1).status).toBe("idle");
});

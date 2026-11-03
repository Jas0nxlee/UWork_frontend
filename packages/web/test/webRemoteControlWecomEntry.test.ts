import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRemoteControlEntry } from "#src/web-remote-control/index.js";
import { saveEnterpriseAuthToken } from "#src/web-remote-control/app/enterpriseAuth.js";

const BACKEND = "https://backend.example.test";
const ORG = "tenant-1";
const ENTRY_HREF = `https://aihub.example.test/remote/v4?backend=uwork&org=${ORG}&enterprise_auth=${encodeURIComponent(BACKEND)}`;
const WE_COM_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 wxwork/4.1.26 MicroMessenger/7.0.1";

function setup(href: string, userAgent: string, fetchImpl?: typeof fetch) {
  const connect = vi.fn();
  const onView = vi.fn();
  const storage = new Map<string, string>();
  const entry = new WebRemoteControlEntry({
    auth: {
      getZCodeJwtToken: () => null,
      getActiveAccount: () => null,
      startLogin: vi.fn(),
      logout: vi.fn(async () => {}),
    },
    protocol: "hmac-v1",
    getHref: () => href,
    replaceHref: (next) => {
      href = next;
    },
    storage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
    locale: "zh-CN",
    userAgent,
    ...(fetchImpl ? { fetchImpl } : {}),
    devices: vi.fn(async () => []),
    subscribeVisible: () => () => {},
    token: vi.fn(async () => "one-use-token"),
    connect,
    onView,
  });
  return { entry, connect, onView, storage };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WeCom workbench entry (backend=uwork)", () => {
  it("refuses plain browsers before any network call", async () => {
    const fetchImpl = vi.fn(async () => json({ devices: [] }));
    vi.stubGlobal("fetch", fetchImpl);
    const f = setup(ENTRY_HREF, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15");
    await f.entry.start();
    expect(f.onView).toHaveBeenCalledWith({
      kind: "failure",
      failure: { reason: "wecom-app-required" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("lists the member's devices inside WeCom and pairs without scanning", async () => {
    const fetchImpl = vi.fn(async (url: URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/client/remote-devices")) {
        expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
          "Bearer session-1",
        );
        return json({
          devices: [
            { deviceSid: "sid-1", deviceMid: "mid-1", name: "办公室 Mac", platform: "darwin" },
          ],
        });
      }
      if (path.endsWith("/remote-devices/sid-1/pairings"))
        return json({ id: "pair-1", expiresAt: Date.now() + 60_000 }, 201);
      if (path.endsWith("/remote-devices/sid-1/pairings/pair-1"))
        return json({
          status: "answered",
          pairing: {
            sid: "sid-1",
            hash: "hash-abcdefghijklmnop",
            org: ORG,
            enterpriseAuth: BACKEND,
          },
        });
      throw new Error(`unexpected request ${path}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    const f = setup(ENTRY_HREF, WE_COM_UA);
    // 手机页在企微里已经完成过登录（token 存 sessionStorage）。
    saveEnterpriseAuthToken(
      {
        getItem: (key) => f.storage.get(key) ?? null,
        setItem: (key, value) => {
          f.storage.set(key, value);
        },
      },
      { apiBaseUrl: BACKEND, orgId: ORG },
      "session-1",
    );

    await f.entry.start();
    const devicesView = f.onView.mock.calls
      .map((call) => call[0])
      .filter((view) => view.kind === "devices")
      .at(-1);
    expect(devicesView?.devices).toHaveLength(1);
    expect(devicesView?.devices[0].deviceMid).toBe("mid-1");

    f.entry.selectDevice("sid-1");
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(1));
    const params = (f.connect.mock.calls[0] as unknown as [{ params: Record<string, unknown> }])[0]
      .params;
    expect(params.deviceSid).toBe("sid-1");
    expect(params.passHash).toBe("hash-abcdefghijklmnop");
    expect(params.enterpriseAuth).toBe(BACKEND);
    expect(params.enterpriseOrg).toBe(ORG);
    // 连接后手机顶部显示的是设备名，缺了就会退化成"未命名设备"。
    expect(params.deviceName).toBe("办公室 Mac");

    // 连接后点顶部设备名（切换设备）要回到"我的设备"，不能退回二维码页。
    const viewsBefore = f.onView.mock.calls.length;
    await f.entry.chooseOtherDevice();
    const afterViews = f.onView.mock.calls
      .slice(viewsBefore)
      .map(([view]) => view as { kind: string });
    expect(afterViews.some((view) => view.kind === "devices")).toBe(true);
    expect(afterViews.some((view) => view.kind === "scan")).toBe(false);
  });

  it("works from a clean workbench URL by resolving the backend on the same origin", async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      const path = String(url);
      if (path.endsWith("/api/auth/wecom/web-config"))
        return json({ backend: "uwork", tenantId: ORG });
      if (path.endsWith("/api/client/remote-devices"))
        return json({
          devices: [
            { deviceSid: "sid-1", deviceMid: "mid-1", name: "办公室 Mac", platform: "darwin" },
          ],
        });
      if (path.endsWith("/remote-devices/sid-1/pairings"))
        return json({ id: "pair-1", expiresAt: Date.now() + 60_000 }, 201);
      if (path.endsWith("/remote-devices/sid-1/pairings/pair-1"))
        return json({
          status: "answered",
          pairing: {
            sid: "sid-1",
            hash: "hash-abcdefghijklmnop",
            org: ORG,
            enterpriseAuth: "https://aihub.example.test",
          },
        });
      throw new Error(`unexpected request ${path}`);
    });
    const f = setup(
      "https://aihub.example.test/remote/v4",
      WE_COM_UA,
      fetchImpl as unknown as typeof fetch,
    );
    saveEnterpriseAuthToken(
      {
        getItem: (key) => f.storage.get(key) ?? null,
        setItem: (key, value) => {
          f.storage.set(key, value);
        },
      },
      { apiBaseUrl: "https://aihub.example.test", orgId: ORG },
      "session-1",
    );
    await f.entry.start();
    // 组织与后端基址都来自同源 web-config，URL 里没有任何参数。
    expect(fetchImpl.mock.calls[0]?.[0]?.toString()).toBe(
      "https://aihub.example.test/api/auth/wecom/web-config",
    );
    const devicesView = f.onView.mock.calls
      .map((call) => call[0])
      .filter((view) => view.kind === "devices")
      .at(-1);
    expect(devicesView?.devices).toHaveLength(1);
    f.entry.selectDevice("sid-1");
    await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(1));
    const params = (f.connect.mock.calls[0] as unknown as [{ params: Record<string, unknown> }])[0]
      .params;
    expect(params.enterpriseAuth).toBe("https://aihub.example.test");
    expect(params.enterpriseOrg).toBe(ORG);
  });

  it("后台配了 pivot 时：手机页用 pivot 换令牌，设备接口仍打自建后台", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: URL, init?: RequestInit) => {
      const target = String(url);
      calls.push({ url: target, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (target.endsWith("/api/auth/wecom/web-config"))
        return json({
          backend: "uwork",
          tenantId: ORG,
          pivotApiBaseUrl: "https://pivot.example.test:23090",
        });
      if (target.startsWith("https://pivot.example.test:23090/api/auth/login"))
        return json({ token: "pivot-session-token", user: { id: "u-1", org_id: "org-1" } });
      if (target.endsWith("/api/client/remote-devices"))
        return json({
          devices: [
            { deviceSid: "sid-1", deviceMid: "mid-1", name: "办公室 Mac", platform: "darwin" },
          ],
        });
      throw new Error(`unexpected request ${target}`);
    });
    vi.stubGlobal("fetch", fetchImpl);
    // 企微授权回跳：带 code/state 回到本页。
    const f = setup(
      "https://aihub.example.test/remote/v4?code=wecom-code-1&state=org-1",
      WE_COM_UA,
      fetchImpl as unknown as typeof fetch,
    );
    await f.entry.start();
    const loginCall = calls.find((call) => call.url.includes("/api/auth/login"));
    expect(loginCall?.url).toBe("https://pivot.example.test:23090/api/auth/login");
    expect(loginCall?.body).toContain("wecom-code-1");
    const devicesView = f.onView.mock.calls
      .map((call) => call[0])
      .filter((view) => view.kind === "devices")
      .at(-1);
    expect(devicesView?.devices).toHaveLength(1);
    // 设备目录用的是自建后台（同源），带的是 pivot 会话令牌。
    const devicesCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith("/api/client/remote-devices"),
    );
    expect(String(devicesCall?.[0])).toBe("https://aihub.example.test/api/client/remote-devices");
    expect((devicesCall?.[1]?.headers as Record<string, string>).Authorization).toBe(
      "Bearer pivot-session-token",
    );
  });

  it("免扫码入口跳企微授权时给出过渡页，绝不显示 ZCode 官方登录页", async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      const target = String(url);
      if (target.endsWith("/api/auth/wecom/web-config"))
        return json({
          backend: "uwork",
          tenantId: ORG,
          pivotApiBaseUrl: "https://pivot.example.test:23090",
        });
      if (target.includes("/api/auth/authorize"))
        return json({ url: "https://open.weixin.qq.com/connect/oauth2/authorize?appid=corp" });
      throw new Error(`unexpected ${target}`);
    });
    const f = setup(
      "https://pivot.example.test:23090/remote/v4",
      WE_COM_UA,
      fetchImpl as unknown as typeof fetch,
    );
    // 没有 token：会去企微授权；不该出现 kind:"login"（那是 ZCode 官方登录页）。
    await f.entry.start().catch(() => {});
    const kinds = f.onView.mock.calls.map(([view]) => (view as { kind: string }).kind);
    expect(kinds).toContain("authorizing");
    expect(kinds).not.toContain("login");
  });

  it("曾经是免扫码入口的来源探测失败时不退化成扫码页，给可重试的失败卡片", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { code: "INTERNAL" } }, 500));
    const f = setup(
      "https://pivot.example.test:23090/remote/v4",
      WE_COM_UA,
      fetchImpl as unknown as typeof fetch,
    );
    // 之前成功探测过（marker 在），这次失败了。
    f.storage.set("uwork.remote-enterprise-entry:https://pivot.example.test:23090", "1");
    await f.entry.start();
    const views = f.onView.mock.calls.map(
      ([view]) => view as { kind: string; failure?: { reason: string } },
    );
    expect(
      views.some((view) => view.kind === "failure" && view.failure?.reason === "unexpected-error"),
    ).toBe(true);
    expect(views.some((view) => view.kind === "scan")).toBe(false);
  });

  it("still refuses a plain browser on a clean workbench URL", async () => {
    const fetchImpl = vi.fn(async () => json({ backend: "uwork", tenantId: ORG }));
    const f = setup(
      "https://aihub.example.test/remote/v4",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
      fetchImpl as unknown as typeof fetch,
    );
    await f.entry.start();
    expect(f.onView).toHaveBeenCalledWith({
      kind: "failure",
      failure: { reason: "wecom-app-required" },
    });
    // 只做了同源探测，没有触达任何业务接口。
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://aihub.example.test/api/auth/wecom/web-config",
    ]);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("keeps the scanned QR path unchanged (ucas backend, sid/hash present)", async () => {
    const fetchImpl = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetchImpl);
    const href =
      "https://aihub.example.test/remote/v4?sid=sid-9&hash=hash-abcdefghijklmnop&t=1700000000";
    const f = setup(href, "Mozilla/5.0 (Macintosh) Safari/605.1.15");
    await f.entry.start();
    expect(f.connect).toHaveBeenCalledTimes(1);
    const params = (f.connect.mock.calls[0] as unknown as [{ params: Record<string, unknown> }])[0]
      .params;
    expect(params.deviceSid).toBe("sid-9");
    expect(params.passHash).toBe("hash-abcdefghijklmnop");
    expect(f.onView).not.toHaveBeenCalledWith(
      expect.objectContaining({
        failure: expect.objectContaining({ reason: "wecom-app-required" }),
      }),
    );
  });
});

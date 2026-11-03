import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRemoteControlEntry } from "#src/web-remote-control/index.js";
import { saveEnterpriseAuthToken } from "#src/web-remote-control/app/enterpriseAuth.js";

const BACKEND = "https://backend.example.test";
const ORG = "tenant-1";
const ENTRY_HREF = `https://aihub.example.test/remote/v4?backend=uwork&org=${ORG}&enterprise_auth=${encodeURIComponent(BACKEND)}`;
const WE_COM_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 wxwork/4.1.26 MicroMessenger/7.0.1";

function setup(href: string, userAgent: string) {
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
          devices: [{ deviceSid: "sid-1", deviceMid: "mid-1", name: "办公室 Mac", platform: "darwin" }],
        });
      }
      if (path.endsWith("/remote-devices/sid-1/pairings"))
        return json({ id: "pair-1", expiresAt: Date.now() + 60_000 }, 201);
      if (path.endsWith("/remote-devices/sid-1/pairings/pair-1"))
        return json({
          status: "answered",
          pairing: { sid: "sid-1", hash: "hash-abcdefghijklmnop", org: ORG, enterpriseAuth: BACKEND },
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
      expect.objectContaining({ failure: expect.objectContaining({ reason: "wecom-app-required" }) }),
    );
  });
});

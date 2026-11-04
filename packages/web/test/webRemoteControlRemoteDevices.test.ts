import { describe, expect, it, vi } from "vitest";
import {
  fetchRemoteDevices,
  requestRemotePairing,
  toRelayDeviceView,
  waitRemotePairing,
} from "#src/web-remote-control/app/remoteDevices.js";

const context = { apiBaseUrl: "https://backend.example.test", orgId: "tenant-1" };

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("remote device catalogue", () => {
  it("reads the member's own devices with the session token", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        devices: [
          { deviceSid: "sid-1", deviceMid: "mid-1", name: "办公室 Mac", platform: "darwin" },
          { deviceSid: "", deviceMid: "mid-x" },
        ],
      }),
    );
    const devices = await fetchRemoteDevices({
      context,
      token: "session-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(devices).toEqual([
      { deviceSid: "sid-1", deviceMid: "mid-1", name: "办公室 Mac", platform: "darwin" },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://backend.example.test/api/client/remote-devices");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer session-1");
  });

  it("后台回 503（上游抖动）时自动重试，不把用户丢到错误页", async () => {
    // 前两次 503、第三次成功
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) return json({ error: { code: "PIVOT_UNAVAILABLE" } }, 503);
      return json({ devices: [{ deviceSid: "sid-1", deviceMid: "mid-1", name: "办公室 Mac" }] });
    });
    const devices = await fetchRemoteDevices({
      context,
      token: "session-1",
      fetchImpl: flaky as unknown as typeof fetch,
      retryDelayMs: () => 0,
    });
    expect(devices).toEqual([{ deviceSid: "sid-1", deviceMid: "mid-1", name: "办公室 Mac" }]);
    expect(flaky).toHaveBeenCalledTimes(3);
  });

  it("令牌无效（401）不重试，立即失败交给上层重新登录", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { code: "UNAUTHORIZED" } }, 401));
    await expect(
      fetchRemoteDevices({
        context,
        token: "stale",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryDelayMs: () => 0,
      }),
    ).rejects.toThrow("remote devices 401");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("重试也用尽后抛出最后一次的状态（不静默吞掉）", async () => {
    const fetchImpl = vi.fn(async () => json({ error: { code: "PIVOT_UNAVAILABLE" } }, 503));
    await expect(
      fetchRemoteDevices({
        context,
        token: "t",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        retryDelayMs: () => 0,
      }),
    ).rejects.toThrow("remote devices 503");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("maps a catalogue entry into the existing relay device view", () => {
    const view = toRelayDeviceView({
      deviceSid: "sid-1",
      deviceMid: "mid-1",
      name: "办公室 Mac",
      platform: "darwin",
    });
    expect(view.device_sid).toBe("sid-1");
    expect(view.online).toBe(true);
    expect(view.meta).toEqual({ name: "办公室 Mac", platform: "darwin" });
  });

  it("creates a pairing request and returns one-off material once answered", async () => {
    const fetchImpl = vi.fn(async (url: URL) => {
      if (String(url).endsWith("/pairings"))
        return json({ id: "pair-1", expiresAt: Date.now() + 60_000 }, 201);
      return json({
        status: "answered",
        pairing: {
          sid: "sid-1",
          hash: "hash-abcdefghijklmnop",
          org: "tenant-1",
          enterpriseAuth: "https://backend.example.test",
        },
      });
    });
    const pairing = await requestRemotePairing({
      context,
      token: "session-1",
      deviceSid: "sid-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(pairing.id).toBe("pair-1");
    const material = await waitRemotePairing({
      context,
      token: "session-1",
      deviceSid: "sid-1",
      pairingId: pairing.id,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(material).toEqual({
      sid: "sid-1",
      hash: "hash-abcdefghijklmnop",
      org: "tenant-1",
      enterpriseAuth: "https://backend.example.test",
    });
  });

  it("treats expired and unanswered requests as no material", async () => {
    const expired = vi.fn(async () => json({ status: "expired" }));
    expect(
      await waitRemotePairing({
        context,
        token: "session-1",
        deviceSid: "sid-1",
        pairingId: "pair-1",
        fetchImpl: expired as unknown as typeof fetch,
      }),
    ).toBeNull();
    // 一直 pending 到超过等待上限：用注入的 now/sleep 快速推进。
    const pending = vi.fn(async () => json({ status: "pending" }));
    let current = 0;
    expect(
      await waitRemotePairing({
        context,
        token: "session-1",
        deviceSid: "sid-1",
        pairingId: "pair-1",
        fetchImpl: pending as unknown as typeof fetch,
        now: () => (current += 60_000),
        sleep: async () => {},
      }),
    ).toBeNull();
    expect(pending.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

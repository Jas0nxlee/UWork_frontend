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

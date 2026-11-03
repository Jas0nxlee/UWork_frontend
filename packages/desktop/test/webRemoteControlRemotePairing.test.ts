import { describe, expect, it, vi } from "vitest";
import { startRemotePairingChannel } from "#src/main/webRemoteControlRemotePairing.js";

const base = {
  apiBaseUrl: "https://backend.example.test",
  token: "session-1",
  deviceSid: "sid-1",
  deviceMid: "mid-1",
  deviceName: "办公室 Mac",
  platform: "darwin",
  readPassHash: () => "hash-abcdefghijklmnop",
  logger: { info: vi.fn(), warn: vi.fn() },
  heartbeatMs: 60_000,
  pollWaitSeconds: 0,
} as const;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const ok = () => json({ ok: true });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("remote pairing channel (desktop)", () => {
  it("registers the device, answers one pairing with the run's pass hash, and unregisters on dispose", async () => {
    let nextCalls = 0;
    const fetchImpl = vi.fn(async (url: URL, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "PUT") return ok();
      if (init?.method === "DELETE") return ok();
      if (path.includes("/remote-pairings/next")) {
        nextCalls += 1;
        if (nextCalls === 1) return json({ pairing: { id: "pair-1", deviceSid: "sid-1" } });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return json({ pairing: null });
      }
      if (path.includes("/remote-pairings/pair-1/answer")) return ok();
      throw new Error(`unexpected ${init?.method} ${path}`);
    });
    const controller = new AbortController();
    const channel = startRemotePairingChannel({
      ...base,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    await vi.waitFor(() =>
      expect(
        fetchImpl.mock.calls.some(([url]) => String(url).includes("/remote-pairings/pair-1/answer")),
      ).toBe(true),
    );
    const answerCall = fetchImpl.mock.calls.find(([url]) =>
      String(url).includes("/remote-pairings/pair-1/answer"),
    );
    expect(answerCall?.[1]?.body).toBe(JSON.stringify({ sid: "sid-1", hash: "hash-abcdefghijklmnop" }));
    const registerCall = fetchImpl.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(String(registerCall?.[0])).toBe("https://backend.example.test/api/client/remote-devices/sid-1");
    expect(JSON.parse(String(registerCall?.[1]?.body))).toMatchObject({
      deviceMid: "mid-1",
      name: "办公室 Mac",
      platform: "darwin",
    });

    await channel.dispose();
    await flush();
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("never answers when the run has no pass hash material", async () => {
    let nextCalls = 0;
    const fetchImpl = vi.fn(async (url: URL, init?: RequestInit) => {
      if (init?.method === "PUT" || init?.method === "DELETE") return ok();
      if (String(url).includes("/remote-pairings/next")) {
        nextCalls += 1;
        if (nextCalls === 1) return json({ pairing: { id: "pair-1", deviceSid: "sid-1" } });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return json({ pairing: null });
      }
      throw new Error("should not answer without material");
    });
    const controller = new AbortController();
    const channel = startRemotePairingChannel({
      ...base,
      readPassHash: () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(nextCalls).toBeGreaterThanOrEqual(1));
    await flush();
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/answer"))).toBe(false);
    await channel.dispose();
  });
});

import { describe, expect, it, vi } from "vitest";
import { BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID } from "@zcode/shared";
import { createOAuthService } from "#src/oauth/oauthService.js";

function fixture() {
  const store = new Map([
    ["oauth:active_provider", "bigmodel"],
    ["oauth:bigmodel:access_token", "historical-token"],
    ["oauth:login_attribution", "historical-attribution"],
    ["personal-provider:demo:api-key", "current-api-key"],
  ]);
  const before = [...store];
  const credentials = {
    load: vi.fn(async (key: string) => store.get(key) ?? null),
    save: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  const request = vi.fn<typeof fetch>(async () => {
    throw new Error("unexpected network");
  });
  const service = createOAuthService(credentials, { apiClient: { request } });
  const changed = vi.fn();
  service.onDidChangeSession(changed);
  return {
    service,
    changed,
    assertUntouched() {
      expect([...store]).toEqual(before);
      expect(credentials.load).not.toHaveBeenCalled();
      expect(credentials.save).not.toHaveBeenCalled();
      expect(credentials.delete).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  };
}

const callbacks = [
  "zcode://oauth/callback?state=old&code=old&channel_id=desktop&utm_source=site",
  "zcode://oauth/callback?state=new&authCode=new&utm_campaign=launch",
  "zcode://oauth/callback?state=wrong&error=access_denied",
];

// 旧 callback/poll 的成功仲裁已退役：并发入口不得产生任何 winner、账号写入或 attribution。
// 直接等待可完成的 RPC，避免旧 deferred 先决条件永远不触发导致超时和未处理拒绝。
describe("retired OAuth concurrent completion boundary", () => {
  it.each(["callback", "poll"] as const)(
    "%s arrives first: both routes remain inactive including duplicate callbacks",
    async (first) => {
      const f = fixture();
      const operations =
        first === "callback"
          ? [f.service.handleCallback(callbacks[0]), f.service.pollPendingOAuth()]
          : [f.service.pollPendingOAuth(), f.service.handleCallback(callbacks[0])];
      operations.push(...callbacks.map((url) => f.service.handleCallback(url)));
      expect(await Promise.all(operations)).toEqual([null, null, null, null, null]);
      expect(f.changed).not.toHaveBeenCalled();
      f.assertUntouched();
    },
  );

  it.each([undefined, BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID])(
    "cancel(%s) races with callbacks and polls without clearing credentials",
    async (provider) => {
      const f = fixture();
      await Promise.all([
        f.service.cancelPending(provider),
        ...callbacks.map((url) => f.service.handleCallback(url)),
        f.service.pollPendingOAuth(),
      ]);
      await expect(f.service.handleCallback(callbacks[0])).resolves.toBeNull();
      await expect(f.service.pollPendingOAuth()).resolves.toBeNull();
      expect(f.changed).not.toHaveBeenCalled();
      f.assertUntouched();
    },
  );

  it.each([BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID])(
    "%s repeated login/refresh rejection cannot race a callback into a session",
    async (provider) => {
      const f = fixture();
      // 拒绝必须在创建 promise 的同一轮接住，不能为复现旧刷新时序制造 unhandled rejection。
      const outcomes = await Promise.allSettled([
        f.service.startOAuth(provider),
        f.service.startOAuthWithPolling(provider),
        f.service.refreshToken(provider),
        f.service.startOAuthWithPolling(provider),
        f.service.handleCallback(callbacks[0]),
        f.service.pollPendingOAuth(),
      ]);
      for (const outcome of outcomes.slice(0, 4)) {
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({ message: expect.stringContaining("应用登录已移除") }),
        });
      }
      expect(outcomes.slice(4)).toEqual([
        { status: "fulfilled", value: null },
        { status: "fulfilled", value: null },
      ]);
      await expect(f.service.restoreCachedSessionState()).resolves.toEqual({
        status: "signed-out",
      });
      expect(f.changed).not.toHaveBeenCalled();
      f.assertUntouched();
    },
  );

  it.each(["logout", "logoutAll"] as const)(
    "%s while callbacks and poll race emits signed-out without accepting late results",
    async (operation) => {
      const f = fixture();
      await Promise.all([
        f.service.handleCallback(callbacks[0]),
        f.service[operation](),
        f.service.pollPendingOAuth(),
        f.service.handleCallback(callbacks[1]),
      ]);
      expect(f.changed.mock.calls).toEqual([["signed-out"]]);
      await expect(f.service.restoreSession()).resolves.toBeNull();
      f.assertUntouched();
    },
  );
});

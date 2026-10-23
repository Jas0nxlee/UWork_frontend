import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID, type ApiClient } from "@zcode/shared";
import { createOAuthService, OAuthService } from "../src/oauth/oauthService.js";
import { OAuthCredentialRepo } from "../src/oauth/repo/oauthCredentialRepo.js";
import { ZaiProviderAdapter } from "../src/oauth/providers/zaiProviderAdapter.js";
import { ZAI_OAUTH_PROVIDER_CONFIG } from "../src/oauth/providers/zaiProviderConfig.js";

const providers = [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID] as const;

function fixture() {
  const store = new Map([
    ["oauth:active_provider", "bigmodel"],
    ["oauth:bigmodel:access_token", "historical-token"],
    ["oauth:zai:access_token", "historical-zai-token"],
    ["zcodejwttoken", "historical-jwt"],
    ["personal-provider:demo:api-key", "current-api-key"],
  ]);
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
  const onProviderLogout = vi.fn(async () => {});
  const service = createOAuthService(credentials, { apiClient: { request }, onProviderLogout });
  const before = [...store];
  const expectNoAccountEffects = () => {
    expect([...store]).toEqual(before);
    expect(credentials.load).not.toHaveBeenCalled();
    expect(credentials.save).not.toHaveBeenCalled();
    expect(credentials.delete).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(onProviderLogout).not.toHaveBeenCalled();
  };
  return { service, credentials, store, expectNoAccountEffects };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// 应用 OAuth 成功登录/刷新/迁移/过期清理已退役；旧用例不能要求重新消费磁盘账号。
// 用同一 RPC 的拒绝、signed-out、零网络和零凭据副作用覆盖当前兼容安全边界。
describe("OAuth RPC retirement contract", () => {
  it("can be constructed without API transport and never publishes a login provider", async () => {
    const service = new OAuthService();
    await expect(service.getProviders()).resolves.toEqual([]);
    await expect(service.getActiveProvider()).resolves.toBeNull();
  });

  it.each(["current", "expired", "legacy", "malformed", "decrypt-error", "io-error"])(
    "%s historical credentials cannot restore or migrate an account",
    async (state) => {
      const f = fixture();
      if (state.endsWith("error")) {
        f.credentials.load.mockRejectedValue(new Error(state));
      } else {
        f.credentials.load.mockResolvedValue(state);
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(f.service.restoreCachedSession()).resolves.toBeNull();
        await expect(f.service.restoreCachedSessionState()).resolves.toEqual({
          status: "signed-out",
        });
        await expect(f.service.restoreSession()).resolves.toBeNull();
        await expect(f.service.getActiveProvider()).resolves.toBeNull();
        await expect(f.service.getProviders()).resolves.toEqual([]);
      }
      f.expectNoAccountEffects();
    },
  );

  it.each(providers)(
    "%s login, polling login and refresh explicitly reject on every retry",
    async (provider) => {
      const f = fixture();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(f.service.startOAuth(provider)).rejects.toThrow("应用登录已移除");
        await expect(f.service.startOAuthWithPolling(provider)).rejects.toThrow("应用登录已移除");
        await expect(f.service.refreshToken(provider)).rejects.toThrow("不再刷新账号凭据");
      }
      await expect(f.service.refreshToken()).rejects.toThrow("不再刷新账号凭据");
      f.expectNoAccountEffects();
    },
  );

  it.each([
    "zcode://oauth/callback?code=historical-code&state=old",
    "zcode://oauth/callback?authCode=old&state=old&channel_id=campaign",
    "zcode://oauth/callback?error=access_denied&state=old",
    "zcode://oauth/callback?token=expired&provider=zai",
    "not a callback URL",
  ])("ignores legacy callback without accepting code, token or attribution: %s", async (url) => {
    const f = fixture();
    await expect(f.service.handleCallback(url)).resolves.toBeNull();
    await expect(f.service.handleCallback(url)).resolves.toBeNull();
    await expect(f.service.pollPendingOAuth()).resolves.toBeNull();
    f.expectNoAccountEffects();
  });

  it.each([undefined, ...providers])(
    "logout(%s) broadcasts signed-out only and keeps custom API keys",
    async (provider) => {
      const f = fixture();
      const changed = vi.fn();
      const listener = f.service.onDidChangeSession(changed);
      await f.service.logout(provider);
      await f.service.logout(provider);
      await f.service.logoutAll();
      expect(changed.mock.calls).toEqual([["signed-out"], ["signed-out"], ["signed-out"]]);
      listener.dispose();
      await f.service.logoutAll();
      expect(changed).toHaveBeenCalledTimes(3);
      f.expectNoAccountEffects();
    },
  );

  it("cached repository reads also fail closed without decrypting historical accounts", async () => {
    const f = fixture();
    const repo = new OAuthCredentialRepo(f.credentials);
    await expect(repo.getActiveProvider()).resolves.toBeNull();
    await expect(repo.loadActiveTokenSet()).resolves.toBeNull();
    await expect(repo.loadActiveUserProfile()).resolves.toBeNull();
    for (const provider of providers) {
      await expect(repo.loadTokenSet(provider)).resolves.toBeNull();
      await expect(repo.loadUserProfile(provider)).resolves.toBeNull();
    }
    f.expectNoAccountEffects();
  });

  it("retains the repository's legacy attribution decoding contract without restoring login", async () => {
    const f = fixture();
    f.store.set(
      "oauth:login_attribution",
      JSON.stringify({
        params: { channel_id: "migrated-channel", utm_campaign: "launch" },
        expiresAt: 1,
      }),
    );
    const repo = new OAuthCredentialRepo(f.credentials);
    await expect(repo.loadLoginAttribution()).resolves.toEqual({
      channel_id: "migrated-channel",
      utm_campaign: "launch",
    });
    expect(f.credentials.save).not.toHaveBeenCalled();
    expect(f.credentials.delete).not.toHaveBeenCalled();
  });
});

function createMockApiClient(mockFetch: typeof fetch): ApiClient {
  return { request: mockFetch };
}
function createZaiBusinessLoginResponse(accessToken = "zai_business_access_token"): Response {
  return Response.json({
    code: 200,
    success: true,
    data: { access_token: accessToken, expires_in: 3600 },
  });
}

// 分享页仍保留独立认证适配器；保留 expiresAt、脱敏与错误响应的有效单元覆盖。
describe("retained OAuth adapter contract", () => {
  it("maps zai backend expires_in into OAuthTokenSet expiresAt", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );
    const now = 1_800_000_000_000;

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {
              access_token: "zai_oauth_access_token",
            },
            expires_in: 86400,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await expect(
      adapter.exchangeToken(
        { code: "zai-code-001", state: "state-001" },
        {
          providerId: ZAI_PROVIDER_ID,
          state: "state-001",
          redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
          now: () => now,
        },
      ),
    ).resolves.toEqual({
      accessToken: "zai_business_access_token",
      zcodeJwtToken: "zcode_backend_jwt",
      expiresAt: now + 86400 * 1000,
    });
  });

  it("logs zai backend token request without exposing full oauth code", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );
    const fullCode = "abcdefghijklmnopqrstuvwxyz";

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: "zcode_backend_jwt",
            zai: {
              access_token: "zai_oauth_access_token",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await adapter.exchangeToken(
      { code: fullCode, state: "state-001" },
      {
        providerId: ZAI_PROVIDER_ID,
        state: "state-001",
        redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
        now: () => 1_800_000_000_000,
      },
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[zaiOAuth]"),
      "token request",
      {
        method: "POST",
        url: ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
        headers: { "Content-Type": "application/json" },
        body: {
          provider: ZAI_PROVIDER_ID,
          code: "abcd...wxyz",
          codeLength: 26,
          redirect_uri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
          state: "state-001",
        },
      },
    );
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(fullCode);
  });

  it("logs zai final token response body without exposing full token", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );
    const fullToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock-signature";
    const fullZaiAccessToken = "zai_oauth_access_token_should_not_leak";

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "",
          data: {
            token: fullToken,
            zai: {
              access_token: fullZaiAccessToken,
            },
            expires_in: 86400,
            user: {
              user_id: "u_xxxxx",
              email: "user@example.com",
              avatar: "https://example.com/avatar.png",
              created_at: "2026-04-27T10:00:00Z",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    fetchMock.mockResolvedValueOnce(createZaiBusinessLoginResponse());

    await adapter.exchangeToken(
      { code: "zai-code-001", state: "state-001" },
      {
        providerId: ZAI_PROVIDER_ID,
        state: "state-001",
        redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
        now: () => 1_800_000_000_000,
      },
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[zaiOAuth]"),
      "token final response body",
      {
        code: 0,
        msg: "",
        data: {
          token: "eyJh...ture",
          tokenLength: fullToken.length,
          zai: {
            access_token: "zai_...leak",
            accessTokenLength: fullZaiAccessToken.length,
          },
          expires_in: 86400,
          user: {
            user_id: "u_xxxxx",
            email: "user@example.com",
            avatar: "https://example.com/avatar.png",
            created_at: "2026-04-27T10:00:00Z",
          },
        },
      },
    );
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(fullToken);
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain(fullZaiAccessToken);
  });

  it("logs zai token response request id on backend error", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ZaiProviderAdapter(
      {
        ...ZAI_OAUTH_PROVIDER_CONFIG,
        enabled: true,
      },
      createMockApiClient(fetchMock),
    );

    fetchMock.mockResolvedValueOnce(
      new Response("404 page not found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain",
          "set-cookie": "visitor_id=secret",
          "x-request-id": "req-404",
          "x-span-id": "span-404",
          "x-trace-id": "trace-404",
        },
      }),
    );

    await expect(
      adapter.exchangeToken(
        { code: "authorization-code", state: "state-404" },
        {
          providerId: ZAI_PROVIDER_ID,
          state: "state-404",
          redirectUri: ZAI_OAUTH_PROVIDER_CONFIG.redirectUri,
          now: () => 1_800_000_000_000,
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: "ApiError",
        method: "POST",
        status: 404,
        url: ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
      }),
    );

    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining("[zaiOAuth]"),
      "token response error",
      {
        method: "POST",
        url: ZAI_OAUTH_PROVIDER_CONFIG.tokenUrl,
        status: 404,
        responseHeaders: {
          "x-request-id": "req-404",
          "x-span-id": "span-404",
          "x-trace-id": "trace-404",
        },
      },
    );
    expect(JSON.stringify(consoleLogSpy.mock.calls)).not.toContain("visitor_id=secret");
  });
});

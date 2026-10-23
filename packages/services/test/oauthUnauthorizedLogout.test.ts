import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCredentialService } from "#src/credential/credentialService.js";
import { createOAuthService } from "#src/oauth/oauthService.js";
import {
  isCurrentOAuthCredentialRequest,
  isOAuthBusinessRequest,
  resolveOAuthBusinessCredentialValidationRequest,
} from "#src/oauth/oauthUnauthorizedRequest.js";
import { getAppConfigDir, setDataBaseDir } from "#src/paths.js";
import { createNodeApiClient } from "#src/providers/api/nodeApiClient.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "uwork-retired-oauth-401-"));
  setDataBaseDir(root);
});
afterEach(async () => {
  setDataBaseDir(null);
  await rm(root, { recursive: true, force: true });
});

async function fixture(provider: "bigmodel" | "zai") {
  const credentials = createCredentialService();
  await credentials.save("oauth:active_provider", provider);
  await credentials.save(`oauth:${provider}:access_token`, "historical-token");
  await credentials.save("zcodejwttoken", "historical-jwt");
  await credentials.save("personal-provider:demo:api-key", "current-api-key");
  const onProviderLogout = vi.fn(async () => {});
  const service = createOAuthService(credentials, { onProviderLogout });
  const changed = vi.fn();
  service.onDidChangeSession(changed);
  const file = join(getAppConfigDir(), "credentials.json");
  const before = await readFile(file, "utf8");
  const env = { ZCODE_ENV: "production" };
  return { credentials, service, changed, onProviderLogout, file, before, env };
}

// 旧业务401只读分类器仍被独立分享认证复用；应用路径必须使用真实凭据隔离，
// 不能用可读 oauth:* 的 Map 替身要求退役 OAuthService 清除或刷新账号。
describe("retired account HTTP 401 boundary", () => {
  it.each(["bigmodel", "zai"] as const)(
    "%s historical token/JWT and custom API key are never classified as current account credentials",
    async (provider) => {
      const f = await fixture(provider);
      for (const authorization of [
        "historical-token",
        "Bearer historical-token",
        "Bearer historical-jwt",
        "Bearer current-api-key",
      ]) {
        const options = {
          input:
            provider === "zai"
              ? "https://api.z.ai/api/biz/customer/getCustomerInfo"
              : "https://bigmodel.cn/api/biz/customer/getCustomerInfo",
          headers: new Headers({ Authorization: authorization }),
          credentialService: f.credentials,
          env: f.env,
        };
        await expect(isCurrentOAuthCredentialRequest(options)).resolves.toBe(false);
        await expect(isOAuthBusinessRequest(options)).resolves.toBe(false);
        await expect(resolveOAuthBusinessCredentialValidationRequest(options)).resolves.toBeNull();
        await expect(
          f.service.logoutIfCurrentCredentialRequest(options.input, options.headers),
        ).resolves.toBe(false);
      }
      expect(await readFile(f.file, "utf8")).toBe(f.before);
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.onProviderLogout).not.toHaveBeenCalled();
    },
  );

  it.each(
    ["bigmodel", "zai"].flatMap((provider) =>
      [200, 401, 403].map((status) => [provider as "bigmodel" | "zai", status] as const),
    ),
  )(
    "%s HTTP %i cannot trigger a secondary account validation request or delete credentials",
    async (provider, status) => {
      const f = await fixture(provider);
      const url =
        provider === "zai"
          ? "https://api.z.ai/api/biz/subscription/enterprise/v2/pricing"
          : "https://bigmodel.cn/api/biz/subscription/enterprise/v2/pricing";
      const invalidated = vi.fn();
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json({ code: 401, success: false }, { status }),
      );
      const client = createNodeApiClient({
        fetchImpl,
        isZcodeJwtRequest: (input, headers) =>
          isCurrentOAuthCredentialRequest({
            input,
            headers,
            credentialService: f.credentials,
            env: f.env,
          }),
        isBusinessUnauthorizedRequest: (input) =>
          isOAuthBusinessRequest({ input, credentialService: f.credentials, env: f.env }),
        resolveBusinessCredentialValidationRequest: (input, headers) =>
          resolveOAuthBusinessCredentialValidationRequest({
            input,
            headers,
            credentialService: f.credentials,
            env: f.env,
          }),
        onZcodeJwtInvalid: invalidated,
      });
      const responses = await Promise.all(
        Array.from({ length: 3 }, () =>
          client.request(url, { headers: { Authorization: "Bearer historical-token" } }),
        ),
      );
      for (const response of responses) expect(response.status).toBe(status);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(fetchImpl.mock.calls.every(([input]) => String(input) === url)).toBe(true);
      expect(invalidated).not.toHaveBeenCalled();
      expect(f.changed).not.toHaveBeenCalled();
      expect(f.onProviderLogout).not.toHaveBeenCalled();
      expect(await f.credentials.load("personal-provider:demo:api-key")).toBe("current-api-key");
      expect(await readFile(f.file, "utf8")).toBe(f.before);
    },
  );

  it("stale 401 and retired login retries cannot erase a replacement custom API key", async () => {
    const f = await fixture("bigmodel");
    const key = "personal-provider:demo:api-key";
    await f.credentials.save(key, "replacement-api-key");
    const before = await readFile(f.file, "utf8");
    await Promise.all([
      expect(f.service.refreshToken()).rejects.toThrow("应用登录已移除"),
      expect(f.service.startOAuthWithPolling("bigmodel")).rejects.toThrow("应用登录已移除"),
      expect(
        f.service.logoutIfCurrentCredentialRequest(
          "https://bigmodel.cn/api/biz/customer/getCustomerInfo",
          new Headers({ Authorization: "Bearer historical-token" }),
        ),
      ).resolves.toBe(false),
      f.service.cancelPending(),
    ]);
    await f.service.logout();
    expect(f.changed.mock.calls).toEqual([["signed-out"]]);
    expect(await f.credentials.load(key)).toBe("replacement-api-key");
    expect(await readFile(f.file, "utf8")).toBe(before);
    expect(f.onProviderLogout).not.toHaveBeenCalled();
  });
});

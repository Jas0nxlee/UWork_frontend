import { describe, expect, it, vi } from "vitest";
import {
  clearEnterpriseAuthToken,
  exchangeEnterpriseAuthCode,
  readEnterpriseAuthToken,
  resolveEnterpriseAuthorizeUrl,
  saveEnterpriseAuthToken,
} from "../src/web-remote-control/app/enterpriseAuth.js";

const context = { apiBaseUrl: "https://pivot.example.com", orgId: "org-a" };

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("手机页企业身份准入", () => {
  it("授权链接带 org_id 与回到本页的 redirect_uri", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ url: "https://open.weixin.qq.com/connect/oauth2/authorize?x=1" }),
    })) as unknown as typeof fetch;
    const url = await resolveEnterpriseAuthorizeUrl({
      context,
      returnTo: "https://aihub.example.com/remote/v4?sid=s1&hash=h1&t=1",
      fetchImpl,
    });
    expect(url).toContain("open.weixin.qq.com");
    const called = String(
      (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0],
    );
    expect(called).toContain("/api/auth/authorize");
    expect(called).toContain("org_id=org-a");
    expect(called).toContain(
      `redirect_uri=${encodeURIComponent(
        "https://aihub.example.com/remote/v4?sid=s1&hash=h1&t=1",
      )}`,
    );
  });

  it("授权端点不返回 url 时抛错，调用方据此进入失败态", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      resolveEnterpriseAuthorizeUrl({ context, returnTo: "https://p.example.com/x", fetchImpl }),
    ).rejects.toThrow("authorize url missing");
  });

  it("用回调 code 换 JWT 时把 org_id 一起带上（多组织必须显式指定）", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ token: "jwt-1" }),
    })) as unknown as typeof fetch;
    const token = await exchangeEnterpriseAuthCode({ context, code: "code-1", fetchImpl });
    expect(token).toBe("jwt-1");
    const [calledUrl, init] = (
      fetchImpl as unknown as { mock: { calls: Array<[unknown, RequestInit]> } }
    ).mock.calls[0];
    expect(String(calledUrl)).toContain("/api/auth/login");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ code: "code-1", org_id: "org-a" });
  });

  it("换 token 失败（未返回 token）时抛错，不把空串当身份", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      exchangeEnterpriseAuthCode({ context, code: "code-1", fetchImpl }),
    ).rejects.toThrow("token missing");
  });

  it("token 按「基址 + 组织」隔离存放，且可清除", () => {
    const storage = memoryStorage();
    saveEnterpriseAuthToken(storage, context, "jwt-1");
    expect(readEnterpriseAuthToken(storage, context)).toBe("jwt-1");
    expect(readEnterpriseAuthToken(storage, { ...context, orgId: "org-b" })).toBeNull();
    expect(
      readEnterpriseAuthToken(storage, { ...context, apiBaseUrl: "https://other.example.com" }),
    ).toBeNull();
    clearEnterpriseAuthToken(storage, context);
    expect(readEnterpriseAuthToken(storage, context)).toBeNull();
  });

  it("storage 抛错不影响连接（读不到就当作未登录）", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readEnterpriseAuthToken(storage, context)).toBeNull();
    expect(() => saveEnterpriseAuthToken(storage, context, "jwt-1")).not.toThrow();
  });
});

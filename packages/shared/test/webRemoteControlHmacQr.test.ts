import { describe, expect, it } from "vitest";
import * as shared from "@zcode/shared";

describe("UWork 自建 HMAC QR 与官方 V2 信任隔离", () => {
  it("保留完整 HMAC 配对材料，同时官方 parser 继续拒绝此链接", () => {
    const url = new URL(
      shared.buildWebRemoteControlHmacQrUrl({
        baseUrl: "https://relay.example/remote/v4",
        deviceSid: "device-hmac",
        passHash: "test-hash",
        timestamp: 123,
        deviceMid: "desktop-mid",
        deviceName: "UWork",
        appVersion: "3.16.6",
      }),
    );
    expect(shared.parseWebRemoteControlHmacQrParams(url.searchParams)).toEqual({
      deviceSid: "device-hmac",
      passHash: "test-hash",
      timestamp: 123,
      deviceMid: "desktop-mid",
      deviceName: "UWork",
      appVersion: "3.16.6",
    });
    expect(shared.parseWebRemoteControlExternalQrParams(url.searchParams)).toBeNull();
  });

  it.each([
    "sid=x",
    "sid=x&hash=y",
    "sid=x&hash=y&t=NaN",
    "sid=x&hash=y&t=-1",
    "sid=x&sid=y&hash=z&t=1",
  ])("HMAC admission 拒绝不完整或歧义配对材料：%s", (query) => {
    expect(shared.parseWebRemoteControlHmacQrParams(new URLSearchParams(query))).toBeNull();
  });
});

describe("企业身份准入（方案 A）的二维码参数", () => {
  it("org + enterprise_auth 成对出现时写入并可原样读回", () => {
    const url = new URL(
      shared.buildWebRemoteControlHmacQrUrl({
        baseUrl: "https://aihub.example.com/remote/v4",
        deviceSid: "device-1",
        passHash: "hash-1",
        timestamp: 42,
        enterpriseAuth: "https://pivot.example.com",
        enterpriseOrg: "org-a",
      }),
    );
    expect(url.searchParams.get("enterprise_auth")).toBe("https://pivot.example.com");
    expect(url.searchParams.get("org")).toBe("org-a");
    expect(shared.parseWebRemoteControlHmacQrParams(url.searchParams)).toMatchObject({
      enterpriseAuth: "https://pivot.example.com",
      enterpriseOrg: "org-a",
    });
  });

  it("半配置或非 https 的准入基址一律不写入（保持旧行为）", () => {
    const base = {
      baseUrl: "https://aihub.example.com/remote/v4",
      deviceSid: "device-1",
      passHash: "hash-1",
      timestamp: 42,
    };
    for (const extra of [
      { enterpriseAuth: "https://pivot.example.com" },
      { enterpriseOrg: "org-a" },
      { enterpriseAuth: "http://pivot.example.com", enterpriseOrg: "org-a" },
      { enterpriseAuth: "https://pivot.example.com/?x=1", enterpriseOrg: "org-a" },
    ]) {
      const url = new URL(shared.buildWebRemoteControlHmacQrUrl({ ...base, ...extra }));
      expect(url.searchParams.has("enterprise_auth")).toBe(false);
      expect(url.searchParams.has("org")).toBe(false);
    }
  });

  it("本机调试允许 http://localhost", () => {
    const url = new URL(
      shared.buildWebRemoteControlHmacQrUrl({
        baseUrl: "https://aihub.example.com/remote/v4",
        deviceSid: "device-1",
        passHash: "hash-1",
        timestamp: 42,
        enterpriseAuth: "http://localhost:3000",
        enterpriseOrg: "org-a",
      }),
    );
    expect(url.searchParams.get("enterprise_auth")).toBe("http://localhost:3000");
  });
});

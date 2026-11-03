import type { WebRemoteControlFailure, WebRemoteControlV2QrParams } from "@zcode/shared";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import type { WebOAuthProviderId } from "#src/auth/browserOAuthCredentialRepo.js";
import type { WebAuthService } from "#src/auth/webAuthService.js";

export interface WebRemoteControlDeviceGroup {
  deviceMid: string;
  name?: string;
  /** relay meta.platform（darwin / win32 / linux 等），离线时回退到本机记住的平台。 */
  platform?: string;
  onlineConnections: WebRemoteControlRelayV2Device[];
}

/** 本机见过的在线设备展示信息；name / platform 至少一项非空。 */
export interface KnownDevice {
  name?: string;
  platform?: string;
}

/** 设备页账号行的只读展示资料；不是登录事实，登录门禁仍以 JWT 为准。 */
export interface WebRemoteControlDeviceListAccount {
  displayName: string;
  avatarUrl?: string;
  provider: WebOAuthProviderId;
}

export type WebRemoteControlDeviceListView = {
  kind: "devices";
  devices: WebRemoteControlDeviceGroup[];
  loading: boolean;
  error: boolean;
  account?: WebRemoteControlDeviceListAccount;
};

export type WebRemoteControlEntryView =
  | { kind: "callback" | "login" | "scan" }
  /** 免扫码入口跳企微授权时的过渡页：直接跳走，不能落到 ZCode 官方登录页。 */
  | { kind: "authorizing" }
  | WebRemoteControlDeviceListView
  | { kind: "failure"; failure: WebRemoteControlFailure };

export interface WebRemoteControlEntryConnection {
  params: WebRemoteControlV2QrParams & {
    deviceSid: string;
    passHash?: string;
    /** 企业身份准入（方案 A）：只有 HMAC 通道的二维码会带这两个参数。 */
    enterpriseAuth?: string;
    enterpriseOrg?: string;
  };
  protocol?: "hmac-v1" | "oauth-v2";
  signal: AbortSignal;
  getToken(signal: AbortSignal): Promise<string>;
  onPaired(): void;
  onFailure(failure: WebRemoteControlFailure): void;
}

export interface WebRemoteControlEntryOptions {
  protocol?: "hmac-v1" | "oauth-v2";
  // 浏览器 location/history/storage 经现有边界注入，不另存一份登录事实。
  auth: Pick<WebAuthService, "getZCodeJwtToken" | "getActiveAccount" | "startLogin" | "logout">;
  getHref(): string;
  replaceHref(href: string): void;
  storage: Pick<Storage, "getItem" | "setItem">;
  /**
   * 仅本次标签页有效的会话存储：用来标记"这是连接之后的重载，需要接着连"。
   * 缺省时不做自动续连（每次都停在设备列表）。
   */
  sessionStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  locale: "zh-CN" | "en-US";
  /** 企微内置浏览器判定用；缺省读 navigator.userAgent（测试可注入）。 */
  userAgent?: string;
  /** 同源入口探测与配对请求可注入（测试用）。 */
  fetchImpl?: typeof fetch;
  devices(jwt: string, signal: AbortSignal): Promise<WebRemoteControlRelayV2Device[]>;
  subscribeVisible(listener: () => void): () => void;
  loginOptions?: Parameters<WebAuthService["startLogin"]>[0];
  token(jwt: string, signal: AbortSignal): Promise<string>;
  connect(connection: WebRemoteControlEntryConnection): void;
  onView(view: WebRemoteControlEntryView): void;
}

export type * from "#src/web-remote-control/contracts/transport.js";

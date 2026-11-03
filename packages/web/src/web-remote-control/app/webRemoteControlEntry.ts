import type {
  WebRemoteControlDeviceListView,
  WebRemoteControlEntryConnection,
  WebRemoteControlEntryOptions,
  WebRemoteControlDeviceGroup,
} from "#src/web-remote-control/contract.js";
import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import {
  parseWebRemoteControlHmacQrParams,
  parseWebRemoteControlExternalQrParams,
} from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import type { WebOAuthProviderId } from "#src/auth/browserOAuthCredentialRepo.js";
import { groupWebRemoteControlDevices } from "#src/web-remote-control/domain/webRemoteControlDeviceGroups.js";
import {
  readKnownDevices,
  rememberKnownDevices,
} from "#src/web-remote-control/app/webRemoteControlKnownDevices.js";
import {
  clearEnterpriseAuthToken,
  clearUworkWebAttempt,
  exchangeEnterpriseAuthCode,
  exchangeUworkWebCode,
  readEnterpriseAuthToken,
  readUworkWebAttempt,
  resolveEnterpriseAuthorizeUrl,
  saveEnterpriseAuthToken,
  saveUworkWebAttempt,
  startUworkWebAuthorize,
  type EnterpriseAuthContext,
} from "#src/web-remote-control/app/enterpriseAuth.js";
import {
  fetchRemoteDevices,
  readSameOriginBackend,
  requestRemotePairing,
  toRelayDeviceView,
  waitRemotePairing,
} from "#src/web-remote-control/app/remoteDevices.js";

export function isWebRemoteControlOAuthCallback(url: URL): boolean {
  return (
    ["/remote/v4", "/remote/v4/"].includes(url.pathname) &&
    url.searchParams.has("state") &&
    // BigModel 使用 authCode；必须先进入既有回调校验，不能落回未登录门禁。
    (url.searchParams.has("code") ||
      url.searchParams.has("authCode") ||
      url.searchParams.has("error"))
  );
}

const LAST_DEVICE_KEY = "zcode-web-remote-last-device-sid";
const LAST_DEVICE_MID_KEY = "zcode-web-remote-last-device-mid";

/**
 * 最近设备的自动落点：最近 SID 在线优先；否则同一台电脑（最近 MID）恰好一个在线 SID 时接上它。
 * 桌面重新注册会换 SID 并尽力删除旧 SID，因此最近 MID 缺失时只能从列表里旧 SID 的离线记录取。
 * 同 MID 多个在线 SID 时不猜测目标，交给用户在列表中选择。
 */
function resolveAutoConnectSid(
  records: readonly WebRemoteControlRelayV2Device[],
  groups: readonly WebRemoteControlDeviceGroup[],
  lastSid: string | null,
  lastMid: string | null,
): string | undefined {
  if (!lastSid && !lastMid) return undefined;
  const lastRecord = lastSid ? records.find((record) => record.device_sid === lastSid) : undefined;
  if (lastRecord?.online) return lastRecord.device_sid;
  const mid = lastMid || lastRecord?.device_mid;
  const connections = groups.find((group) => group.deviceMid === mid)?.onlineConnections ?? [];
  return connections.length === 1 ? connections[0]?.device_sid : undefined;
}

/** 只负责连接前的 admission；配对后的 workspace/恢复仍归既有 bootstrap。 */
export class WebRemoteControlEntry {
  private scope = new AbortController();
  /** 企微工作台入口（backend=uwork）时的企业上下文；存在即表示走免扫码设备目录。 */
  private remoteContext: EnterpriseAuthContext | undefined;
  private backend: "ucas" | "uwork" = "ucas";
  /** 本次入口解析出的企业后端基址与组织（同源入口时来自 web-config）。 */
  private entryAuthBase: string | undefined;
  private entryOrgId: string | undefined;
  private list:
    | {
        view: WebRemoteControlDeviceListView;
        unsubscribe: () => void;
        request?: Promise<void>;
        lastSid: string | null;
        lastMid: string | null;
        acceptedJwt?: string;
      }
    | undefined;

  constructor(private readonly options: WebRemoteControlEntryOptions) {}

  dispose(): void {
    this.scope.abort();
    this.list?.unsubscribe();
    this.list = undefined;
  }

  private reset(): void {
    this.dispose();
    this.remoteContext = undefined;
    this.entryAuthBase = undefined;
    this.entryOrgId = undefined;
    this.scope = new AbortController();
  }

  /** 企微内置浏览器判定：UA 带 wxwork；本机回环放行以便开发与自动化。 */
  private isWeComAppBrowser(): boolean {
    const userAgent =
      this.options.userAgent ??
      (typeof navigator === "undefined" ? "" : navigator.userAgent);
    if (userAgent.toLowerCase().includes("wxwork")) return true;
    try {
      const host = new URL(this.options.getHref()).hostname;
      return ["localhost", "127.0.0.1", "[::1]"].includes(host);
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    this.reset();
    const url = new URL(this.options.getHref());
    const hasPairingParams = ["sid", "hash", "t"].some((key) => url.searchParams.has(key));
    if (this.options.protocol === "hmac-v1") {
      const explicitBackend = url.searchParams.get("backend");
      let backend: "ucas" | "uwork" | undefined =
        explicitBackend === "uwork" ? "uwork" : explicitBackend ? "ucas" : undefined;
      let authBase = url.searchParams.get("enterprise_auth") ?? undefined;
      let orgId = url.searchParams.get("org") ?? undefined;
      // backend=uwork 且后台配置了 pivot 时，手机页登录走 pivot（与桌面同一套身份）。
      let pivotLoginBase: string | undefined;
      // 同源入口（企微工作台）：页面与后台同源，组织与后端形态由 Host 解析，
      // 企微应用主页只需要一个干净的 /remote/v4（照 ucas-proxy 的口径）。
      if (!authBase && !hasPairingParams) {
        const sameOrigin = await readSameOriginBackend({
          origin: url.origin,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        });
        if (sameOrigin) {
          backend = "uwork";
          authBase = url.origin;
          orgId = sameOrigin.tenantId;
          pivotLoginBase = sameOrigin.pivotApiBaseUrl;
        }
      }
      this.backend = backend ?? "ucas";
      this.entryAuthBase = authBase;
      this.entryOrgId = orgId;
      // 只允许从企业微信工作台进入的入口（backend=uwork）：普通浏览器直接拒绝。
      if (this.backend === "uwork" && !this.isWeComAppBrowser()) {
        this.options.onView({ kind: "failure", failure: { reason: "wecom-app-required" } });
        return;
      }
      if (!hasPairingParams) {
        // 免扫码通路：同源入口或显式 org + enterprise_auth 时先登录，再看"我的设备"。
        if (this.backend === "uwork" && authBase && orgId) {
          const context: EnterpriseAuthContext = {
            apiBaseUrl: authBase,
            orgId,
            ...(pivotLoginBase
              ? { login: { apiBaseUrl: pivotLoginBase, orgId: "" } }
              : {}),
          };
          const authorized = await this.ensureEnterpriseIdentity(context, url, "uwork");
          if (!authorized) return;
          await this.openRemoteDevices(context);
          return;
        }
        this.options.onView({ kind: "scan" });
        return;
      }
      const params = parseWebRemoteControlHmacQrParams(url.searchParams);
      if (!params) {
        this.options.onView({ kind: "failure", failure: { reason: "invalid-mobile-connection" } });
        return;
      }
      // 企业身份准入（方案 A）：二维码带 org + enterprise_auth 时，先拿企业身份再连。
      if (params.enterpriseAuth && params.enterpriseOrg) {
        const authorized = await this.ensureEnterpriseIdentity(
          { apiBaseUrl: params.enterpriseAuth, orgId: params.enterpriseOrg },
          url,
          this.backend,
        );
        if (!authorized) return;
      }
      this.connect(params);
      return;
    }
    this.backend = url.searchParams.get("backend") === "uwork" ? "uwork" : "ucas";
    if (isWebRemoteControlOAuthCallback(url)) {
      this.options.onView({ kind: "callback" });
      return;
    }
    if (!this.options.auth.getZCodeJwtToken()) {
      this.options.onView({ kind: "login" });
      return;
    }
    const params = parseWebRemoteControlExternalQrParams(url.searchParams);
    if (!params) {
      this.options.onView({ kind: "failure", failure: { reason: "invalid-mobile-connection" } });
      return;
    }
    if (!params.deviceSid) {
      await this.openDevices(true);
      return;
    }
    this.connect({ ...params, deviceSid: params.deviceSid });
  }

  private async openDevices(autoConnect: boolean): Promise<void> {
    this.reset();
    let lastSid: string | null = null;
    let lastMid: string | null = null;
    try {
      if (autoConnect) {
        lastSid = this.options.storage.getItem(LAST_DEVICE_KEY);
        lastMid = this.options.storage.getItem(LAST_DEVICE_MID_KEY);
      }
    } catch {
      // iOS 私密模式等环境可能禁用存储；最近设备只是偏好，不阻断入口。
    }
    const account = this.options.auth.getActiveAccount() ?? undefined;
    this.list = {
      view: {
        kind: "devices",
        devices: [],
        loading: false,
        error: false,
        ...(account ? { account } : {}),
      },
      unsubscribe: this.options.subscribeVisible(() => {
        void this.refreshDevices();
      }),
      lastSid,
      lastMid,
    };
    await this.refreshDevices();
  }

  async refreshDevices(): Promise<void> {
    const list = this.list;
    if (!list) return;
    if (list.request) return list.request;
    if (this.remoteContext) return this.refreshRemoteDevices(this.remoteContext, list);
    const jwt = this.options.auth.getZCodeJwtToken();
    if (!jwt) return this.switchAccount();
    if (list.acceptedJwt && list.acceptedJwt !== jwt) return this.start();
    const { signal } = this.scope;
    list.view = { ...list.view, loading: true, error: false };
    this.options.onView(list.view);
    list.request = (async () => {
      try {
        const devices = await this.options.devices(jwt, signal);
        if (signal.aborted) return;
        // 账号变更后的响应不能为新账号提供设备或自动连接依据。
        if (this.options.auth.getZCodeJwtToken() !== jwt) return this.start();
        list.acceptedJwt = jwt;
        // 先读缓存补全离线记录的名字/平台，再把本次在线记录写回；它们只是展示偏好，不进入 admission。
        const knownDevices = readKnownDevices(this.options.storage);
        const groups = groupWebRemoteControlDevices(devices, this.options.locale, knownDevices);
        rememberKnownDevices(this.options.storage, knownDevices, groups);
        list.view = { ...list.view, devices: groups, loading: false, error: false };
        const autoSid = resolveAutoConnectSid(devices, groups, list.lastSid, list.lastMid);
        // 自动落点只消费首次成功的列表；后续刷新不能打断用户选择。
        list.lastSid = null;
        list.lastMid = null;
        if (autoSid) this.selectDevice(autoSid);
        else this.options.onView(list.view);
      } catch (error) {
        if (signal.aborted) return;
        if (this.options.auth.getZCodeJwtToken() !== jwt) return this.start();
        if (
          error instanceof WebRemoteControlV2ConnectionError &&
          error.reason === "auth-required"
        ) {
          await this.switchAccount();
          return;
        }
        list.view = { ...list.view, loading: false, error: true };
        this.options.onView(list.view);
      } finally {
        list.request = undefined;
      }
    })();
    return list.request;
  }

  selectDevice(sid: string): void {
    if (!this.list || this.list.view.loading || this.list.view.error) return;
    if (this.remoteContext) {
      void this.pairRemoteDevice(sid);
      return;
    }
    if (this.list.acceptedJwt !== this.options.auth.getZCodeJwtToken()) {
      void this.start();
      return;
    }
    const device = this.list.view.devices
      .flatMap((group) => group.onlineConnections)
      .find((item) => item.device_sid === sid);
    if (!device) return;
    const url = new URL(this.options.getHref());
    url.searchParams.set("sid", device.device_sid);
    url.searchParams.set("mid", device.device_mid);
    const name = device.meta.name?.trim();
    if (name) url.searchParams.set("name", name);
    else url.searchParams.delete("name");
    this.options.replaceHref(url.href);
    this.rememberDevice(device.device_sid, device.device_mid);
    this.connect({
      deviceSid: device.device_sid,
      deviceMid: device.device_mid,
      deviceName: name || undefined,
      appVersion: url.searchParams.get("app_version") || undefined,
    });
  }

  async chooseOtherDevice(): Promise<void> {
    if (this.options.protocol === "hmac-v1") {
      if (this.remoteContext) {
        const context = this.remoteContext;
        this.reset();
        await this.openRemoteDevices(context);
        return;
      }
      this.reset();
      const url = new URL(this.options.getHref());
      for (const key of ["sid", "hash", "t", "mid", "name"]) url.searchParams.delete(key);
      this.options.replaceHref(url.href);
      this.options.onView({ kind: "scan" });
      return;
    }
    this.reset();
    const url = new URL(this.options.getHref());
    for (const key of ["sid", "mid", "name", "hash", "t"]) url.searchParams.delete(key);
    this.options.replaceHref(url.href);
    await this.openDevices(false);
  }

  /**
   * 企业身份准入：拿 token 或把浏览器送去企微授权。
   * 返回 false 表示这次不连（已跳转 / 已给出失败视图），调用方直接结束。
   */
  private async ensureEnterpriseIdentity(
    context: EnterpriseAuthContext,
    url: URL,
    backend: "ucas" | "uwork" = "ucas",
  ): Promise<boolean> {
    const pivotLogin = backend === "uwork" ? context.login : undefined;
    const code = url.searchParams.get("code");
    if (code) {
      try {
        let token: string;
        if (pivotLogin) {
          // 与桌面同一套 pivot 登录：code 直接换 pivot 会话，之后设备接口由后台内省该令牌。
          token = await exchangeEnterpriseAuthCode({
            context: { apiBaseUrl: pivotLogin.apiBaseUrl, orgId: pivotLogin.orgId ?? context.orgId },
            code,
            ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
          });
        } else if (backend === "uwork") {
          // 自建后端：回调里的 code 必须配对本页发起的 attempt（state 即 attempt id）。
          const attempt = readUworkWebAttempt(this.options.storage, context);
          if (!attempt || attempt.attemptId !== url.searchParams.get("state"))
            throw new Error("enterprise attempt missing");
          token = await exchangeUworkWebCode({
            context,
            attemptId: attempt.attemptId,
            proof: attempt.proof,
            code,
          });
          clearUworkWebAttempt(this.options.storage, context);
        } else {
          token = await exchangeEnterpriseAuthCode({ context, code });
        }
        saveEnterpriseAuthToken(this.options.storage, context, token);
      } catch (error) {
        clearEnterpriseAuthToken(this.options.storage, context);
        this.options.onView({
          kind: "failure",
          failure: {
            reason: "enterprise-identity-required",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return false;
      }
      // 回调带回的 code 只消费一次：清掉它再继续，刷新页面不会重复兑换。
      const cleaned = new URL(url.href);
      cleaned.searchParams.delete("code");
      cleaned.searchParams.delete("state");
      this.options.replaceHref(cleaned.href);
      return true;
    }
    if (readEnterpriseAuthToken(this.options.storage, context)) return true;
    try {
      let authorizeUrl: string;
      if (pivotLogin) {
        // 组织由 pivot 按入口 Host 解析；这里只把回跳地址交给它。
        authorizeUrl = await resolveEnterpriseAuthorizeUrl({
          context: { apiBaseUrl: pivotLogin.apiBaseUrl, orgId: pivotLogin.orgId ?? context.orgId },
          returnTo: url.href,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        });
      } else if (backend === "uwork") {
        // 企微内置浏览器：OAuth2 网页授权（snsapi_base），回跳到本页再换会话。
        const started = await startUworkWebAuthorize({ context, returnTo: url.href });
        saveUworkWebAttempt(this.options.storage, context, {
          attemptId: started.attemptId,
          proof: started.proof,
          expiresAt: started.expiresAt,
        });
        authorizeUrl = started.authorizeUrl;
      } else authorizeUrl = await resolveEnterpriseAuthorizeUrl({ context, returnTo: url.href });
      this.options.onView({ kind: "login" });
      window.location.assign(authorizeUrl);
    } catch (error) {
      this.options.onView({
        kind: "failure",
        failure: {
          reason: "enterprise-identity-required",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return false;
  }

  /** 免扫码：打开"我的设备"列表（复用设备页视图与分组）。 */
  private async openRemoteDevices(context: EnterpriseAuthContext): Promise<void> {
    this.remoteContext = context;
    let lastSid: string | null = null;
    let lastMid: string | null = null;
    try {
      lastSid = this.options.storage.getItem(LAST_DEVICE_KEY);
      lastMid = this.options.storage.getItem(LAST_DEVICE_MID_KEY);
    } catch {
      // 存储不可用只影响"最近设备"偏好，不影响列表。
    }
    this.list = {
      view: { kind: "devices", devices: [], loading: true, error: false },
      unsubscribe: this.options.subscribeVisible(() => {
        void this.refreshDevices();
      }),
      lastSid,
      lastMid,
    };
    this.options.onView(this.list.view);
    await this.refreshDevices();
  }

  private async refreshRemoteDevices(
    context: EnterpriseAuthContext,
    list: NonNullable<WebRemoteControlEntry["list"]>,
  ): Promise<void> {
    const token = readEnterpriseAuthToken(this.options.storage, context);
    if (!token) {
      // 企业会话已失效（关页面即过期）：重新走一次企微授权，不能沿用旧列表。
      void this.start();
      return;
    }
    const { signal } = this.scope;
    list.view = { ...list.view, loading: true, error: false };
    this.options.onView(list.view);
    list.request = (async () => {
      try {
        const devices = await fetchRemoteDevices({
          context,
          token,
          signal,
          ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        });
        if (signal.aborted) return;
        const knownDevices = readKnownDevices(this.options.storage);
        const views = devices.map(toRelayDeviceView);
        const groups = groupWebRemoteControlDevices(views, this.options.locale, knownDevices);
        rememberKnownDevices(this.options.storage, knownDevices, groups);
        list.view = { ...list.view, devices: groups, loading: false, error: false };
        const autoSid = resolveAutoConnectSid(views, groups, list.lastSid, list.lastMid);
        list.lastSid = null;
        list.lastMid = null;
        if (autoSid) void this.pairRemoteDevice(autoSid);
        else this.options.onView(list.view);
      } catch {
        if (signal.aborted) return;
        list.view = { ...list.view, loading: false, error: true };
        this.options.onView(list.view);
      } finally {
        list.request = undefined;
      }
    })();
    return list.request;
  }

  /** 选中设备 → 后台建配对请求 → 等桌面应答 → 用材料走既有 HMAC 连接。 */
  private async pairRemoteDevice(sid: string): Promise<void> {
    const context = this.remoteContext;
    const list = this.list;
    if (!context || !list || list.view.loading || list.view.error) return;
    const device = list.view.devices
      .flatMap((group) => group.onlineConnections)
      .find((item) => item.device_sid === sid);
    const token = readEnterpriseAuthToken(this.options.storage, context);
    if (!token) {
      void this.start();
      return;
    }
    list.view = { ...list.view, loading: true, error: false };
    this.options.onView(list.view);
    try {
      const pairing = await requestRemotePairing({
        context,
        token,
        deviceSid: sid,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      });
      const material = await waitRemotePairing({
        context,
        token,
        deviceSid: sid,
        pairingId: pairing.id,
        signal: this.scope.signal,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      });
      if (!material) {
        // 桌面没应答或请求过期：给出"电脑端未响应"而不是空白等待。
        this.options.onView({ kind: "failure", failure: { reason: "desktop-disconnected" } });
        return;
      }
      this.rememberDevice(material.sid, device?.device_mid);
      this.connect({
        deviceSid: material.sid,
        ...(device?.device_mid ? { deviceMid: device.device_mid } : {}),
        passHash: material.hash,
        enterpriseAuth: context.apiBaseUrl,
        enterpriseOrg: context.orgId,
      });
    } catch (error) {
      this.options.onView({
        kind: "failure",
        failure: {
          reason: "unexpected-error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private rememberDevice(sid: string, mid: string | undefined): void {
    try {
      this.options.storage.setItem(LAST_DEVICE_KEY, sid);
      if (mid) this.options.storage.setItem(LAST_DEVICE_MID_KEY, mid);
    } catch {
      // 偏好持久化失败不影响连接，也不修改按 SID 隔离的业务状态。
    }
  }

  private connect(params: WebRemoteControlEntryConnection["params"]): void {
    this.reset();
    const { signal } = this.scope;
    this.options.connect({
      params,
      protocol: this.options.protocol ?? "oauth-v2",
      signal,
      getToken: (tokenSignal) => {
        const jwt = this.options.auth.getZCodeJwtToken();
        if (!jwt) return Promise.reject(new WebRemoteControlV2ConnectionError("auth-required"));
        return this.options.token(jwt, tokenSignal);
      },
      onPaired: () => {
        if (!signal.aborted) this.rememberDevice(params.deviceSid, params.deviceMid);
      },
      onFailure: (failure) => {
        if (signal.aborted) return;
        if (failure.reason === "auth-required") void this.switchAccount();
        else this.options.onView({ kind: "failure", failure });
      },
    });
  }

  startLogin(provider?: WebOAuthProviderId): void {
    if (this.options.protocol === "hmac-v1") return;
    this.options.auth.startLogin({
      ...this.options.loginOptions,
      ...(provider ? { provider } : {}),
      appReturnTo: this.options.getHref(),
    });
  }

  async switchAccount(): Promise<void> {
    if (this.options.protocol === "hmac-v1") return this.chooseOtherDevice();
    this.reset();
    const { signal } = this.scope;
    await this.options.auth.logout();
    if (!signal.aborted) this.options.onView({ kind: "login" });
  }
}

import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import type { EnterpriseAuthContext } from "#src/web-remote-control/app/enterpriseAuth.js";

/**
 * 自建后台（uwork）的设备目录与配对应答。
 *
 * 免扫码通路：手机页在企微内置浏览器里登录后，从这里拿"我的设备"，
 * 选中设备后向后台建一条配对请求；桌面端应答时把本次配对材料交回，
 * 页面再用它走既有的 HMAC 连接（relay 与协议不变）。
 */

export interface RemoteDeviceSummary {
  deviceSid: string;
  deviceMid: string;
  name?: string;
  platform?: string;
}

export interface RemotePairingMaterial {
  sid: string;
  hash: string;
  org: string;
  enterpriseAuth: string;
}

const PAIRING_POLL_INTERVAL_MS = 1_500;

/** 设备目录的重试节奏：上游（pivot 内省 → 后台）会偶发 503，重试两次就够。 */
const DEVICE_FETCH_RETRIES = 2;
const DEVICE_FETCH_BACKOFF_MS = [600, 1_500];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 5xx/429 与网络错误是暂时的，可以重试；401/403 是凭据问题，必须立刻交给上层重新登录。 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function endpoints(context: EnterpriseAuthContext) {
  const base = `${context.apiBaseUrl}/`;
  return {
    devices: new URL("/api/client/remote-devices", base),
    pairing: (sid: string) =>
      new URL(`/api/client/remote-devices/${encodeURIComponent(sid)}/pairings`, base),
    pairingStatus: (sid: string, pairingId: string) =>
      new URL(
        `/api/client/remote-devices/${encodeURIComponent(sid)}/pairings/${encodeURIComponent(pairingId)}`,
        base,
      ),
  };
}

export async function fetchRemoteDevices(options: {
  context: EnterpriseAuthContext;
  token: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** 测试用：把重试退避压到 0。 */
  retryDelayMs?: (attempt: number) => number;
}): Promise<RemoteDeviceSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const backoff =
    options.retryDelayMs ?? ((attempt: number) => DEVICE_FETCH_BACKOFF_MS[attempt - 1] ?? 1_500);
  const url = endpoints(options.context).devices;
  let response: Response | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= DEVICE_FETCH_RETRIES + 1; attempt += 1) {
    if (attempt > 1) await sleep(backoff(attempt - 1));
    if (options.signal?.aborted) throw new Error("remote devices aborted");
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${options.token}` },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // 网络层失败（含超时）也可以重试；abort 不重试。
      if (options.signal?.aborted) throw error;
      lastError = error;
      continue;
    }
    if (response.ok) break;
    // 上游"繁忙"（后台把 pivot 抖动翻成 503）与网关 5xx 都重试；401/403 立即失败。
    if (!isRetryableStatus(response.status) || attempt > DEVICE_FETCH_RETRIES) {
      throw new Error(`remote devices ${response.status}`);
    }
  }
  if (!response) throw lastError ?? new Error("remote devices unavailable");
  if (!response.ok) throw new Error(`remote devices ${response.status}`);
  const body = await readJson(response);
  const raw = Array.isArray(body["devices"]) ? (body["devices"] as unknown[]) : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const deviceSid = typeof record["deviceSid"] === "string" ? record["deviceSid"] : "";
    const deviceMid = typeof record["deviceMid"] === "string" ? record["deviceMid"] : "";
    if (!deviceSid || !deviceMid) return [];
    const name = typeof record["name"] === "string" ? record["name"] : undefined;
    const platform = typeof record["platform"] === "string" ? record["platform"] : undefined;
    return [{ deviceSid, deviceMid, ...(name ? { name } : {}), ...(platform ? { platform } : {}) }];
  });
}

/** 设备目录条目映射成设备页既有的展示形状（在线；名字/平台来自登记）。 */
export function toRelayDeviceView(device: RemoteDeviceSummary): WebRemoteControlRelayV2Device {
  return {
    device_sid: device.deviceSid,
    device_mid: device.deviceMid,
    online: true,
    created_at: Math.floor(Date.now() / 1000),
    meta: {
      ...(device.name ? { name: device.name } : {}),
      ...(device.platform ? { platform: device.platform } : {}),
    },
  };
}

export async function requestRemotePairing(options: {
  context: EnterpriseAuthContext;
  token: string;
  deviceSid: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; expiresAt: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoints(options.context).pairing(options.deviceSid), {
    method: "POST",
    headers: { Authorization: `Bearer ${options.token}` },
  });
  if (!response.ok) throw new Error(`remote pairing ${response.status}`);
  const body = await readJson(response);
  const id = typeof body["id"] === "string" ? body["id"] : "";
  const expiresAt = typeof body["expiresAt"] === "number" ? body["expiresAt"] : 0;
  if (!id || !expiresAt) throw new Error("remote pairing payload missing");
  return { id, expiresAt };
}

/**
 * 轮询配对结果。桌面没应答（或请求过期）时返回 null，由调用方给出可读失败原因；
 * 材料只会被消费一次，重复轮询得到 expired。
 */
export async function waitRemotePairing(options: {
  context: EnterpriseAuthContext;
  token: string;
  deviceSid: string;
  pairingId: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RemotePairingMaterial | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + 90_000;
  for (;;) {
    if (options.signal?.aborted) return null;
    const response = await fetchImpl(
      endpoints(options.context).pairingStatus(options.deviceSid, options.pairingId),
      {
        method: "GET",
        headers: { Authorization: `Bearer ${options.token}` },
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!response.ok) throw new Error(`remote pairing status ${response.status}`);
    const body = await readJson(response);
    const status = typeof body["status"] === "string" ? body["status"] : "";
    if (status === "answered") {
      const pairing = body["pairing"];
      if (!pairing || typeof pairing !== "object") return null;
      const record = pairing as Record<string, unknown>;
      const sid = typeof record["sid"] === "string" ? record["sid"] : "";
      const hash = typeof record["hash"] === "string" ? record["hash"] : "";
      const org = typeof record["org"] === "string" ? record["org"] : "";
      const enterpriseAuth =
        typeof record["enterpriseAuth"] === "string" ? record["enterpriseAuth"] : "";
      if (!sid || !hash || !org || !enterpriseAuth) return null;
      return { sid, hash, org, enterpriseAuth };
    }
    if (status === "expired") return null;
    if (now() >= deadline) return null;
    await sleep(PAIRING_POLL_INTERVAL_MS);
  }
}

/**
 * 同源入口探测（照 ucas-proxy"页面与 API 同源"的口径）：页面与后台同源时，
 * 组织与后端形态由 Host 解析，企微应用主页只需要一个干净的 `/remote/v4`。
 * 非本后端的 origin 返回 404，调用方回落到二维码/显式参数入口。
 */
export async function readSameOriginBackend(options: {
  origin: string;
  fetchImpl?: typeof fetch;
}): Promise<{ backend: "uwork"; tenantId: string; pivotApiBaseUrl?: string } | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(new URL("/api/auth/wecom/web-config", `${options.origin}/`), {
      method: "GET",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) return null;
    const body = await readJson(response);
    const tenantId = typeof body["tenantId"] === "string" ? body["tenantId"] : "";
    if (body["backend"] !== "uwork" || !tenantId) return null;
    // 后台告诉我们登录该走哪套身份（配置了 pivot 时手机页与桌面共用 pivot 登录）。
    const pivot = typeof body["pivotApiBaseUrl"] === "string" ? body["pivotApiBaseUrl"].trim() : "";
    return {
      backend: "uwork",
      tenantId,
      ...(pivot.startsWith("https://") ? { pivotApiBaseUrl: pivot } : {}),
    };
  } catch {
    return null;
  }
}

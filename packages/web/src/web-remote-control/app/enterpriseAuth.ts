/**
 * 手机页的企业微信身份准入（方案 A，见 specs/remote-control-enterprise-auth.md）。
 *
 * 为什么在这里做：官方 V2 通道要 z.ai 账号，UWork 没有也不打算有账号体系；
 * 企业身份在 ucas-proxy（control-plane）里已经存在，手机页直接复用它换一次 JWT，
 * 由桌面端校验"是不是同一家公司的同一个人"。
 *
 * 只在二维码带了 `enterprise_auth` + `org` 时才启用；token 存 sessionStorage，
 * 关掉页面即失效（不落长期凭据，避免把企业身份变成新的"长期钥匙"）。
 */

export interface EnterpriseAuthContext {
  /** ucas-proxy control-plane 基址（已由共享层校验过是 https 且无 query/hash）。 */
  apiBaseUrl: string;
  /** 桌面当前登录的组织 id。 */
  orgId: string;
}

const TOKEN_KEY_PREFIX = "uwork.remote-enterprise-token:";

function tokenKey(context: EnterpriseAuthContext): string {
  return `${TOKEN_KEY_PREFIX}${context.apiBaseUrl}|${context.orgId}`;
}

export interface EnterpriseAuthStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** 可选：手机页注入的 storage 只保证读写（见 WebRemoteControlEntryOptions.storage）。 */
  removeItem?(key: string): void;
}

export function readEnterpriseAuthToken(
  storage: EnterpriseAuthStorageLike,
  context: EnterpriseAuthContext,
): string | null {
  try {
    const value = storage.getItem(tokenKey(context));
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function saveEnterpriseAuthToken(
  storage: EnterpriseAuthStorageLike,
  context: EnterpriseAuthContext,
  token: string,
): void {
  try {
    storage.setItem(tokenKey(context), token);
  } catch {
    // 存不下不影响本次连接（token 仍在内存里用一次），只是刷新页面要重新授权。
  }
}

export function clearEnterpriseAuthToken(
  storage: EnterpriseAuthStorageLike,
  context: EnterpriseAuthContext,
): void {
  try {
    storage.removeItem?.(tokenKey(context));
  } catch {
    // 清不掉也不该阻塞重新登录。
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 取企微授权链接：control-plane 按 org_id 选企微应用，redirect_uri 原样带回本页。 */
export async function resolveEnterpriseAuthorizeUrl(options: {
  context: EnterpriseAuthContext;
  returnTo: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL("/api/auth/authorize", `${options.context.apiBaseUrl}/`);
  endpoint.searchParams.set("org_id", options.context.orgId);
  endpoint.searchParams.set("redirect_uri", options.returnTo);
  const response = await fetchImpl(endpoint, { method: "GET" });
  if (!response.ok) throw new Error(`authorize ${response.status}`);
  const body = await readJson(response);
  const url = typeof body["url"] === "string" ? body["url"] : "";
  if (!url) throw new Error("authorize url missing");
  return url;
}

/** 用回调里的 code 换 JWT（换到的身份由桌面端再向 control-plane 校验一次）。 */
export async function exchangeEnterpriseAuthCode(options: {
  context: EnterpriseAuthContext;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = new URL("/api/auth/login", `${options.context.apiBaseUrl}/`);
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: options.code, org_id: options.context.orgId }),
  });
  if (!response.ok) throw new Error(`login ${response.status}`);
  const body = await readJson(response);
  const token = typeof body["token"] === "string" ? body["token"] : "";
  if (!token) throw new Error("token missing");
  return token;
}

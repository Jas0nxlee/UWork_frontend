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
  /** 免扫码设备/配对接口的基址（backend=uwork 时是自建后台）。 */
  apiBaseUrl: string;
  /** 桌面当前登录的组织 id。 */
  orgId: string;
  /**
   * 登录服务与上面不是同一个后端时（backend=uwork：设备接口在自建后台、登录在 pivot），
   * 授权与换令牌打这里；缺省即 apiBaseUrl。
   */
  login?: { apiBaseUrl: string; orgId?: string };
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

const ENTRY_MARKER_PREFIX = "uwork.remote-enterprise-entry:";

/** 探测成功时记下"这个来源是免扫码入口"，供后续探测失败时区分扫码页。 */
export function markEnterpriseEntryOrigin(
  storage: EnterpriseAuthStorageLike,
  origin: string,
): void {
  try {
    storage.setItem(`${ENTRY_MARKER_PREFIX}${origin}`, "1");
  } catch {
    // 存储不可用只是少了这层判断，不影响入口本身。
  }
}

export function isEnterpriseEntryOrigin(
  storage: EnterpriseAuthStorageLike,
  origin: string,
): boolean {
  try {
    return storage.getItem(`${ENTRY_MARKER_PREFIX}${origin}`) === "1";
  } catch {
    return false;
  }
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

const ATTEMPT_KEY_PREFIX = "uwork.remote-enterprise-attempt:";

/** 自建后端（uwork）网页授权的一次性尝试材料；只活在一次跳转周期内。 */
export interface UworkWebAttempt {
  attemptId: string;
  proof: string;
  expiresAt: number;
}

function attemptKey(context: EnterpriseAuthContext): string {
  return `${ATTEMPT_KEY_PREFIX}${context.apiBaseUrl}|${context.orgId}`;
}

export function readUworkWebAttempt(
  storage: EnterpriseAuthStorageLike,
  context: EnterpriseAuthContext,
): UworkWebAttempt | null {
  try {
    const raw = storage.getItem(attemptKey(context));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UworkWebAttempt>;
    if (
      typeof parsed.attemptId !== "string" ||
      typeof parsed.proof !== "string" ||
      typeof parsed.expiresAt !== "number"
    )
      return null;
    return { attemptId: parsed.attemptId, proof: parsed.proof, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export function saveUworkWebAttempt(
  storage: EnterpriseAuthStorageLike,
  context: EnterpriseAuthContext,
  attempt: UworkWebAttempt,
): void {
  try {
    storage.setItem(attemptKey(context), JSON.stringify(attempt));
  } catch {
    // 存不下就不能安全地完成回调：start 侧会按"没有本地尝试"处理。
  }
}

export function clearUworkWebAttempt(
  storage: EnterpriseAuthStorageLike,
  context: EnterpriseAuthContext,
): void {
  try {
    storage.removeItem?.(attemptKey(context));
  } catch {
    // 清理失败不阻塞后续登录。
  }
}

/**
 * 自建后端（企微内置浏览器）的网页授权起点：mode=web 让后台返回 OAuth2
 * 网页授权链接（snsapi_base），returnTo 指向本页，授权后带 code 回到这里。
 */
export async function startUworkWebAuthorize(options: {
  context: EnterpriseAuthContext;
  returnTo: string;
  fetchImpl?: typeof fetch;
}): Promise<{ attemptId: string; proof: string; expiresAt: number; authorizeUrl: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    new URL("/api/auth/wecom/attempts", `${options.context.apiBaseUrl}/`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: options.context.orgId,
        mode: "web",
        returnTo: options.returnTo,
      }),
    },
  );
  if (!response.ok) throw new Error(`attempts ${response.status}`);
  const body = await readJson(response);
  const attemptId = typeof body["id"] === "string" ? body["id"] : "";
  const proof = typeof body["proof"] === "string" ? body["proof"] : "";
  const authorizeUrl = typeof body["authorizeUrl"] === "string" ? body["authorizeUrl"] : "";
  const expiresAt = typeof body["expiresAt"] === "number" ? body["expiresAt"] : 0;
  if (!attemptId || !proof || !authorizeUrl || !expiresAt)
    throw new Error("attempt payload missing");
  return { attemptId, proof, authorizeUrl, expiresAt };
}

/** 回调里的 code 换企业会话（complete + claim），换到的身份由桌面端再校验一次。 */
export async function exchangeUworkWebCode(options: {
  context: EnterpriseAuthContext;
  attemptId: string;
  proof: string;
  code: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `${options.context.apiBaseUrl}/`;
  const complete = await fetchImpl(
    new URL(`/api/auth/wecom/attempts/${encodeURIComponent(options.attemptId)}/complete`, base),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proof: options.proof, code: options.code }),
    },
  );
  if (!complete.ok) throw new Error(`complete ${complete.status}`);
  const claim = await fetchImpl(
    new URL(`/api/auth/wecom/attempts/${encodeURIComponent(options.attemptId)}/claim`, base),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proof: options.proof, delivery: "token" }),
    },
  );
  if (!claim.ok) throw new Error(`claim ${claim.status}`);
  const body = await readJson(claim);
  const token = typeof body["token"] === "string" ? body["token"] : "";
  if (!token) throw new Error("session token missing");
  return token;
}

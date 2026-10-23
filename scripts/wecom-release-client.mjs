import { setTimeout as sleep } from "node:timers/promises";

// 企业微信只承诺标识为字符串；成员空间和应用空间的标识形式不能互相推断。
export function isWecomIdentifier(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const TRANSIENT_CODES = new Set([-1, 45009, 45011]);
const TOKEN_CODES = new Set([40001, 40014, 42001]);
const REPLAYABLE = new Set([
  "file_list",
  "file_info",
  "file_upload_part",
  "new_space_info",
  "agent_list",
  "agent_get",
  "tag_get",
  "user_simplelist",
  "user_get",
]);

class WecomError extends Error {
  constructor(operation, { code, status, transient = false } = {}) {
    // 不输出 errmsg、URL 或底层网络错误，它们可能包含 token、请求体或内部标识。
    super(
      `企业微信 ${operation} 失败${code !== undefined ? `（错误码 ${code}）` : status ? `（HTTP ${status}）` : "（网络异常或响应无效）"}`,
    );
    this.code = code;
    this.transient = transient;
  }
}

export function createWecomClient({
  config,
  fetchImpl = fetch,
  sleepImpl = sleep,
  now = Date.now,
}) {
  let token;
  let expiresAt = 0;

  async function invoke(operation, url, body, replayable) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        let response;
        let data;
        try {
          response = await fetchImpl(url, {
            method: body === undefined ? "GET" : "POST",
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(60_000),
            redirect: "error",
          });
        } catch {
          throw new WecomError(operation, { transient: true });
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new WecomError(operation, {
            status: response.status,
            transient: response.status === 429 || response.status >= 500,
          });
        }
        try {
          data = await response.json();
        } catch {
          throw new WecomError(operation, { transient: true });
        }
        if (!data || typeof data !== "object" || data.errcode !== 0)
          throw new WecomError(operation, {
            code: Number.isInteger(data?.errcode) ? data.errcode : undefined,
            transient: TRANSIENT_CODES.has(data?.errcode),
          });
        return data;
      } catch (error) {
        if (!replayable || !error.transient || attempt === 3) throw error;
        await sleepImpl(1000 * 2 ** attempt);
      }
    }
  }

  async function accessToken() {
    if (token && now() < expiresAt) return token;
    const url = new URL("https://qyapi.weixin.qq.com/cgi-bin/gettoken");
    url.searchParams.set("corpid", config.corpId);
    url.searchParams.set("corpsecret", config.secret);
    const data = await invoke("gettoken", url, undefined, true);
    if (
      typeof data.access_token !== "string" ||
      !data.access_token ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      throw new WecomError("gettoken");
    token = data.access_token;
    expiresAt = now() + Math.max(0, data.expires_in - 60) * 1000;
    return token;
  }

  return {
    async request(operation, body) {
      if (
        !/^(file_list|file_info|file_create|file_upload_init|file_upload_part|file_upload_finish|new_space_info|agent_list|agent_get|tag_get|user_simplelist|user_get|space_create)$/.test(
          operation,
        )
      )
        throw new Error("不支持的微盘同步操作");
      for (let refresh = 0; refresh < 2; refresh++) {
        const getPaths = {
          agent_list: "agent/list",
          agent_get: "agent/get",
          tag_get: "tag/get",
          user_simplelist: "user/simplelist",
          user_get: "user/get",
        };
        const url = new URL(
          getPaths[operation]
            ? `https://qyapi.weixin.qq.com/cgi-bin/${getPaths[operation]}`
            : `https://qyapi.weixin.qq.com/cgi-bin/wedrive/${operation}`,
        );
        if (operation === "user_simplelist") {
          url.searchParams.set("department_id", String(body?.department_id));
          url.searchParams.set("fetch_child", String(body?.fetch_child));
        }
        if (operation === "user_get") url.searchParams.set("userid", body?.userid);
        if (operation === "agent_get") url.searchParams.set("agentid", String(body?.agentid));
        if (operation === "tag_get") url.searchParams.set("tagid", String(body?.tagid));
        url.searchParams.set("access_token", await accessToken());
        try {
          return await invoke(
            operation,
            url,
            getPaths[operation] ? undefined : body,
            REPLAYABLE.has(operation),
          );
        } catch (error) {
          if (!TOKEN_CODES.has(error.code) || refresh === 1) throw error;
          // 明确的 token 拒绝未执行写入，可以刷新后再发；写入结果不明由同步 owner 回读处理。
          token = undefined;
          expiresAt = 0;
        }
      }
    },
  };
}

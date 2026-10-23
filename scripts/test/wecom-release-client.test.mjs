import assert from "node:assert/strict";
import test from "node:test";
import { createWecomClient } from "../wecom-release-client.mjs";

const config = { corpId: "private-corp", secret: "private-secret" };
const response = (data, status = 200) =>
  new Response(JSON.stringify({ errcode: 0, ...data }), { status });
const issued = (value = "private-token") => response({ access_token: value, expires_in: 7200 });

test("HTTP 429/5xx、系统忙、限频和网络失败可重试且最多四次", async () => {
  for (const failure of [
    () => response({}, 429),
    () => response({}, 503),
    () => response({ errcode: -1 }),
    () => response({ errcode: 45009 }),
    () => {
      throw new Error("network private-token");
    },
  ]) {
    let calls = 0;
    const sleeps = [];
    const client = createWecomClient({
      config,
      sleepImpl: async (delay) => sleeps.push(delay),
      fetchImpl: async (url) => {
        if (url.pathname.endsWith("gettoken")) return issued();
        return ++calls < 4 ? failure() : response({ complete: true });
      },
    });
    assert.equal((await client.request("file_upload_part", { index: 1 })).complete, true);
    assert.equal(calls, 4);
    assert.deepEqual(sleeps, [1000, 2000, 4000]);
  }
});

test("重试耗尽必须失败；认证和权限失败不做临时错误重试", async () => {
  for (const [status, code, expected] of [
    [503, 0, 4],
    [200, 48002, 1],
    [403, 0, 1],
  ]) {
    let calls = 0;
    const client = createWecomClient({
      config,
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        if (url.pathname.endsWith("gettoken")) return issued();
        calls++;
        return response({ errcode: code, errmsg: "private-token private-secret" }, status);
      },
    });
    await assert.rejects(client.request("file_info", {}), (error) => {
      assert.ok(!error.message.includes("private-"));
      return true;
    });
    assert.equal(calls, expected);
  }
});

test("写入结果不明不会盲目重试目录创建、初始化或完成提交", async () => {
  for (const operation of ["file_create", "file_upload_init", "file_upload_finish"]) {
    let calls = 0;
    const client = createWecomClient({
      config,
      sleepImpl: async () => assert.fail("不得盲目重试"),
      fetchImpl: async (url) => {
        if (url.pathname.endsWith("gettoken")) return issued();
        calls++;
        throw new Error("response lost private-token");
      },
    });
    await assert.rejects(client.request(operation, {}), /网络异常/);
    assert.equal(calls, 1);
  }
});

test("token 只缓存于进程，失效刷新一次后继续原操作", async () => {
  let tokens = 0;
  const seen = [];
  const client = createWecomClient({
    config,
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("gettoken")) return issued(`token-${++tokens}`);
      seen.push(url.searchParams.get("access_token"));
      return seen.length === 1 ? response({ errcode: 42001 }) : response({ complete: true });
    },
  });
  await client.request("file_list", {});
  await client.request("file_info", {});
  assert.equal(tokens, 2);
  assert.deepEqual(seen, ["token-1", "token-2", "token-2"]);
});

test("token 持续无效刷新一次就失败；到期提前刷新", async () => {
  let time = 0;
  let tokens = 0;
  let invalid = false;
  const client = createWecomClient({
    config,
    now: () => time,
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("gettoken")) {
        tokens++;
        return issued();
      }
      return response({ errcode: invalid ? 40014 : 0 });
    },
  });
  await client.request("file_info", {});
  time = 7150_000;
  await client.request("file_info", {});
  assert.equal(tokens, 2);
  invalid = true;
  await assert.rejects(client.request("file_info", {}), /40014/);
  assert.equal(tokens, 3);
});

test("请求设置 60 秒超时、禁止重定向；错误不泄漏 URL/凭据/请求体", async () => {
  const client = createWecomClient({
    config,
    sleepImpl: async () => {},
    fetchImpl: async (url, options) => {
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      if (url.pathname.endsWith("gettoken")) return issued();
      throw new Error(`${url} ${JSON.stringify(options)}`);
    },
  });
  await assert.rejects(
    client.request("file_upload_part", { upload_key: "private-upload" }),
    (error) => {
      assert.ok(!/private|https|access_token|upload_key/.test(error.message));
      return true;
    },
  );
});

test("HTTP 权限错误即使非 JSON 也不应被当作可重试网络错误", async () => {
  let calls = 0;
  const client = createWecomClient({
    config,
    sleepImpl: async () => {},
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("gettoken")) return issued();
      calls++;
      return new Response("Forbidden private-secret", { status: 403 });
    },
  });
  await assert.rejects(client.request("file_info", {}), /HTTP 403/);
  assert.equal(calls, 1);
});

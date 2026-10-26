import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildProxyConfig,
  proxyEnvironment,
  verifyProxyArchive,
  withWecomProxy,
} from "../wecom-release-proxy.mjs";

const execFile = promisify(execFileCallback);
const node = {
  name: "synthetic-test",
  type: "vless",
  server: "proxy.example.invalid",
  port: 443,
  uuid: "00000000-0000-4000-8000-000000000001",
  tls: true,
  "skip-cert-verify": false,
  network: "tcp",
  flow: "xtls-rprx-vision",
  servername: "www.example.org",
  encryption: "none",
  "client-fingerprint": "chrome",
  "reality-opts": { "public-key": "a".repeat(43), "short-id": "7e" },
};

test("代理只监听 loopback，固定路由白名单，拒绝关闭 TLS 校验和配置注入", () => {
  const config = buildProxyConfig(JSON.stringify(node));
  assert.equal(config["bind-address"], "127.0.0.1");
  assert.equal(config["allow-lan"], false);
  assert.deepEqual(config.rules, [
    "DOMAIN,qyapi.weixin.qq.com,wecom-egress",
    "DOMAIN,api.ipify.org,wecom-egress",
    "MATCH,REJECT",
  ]);
  assert.equal(config.proxies[0].name, "wecom-egress");
  for (const value of [
    { ...node, "skip-cert-verify": true },
    { ...node, tls: false },
    { ...node, "external-controller": "0.0.0.0:9090" },
    { ...node, uuid: "invalid" },
    { ...node, "reality-opts": { ...node["reality-opts"], unsafe: true } },
  ])
    assert.throws(() => buildProxyConfig(JSON.stringify(value)), /代理配置/);
  assert.throws(() => buildProxyConfig("not json"), /代理配置/);
});

test("固定二进制 SHA256 不匹配拒绝执行", () => {
  const data = Buffer.from("archive");
  const expected = createHash("sha256").update(data).digest("hex");
  assert.doesNotThrow(() => verifyProxyArchive(data, expected));
  assert.throws(() => verifyProxyArchive(Buffer.from("tampered"), expected), /SHA256/);
});

test("清空代理绕过变量和原始代理 Secret，保持企微所需配置", () => {
  const env = proxyEnvironment({
    HTTPS_PROXY: "http://other.invalid",
    https_proxy: "http://bypass.invalid",
    HTTP_PROXY: "http://other.invalid",
    ALL_PROXY: "socks5://other.invalid",
    NO_PROXY: "*",
    no_proxy: "*",
    WECOM_PROXY_CONFIG: "private-node",
    WECOM_SECRET: "synthetic-test-value",
  });
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:17890");
  assert.equal(env.NO_PROXY, "");
  assert.equal(env.NODE_USE_ENV_PROXY, "1");
  assert.equal(env.WECOM_SECRET, "synthetic-test-value");
  for (const key of [
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "ALL_PROXY",
    "all_proxy",
    "WECOM_PROXY_CONFIG",
  ])
    assert.equal(env[key], undefined);
});

test("Node 24 fetch 的 HTTPS 请求确实经过本地 CONNECT，不受 NO_PROXY=* 绕过", async (t) => {
  const server = createServer();
  const connected = [];
  server.on("connect", (request, socket) => {
    connected.push(request.url);
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = proxyEnvironment(
    { ...process.env, NO_PROXY: "*" },
    `http://127.0.0.1:${server.address().port}`,
  );
  await execFile(
    process.execPath,
    [
      "--use-env-proxy",
      "--input-type=module",
      "-e",
      'try { await fetch("https://qyapi.weixin.qq.com/cgi-bin/test", {signal: AbortSignal.timeout(3000)}); process.exitCode=1; } catch {}',
    ],
    { env },
  );
  assert.deepEqual(connected, ["qyapi.weixin.qq.com:443"]);
});

test("无代理配置保持原有执行路径；配置错误时不得回退直连", async () => {
  let calls = 0;
  assert.equal(
    await withWecomProxy({
      env: {},
      runSync: async () => {
        calls++;
        return 0;
      },
    }),
    0,
  );
  await assert.rejects(
    withWecomProxy({
      env: { WECOM_PROXY_CONFIG: "bad" },
      runSync: async () => {
        calls++;
      },
    }),
    /代理配置/,
  );
  assert.equal(calls, 1);
});

test("本地已有代理占用端口时停止，不能误用其它进程作为固定出口", async (t) => {
  const server = createServer();
  server.on("connection", (socket) => socket.end());
  await new Promise((resolve) => server.listen(17890, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(
    withWecomProxy({
      env: { ...process.env, WECOM_PROXY_CONFIG: JSON.stringify(node) },
      resolveBinary: async () => assert.fail("不得启动代理"),
      runSync: async () => assert.fail("不得执行同步"),
    }),
    /端口已被占用/,
  );
});

test("代理成功/失败后均关闭子进程并删除权限受控的临时配置", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wecom-proxy-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, "fake-mihomo");
  await writeFile(
    binary,
    '#!/usr/bin/env node\nrequire("node:net").createServer(s=>s.end()).listen(17890,"127.0.0.1");\n',
    { mode: 0o700 },
  );
  for (const fail of [false, true]) {
    let configPath;
    let proxyPid;
    const task = withWecomProxy({
      env: { ...process.env, WECOM_PROXY_CONFIG: JSON.stringify(node), RUNNER_TEMP: dir },
      resolveBinary: async (path) => {
        configPath = join(path, "config.json");
        return binary;
      },
      probe: async (_env, child) => {
        proxyPid = child.pid;
      },
      runSync: async (env) => {
        assert.equal((await stat(configPath)).mode & 0o777, 0o600);
        assert.equal((await stat(join(configPath, ".."))).mode & 0o777, 0o700);
        assert.ok((await readFile(configPath, "utf8")).includes("wecom-egress"));
        assert.equal(env.NODE_USE_ENV_PROXY, "1");
        if (fail) throw new Error("synthetic upload failure");
        return 0;
      },
    });
    if (fail) await assert.rejects(task, /synthetic upload failure/);
    else assert.equal(await task, 0);
    await assert.rejects(stat(configPath), /ENOENT/);
    assert.throws(() => process.kill(proxyPid, 0), /ESRCH/);
  }
});

import { createHash } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { createConnection, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";
import { setTimeout as sleep } from "node:timers/promises";

const execFile = promisify(execFileCallback);
const gunzip = promisify(gunzipCallback);
const PROXY_URL = "http://127.0.0.1:17890";
const VERSION = "v1.19.33";
const PROBE_NETWORK_CODES = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
];
const ARCHIVES = {
  "linux-x64": [
    "linux-amd64-compatible",
    "386508bfb1c72c43b6a0eda73708ecdce82546581b0ebcb16366c53757c622b6",
  ],
  "darwin-arm64": [
    "darwin-arm64",
    "060b64b0f2c9a310831db0fe4adb2878de67bfa606c311813c1f13966aa504b6",
  ],
};

export function buildProxyConfig(raw) {
  const invalid = () => new Error("微盘代理配置无效；需要校验证书的 VLESS Reality TCP 节点");
  let node;
  try {
    node = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  const allowed = new Set([
    "name",
    "type",
    "server",
    "port",
    "uuid",
    "flow",
    "encryption",
    "tls",
    "skip-cert-verify",
    "servername",
    "reality-opts",
    "client-fingerprint",
    "network",
    "udp",
    "alterId",
    "cipher",
  ]);
  const hostname = (value) =>
    typeof value === "string" && value.length <= 253 && /^[a-z\d][a-z\d.-]*$/i.test(value);
  if (
    !node ||
    Array.isArray(node) ||
    Object.keys(node).some((key) => !allowed.has(key)) ||
    node.type !== "vless" ||
    node.tls !== true ||
    node["skip-cert-verify"] !== false ||
    node.network !== "tcp" ||
    node.flow !== "xtls-rprx-vision" ||
    node.encryption !== "none" ||
    !hostname(node.server) ||
    !hostname(node.servername) ||
    !Number.isInteger(node.port) ||
    node.port < 1 ||
    node.port > 65535 ||
    typeof node.uuid !== "string" ||
    !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(node.uuid) ||
    node["client-fingerprint"] !== "chrome" ||
    !node["reality-opts"] ||
    typeof node["reality-opts"] !== "object" ||
    Object.keys(node["reality-opts"]).some((key) => !["public-key", "short-id"].includes(key)) ||
    !/^[\w-]{43}$/.test(node["reality-opts"]["public-key"] || "") ||
    !/^(?:[a-f\d]{2}){1,8}$/i.test(node["reality-opts"]["short-id"] || "")
  )
    throw invalid();
  const proxy = Object.fromEntries(
    Object.entries(node).filter(([key]) => !["alterId", "cipher"].includes(key)),
  );
  return {
    "mixed-port": 17890,
    "allow-lan": false,
    "bind-address": "127.0.0.1",
    mode: "rule",
    "log-level": "silent",
    ipv6: false,
    proxies: [{ ...proxy, name: "wecom-egress" }],
    rules: [
      "DOMAIN,qyapi.weixin.qq.com,wecom-egress",
      "DOMAIN,api.ipify.org,wecom-egress",
      "MATCH,REJECT",
    ],
  };
}

export function verifyProxyArchive(data, expected) {
  if (createHash("sha256").update(data).digest("hex") !== expected)
    throw new Error("微盘代理二进制 SHA256 校验失败");
}

export function proxyEnvironment(env, url = PROXY_URL) {
  const clean = Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !/^(https?_proxy|all_proxy|no_proxy)$/i.test(key) && key !== "WECOM_PROXY_CONFIG",
    ),
  );
  return { ...clean, HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: "", NODE_USE_ENV_PROXY: "1" };
}

async function downloadBinary(directory, signal) {
  const artifact = ARCHIVES[`${process.platform}-${process.arch}`];
  if (!artifact) throw new Error("微盘代理仅支持 Linux x64 或 macOS ARM64 runner");
  const [name, checksum] = artifact;
  let bytes;
  try {
    const response = await fetch(
      `https://github.com/MetaCubeX/mihomo/releases/download/${VERSION}/mihomo-${name}-${VERSION}.gz`,
      {
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        redirect: "follow",
      },
    );
    if (!response.ok) throw new Error();
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new Error("下载固定版本微盘代理失败，停止同步");
  }
  verifyProxyArchive(bytes, checksum);
  const path = join(directory, "mihomo");
  await writeFile(path, await gunzip(bytes, { maxOutputLength: 100 * 1024 ** 2 }), { mode: 0o700 });
  return path;
}

function connect() {
  return new Promise((resolveConnect, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: 17890 });
    socket.setTimeout(200, () => socket.destroy(new Error("timeout")));
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect();
    });
    socket.once("error", reject);
  });
}

async function waitForProxy(child, signal) {
  for (let attempt = 0; attempt < 100; attempt++) {
    signal.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("微盘代理启动失败");
    try {
      await connect();
      return;
    } catch {
      /* 轮询真实监听状态，不能把固定延时当作就绪。 */
    }
    await sleep(100, undefined, { signal });
  }
  throw new Error("微盘代理未能开启本地入口");
}

function decodeProbeResult(raw) {
  const invalid = () => new Error("代理探测响应无效；停止同步，不回退直连");
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 4096) throw invalid();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid();
  const keysAre = (...keys) =>
    Object.keys(data).length === keys.length && keys.every((key) => Object.hasOwn(data, key));
  if (data.ok === true) {
    if (
      !keysAre("ok", "ip") ||
      typeof data.ip !== "string" ||
      data.ip.length > 45 ||
      data.ip.includes("%") ||
      !isIP(data.ip)
    )
      throw invalid();
  } else {
    if (data.ok !== false || !["ip-query", "wecom-api"].includes(data.stage)) throw invalid();
    if (data.kind === "http") {
      if (
        !keysAre("ok", "stage", "kind", "status") ||
        !Number.isInteger(data.status) ||
        data.status < 100 ||
        data.status > 599
      )
        throw invalid();
    } else if (data.kind === "network") {
      if (
        !keysAre("ok", "stage", "kind") &&
        !(keysAre("ok", "stage", "kind", "code") && PROBE_NETWORK_CODES.includes(data.code))
      )
        throw invalid();
    } else if (
      !["timeout", "invalid-response"].includes(data.kind) ||
      !keysAre("ok", "stage", "kind")
    )
      throw invalid();
  }
  return data;
}

export async function probeEgress(env, _child, signal, { execute = execFile } = {}) {
  // 只读探测先于凭据调用。使用新 Node 进程，使内置 fetch 在启动时载入代理设置。
  // 原实现合并了两个阶段的异常且直接解析 stdout；固定分类可定位边界，严格解码避免外露原始错误。
  const source = `
    import { isIP } from 'node:net';
    const networkCodes = new Set(${JSON.stringify(PROBE_NETWORK_CODES)});
    let stage = 'ip-query';
    let result;
    const invalid = () => Object.assign(new Error(), {invalidResponse:true});
    async function json(url) {
      const signal = AbortSignal.timeout(20000);
      try {
        const response = await fetch(url, {signal,redirect:'error'});
        if (!response.ok) throw Object.assign(new Error(), {httpStatus:response.status});
        return await response.json();
      } catch (error) {
        if (signal.aborted && signal.reason?.name === 'TimeoutError') throw signal.reason;
        if (error instanceof SyntaxError) throw invalid();
        throw error;
      }
    }
    try {
      const ip = (await json('https://api.ipify.org?format=json'))?.ip;
      if (typeof ip !== 'string' || ip.length > 45 || ip.includes('%') || !isIP(ip)) throw invalid();
      stage = 'wecom-api';
      if (!Number.isInteger((await json('https://qyapi.weixin.qq.com/cgi-bin/gettoken'))?.errcode)) throw invalid();
      result = {ok:true,ip};
    } catch (error) {
      const code = error?.cause?.code ?? error?.code;
      result = {ok:false,stage,kind:'network'};
      if (error?.httpStatus) result = {ok:false,stage,kind:'http',status:error.httpStatus};
      else if (error?.invalidResponse) result.kind = 'invalid-response';
      else if (error?.name === 'TimeoutError') result.kind = 'timeout';
      else if (networkCodes.has(code)) result.code = code;
    }
    process.stdout.write(JSON.stringify(result));
  `;
  let result;
  try {
    result = await execute(
      process.execPath,
      ["--use-env-proxy", "--input-type=module", "-e", source],
      { env, signal, timeout: 45_000, maxBuffer: 4096 },
    );
  } catch {
    throw new Error("固定代理探测进程失败；停止同步，不回退直连");
  }
  const data = decodeProbeResult(result?.stdout);
  if (!data.ok) {
    const detail =
      data.kind === "http" ? `http=${data.status}` : data.code ? `code=${data.code}` : data.kind;
    throw new Error(`固定代理探测失败（stage=${data.stage}，${detail}）；停止同步，不回退直连`);
  }
  console.log(`固定代理出口已验证：${data.ip}；企业微信 API 连通`);
}

async function runSyncProcess(env, signal) {
  const script = fileURLToPath(
    new URL(
      env.WECOM_BOOTSTRAP_SPACE === "true"
        ? "./wecom-release-bootstrap.mjs"
        : env.WECOM_INSPECT_ONLY === "true"
          ? "./wecom-release-diagnostics.mjs"
          : "./sync-wecom-release.mjs",
      import.meta.url,
    ),
  );
  return new Promise((resolveExit, reject) => {
    const child = spawn(
      process.execPath,
      [...(env.NODE_USE_ENV_PROXY === "1" ? ["--use-env-proxy"] : []), script],
      { env, signal, stdio: "inherit" },
    );
    child.once("error", () => reject(new Error("微盘同步进程启动失败或已取消")));
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

export async function withWecomProxy({
  env = process.env,
  runSync = runSyncProcess,
  resolveBinary = downloadBinary,
  probe = probeEgress,
  probeOnly = false,
} = {}) {
  if (!env.WECOM_PROXY_CONFIG) return probeOnly ? 0 : runSync(env);
  const config = buildProxyConfig(env.WECOM_PROXY_CONFIG);
  const directory = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), "wecom-release-proxy-"));
  await chmod(directory, 0o700);
  const controller = new AbortController();
  let child;
  let closed;
  const cancel = () => {
    controller.abort();
    child?.kill("SIGTERM");
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  try {
    // 避免把机器上已有的代理误认成本次启动的固定出口。
    let occupied = false;
    try {
      await connect();
      occupied = true;
    } catch {
      /* 未监听时才允许启动本次子进程。 */
    }
    if (occupied) throw new Error("微盘代理本地端口已被占用，停止同步");
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const binary = await resolveBinary(directory, controller.signal);
    const childEnv = { ...env };
    for (const key of [
      "WECOM_PROXY_CONFIG",
      "WECOM_SECRET",
      "WECOM_CORP_ID",
      "GH_TOKEN",
      "GITHUB_TOKEN",
    ])
      delete childEnv[key];
    child = spawn(binary, ["-d", directory, "-f", configPath], { env: childEnv, stdio: "ignore" });
    closed = new Promise((resolveClosed) => {
      child.once("close", resolveClosed);
      child.once("error", () => resolveClosed());
    });
    await waitForProxy(child, controller.signal);
    const proxyEnv = proxyEnvironment(env);
    await probe(proxyEnv, child, controller.signal);
    controller.signal.throwIfAborted();
    return probeOnly ? 0 : await runSync(proxyEnv, controller.signal);
  } finally {
    if (child) {
      child.kill("SIGTERM");
      await Promise.race([closed, sleep(3000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await closed;
      }
    }
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await withWecomProxy({ probeOnly: process.argv.includes("--probe-only") });
  } catch (error) {
    console.error(`[wecom-proxy] ${error.message}`);
    process.exitCode = 1;
  }
}

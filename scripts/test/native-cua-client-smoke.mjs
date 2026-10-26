// 本机显式集成验收：真实 CLI / node_repl / SDK / Helper，不调用模型或修改 TCC。
// 使用 node --import tsx 运行 harness，以解析 workspace 的公开 TypeScript 入口；子进程仍运行真实 bundle。
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createProductCuaHelperHost } from "../../packages/zcode-cua/broker-server.js";
import { callBrokerMethod } from "../../packages/zcode-cua/broker.js";
import { createLazyCuaBroker } from "../../packages/zcode-cua/lazy-broker.js";

assert.equal(process.platform, "darwin", "Native CUA client smoke requires macOS");
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  assert.ok(
    ["--agent-root", "--helper-app", "--node"].includes(name) && value,
    "Invalid smoke option",
  );
  options.set(name, value);
}
const agentRoot = resolve(
  options.get("--agent-root") ?? "packages/desktop/bundled-agents/darwin-arm64/glm",
);
const helperApp = resolve(
  options.get("--helper-app") ?? "packages/desktop/dist-cua-helper/ZCode Computer Use Dev.app",
);
const nodePath = resolve(options.get("--node") ?? process.execPath);
const cli = join(agentRoot, "zcode.cjs");
const serverPath = join(agentRoot, "packages/node-repl-host/dist/mcp/server.js");
const pluginRoot = join(agentRoot, "packages/zcode-cua-plugin");
await Promise.all(
  [nodePath, cli, serverPath, join(pluginRoot, "scripts/computer-use-client.mjs"), helperApp].map(
    (path) => access(path),
  ),
);

const directory = await mkdtemp(join(tmpdir(), "uwork-native-client-"));
const cleanEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]]] : [],
  ),
);
const host = createProductCuaHelperHost({
  env: {
    ...cleanEnv,
    ZCODE_STORAGE_DIR: join(directory, ".uwork"),
    ZCODE_CUA_HELPER_INSTALL_VARIANT: "native-client-smoke",
    ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
    ZCODE_RUNTIME_ENV: "development",
  },
  bundledHelperAppPath: helperApp,
  healthTimeoutMs: 10_000,
});
let helper;
let resolveCalls = 0;
const discovery = createLazyCuaBroker({
  resolveTransport: async () => {
    resolveCalls += 1;
    helper = await host.start();
    return { socketPath: helper.socketPath, pluginAuthority: helper.pluginAuthority };
  },
});
const transport = new StdioClientTransport({
  command: nodePath,
  args: [cli, "__zcode-plugin-host", serverPath],
  cwd: directory,
  env: {
    ...cleanEnv,
    ZCODE_STORAGE_DIR: join(directory, ".uwork"),
    ZCODE_PLUGIN_ID: "computer-use@zcode-plugins-official",
    ZCODE_CUA_NODE_REPL_HOST: "1",
    ZCODE_CUA_PLUGIN_ROOT: pluginRoot,
    ZCODE_CUA_PERMISSION_BROKER_SOCKET: discovery.socketPath,
    ZCODE_CUA_PLUGIN_AUTHORITY: discovery.pluginAuthority,
  },
  stderr: "pipe",
});
const client = new Client(
  { name: "uwork-native-client-smoke", version: "0.1.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
let stderr = "";
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-64 * 1024);
});
const meta = (overrides = {}) => ({
  "com.zcode/request-context": {
    runtime_scope: "main",
    session_id: "native-client-smoke",
    turn_id: "native-client-smoke-turn",
    workspace_path: directory,
    workspace_key: directory,
    workspace_identity: "local:native-client-smoke",
    client_mode: "desktop-continuous",
    delivery_kind: "desktop-continuous",
    ...overrides,
  },
});
// 使用公开 SDK，每次 fresh Worker 都完整 bootstrap；仅返回计数，不输出真实应用名。
const code = [
  "const root = process.env.ZCODE_CUA_PLUGIN_ROOT;",
  'const { join } = await import("node:path");',
  'const { pathToFileURL } = await import("node:url");',
  'const { setupComputerUseRuntime } = await import(pathToFileURL(join(root, "scripts", "computer-use-client.mjs")).href);',
  "await setupComputerUseRuntime({ globals: globalThis });",
  "const apps = await agent.computerUse.listApps({ emit: false });",
  'nodeRepl.write(JSON.stringify({ smoke: "native-client", observedApps: apps.length }));',
].join("\n");
try {
  await discovery.ready;
  await client.connect(transport);
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["js"],
  );
  const ordinary = await client.callTool({
    name: "js",
    arguments: { code: "21 * 2;", title: "验证工具启动" },
    _meta: meta(),
  });
  assert.notEqual(ordinary.isError, true, "Built CLI must serve ordinary node_repl calls");
  assert.equal(resolveCalls, 0, "MCP initialization and ordinary JS must keep Helper lazy");
  const subagent = await client.callTool({
    name: "js",
    arguments: { code, title: "验证子智能体隔离" },
    _meta: meta({ runtime_scope: "subagent" }),
  });
  assert.equal(subagent.isError, true, "Subagent Computer Use must be denied");
  assert.equal(resolveCalls, 0, "Denied subagent must not resolve Helper transport");
  const remote = await client.callTool({
    name: "js",
    arguments: { code, title: "验证远程工作区隔离" },
    _meta: meta({
      workspace_identity: "remote:ssh:fixture:22:user:/workspace",
      remote_session_id: "remote-fixture",
    }),
  });
  assert.equal(remote.isError, true, "Remote Computer Use must be denied");
  assert.equal(resolveCalls, 0, "Denied remote call must not resolve Helper transport");
  const result = await client.callTool(
    { name: "js", arguments: { code, title: "验证本机应用枚举" }, _meta: meta() },
    undefined,
    { timeout: 30_000 },
  );
  assert.notEqual(result.isError, true, "Trusted main desktop call must reach the real Helper");
  const summary = result.content
    .filter((block) => block.type === "text")
    .flatMap((block) => block.text.split("\n"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .find((value) => value?.smoke === "native-client");
  assert.ok(Number.isInteger(summary?.observedApps) && summary.observedApps > 0);
  assert.equal(resolveCalls, 1, "Only the actual main Computer Use call resolves transport");
  assert.equal(helper?.bundleId, "dev.zcode.cua-helper.dev");
  process.stdout.write(
    `${JSON.stringify({ observedApps: summary.observedApps, protocol: client.getNegotiatedProtocolVersion(), actualCli: true, actualNodeRepl: true, actualHelper: true, discoveryCalls: resolveCalls, subagentDenied: true, remoteDenied: true, modelCalls: 0, screenshots: 0, inputActions: 0 })}\n`,
  );
} catch (error) {
  // 失败诊断不得把本地随机 authority 输出到日志。
  const redacted = stderr
    .replaceAll(discovery.pluginAuthority, "[redacted]")
    .replaceAll(helper?.pluginAuthority ?? "__no-helper-authority__", "[redacted]");
  throw new Error(`${error.message}${redacted ? `\nCLI stderr:\n${redacted}` : ""}`, {
    cause: error,
  });
} finally {
  await client.close().catch(() => {});
  await discovery.close();
  if (helper)
    await callBrokerMethod({
      socketPath: helper.socketPath,
      method: "shutdown",
      token: helper.pluginAuthority,
    }).catch(() => {});
  await host.stop();
  if (helper) await rm(dirname(helper.socketPath), { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
}

import { createServer, type Server } from "node:net";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProductCuaHelperHost } from "../broker-server.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function fixture(
  onLaunched?: () => Promise<void>,
  freshStatus: Record<string, unknown> = { accessibility: true, screenRecording: false },
) {
  const dir = await mkdtemp(join(tmpdir(), "uwch-"));
  const socketPath = join(dir, "broker.sock");
  const token = "b".repeat(64);
  let server: Server | undefined;
  let launches = 0;
  let installs = 0;
  const env = {
    HOME: dir,
    ZCODE_CUA_PERMISSION_BROKER_SOCKET: socketPath,
    ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
    ZCODE_RUNTIME_ENV: undefined as string | undefined,
  };
  const launchArgs: string[][] = [];
  const requestLog: string[] = [];
  const preflightPaths: string[] = [];
  const host = createProductCuaHelperHost({
    env,
    helperInstaller: {
      ensureInstalled: async () => {
        installs++;
        return "/fixture/Helper.app";
      },
      verifyInstalled: async () => {},
    },
    healthTimeoutMs: 1000,
    launchHelper: async (_appPath, args) => {
      launchArgs.push(args);
      const statusIndex = args.indexOf("--permission-status-file");
      if (statusIndex >= 0) {
        preflightPaths.push(args[statusIndex + 1]);
        await writeFile(args[statusIndex + 1], JSON.stringify(freshStatus));
        return;
      }
      launches++;
      await writeFile(`${socketPath}.authority`, token, { mode: 0o600 });
      server = createServer((socket) => {
        let data = "";
        socket.on("data", (chunk) => {
          data += chunk.toString();
          if (!data.includes("\n")) return;
          const request = JSON.parse(data.slice(0, data.indexOf("\n")));
          requestLog.push(request.method);
          const result =
            request.method === "ping"
              ? { bundleId: "dev.zcode.cua-helper", pid: process.pid }
              : {
                  grant_owner: "dev.zcode.cua-helper",
                  accessibility: "denied",
                  screen_recording: "denied",
                };
          socket.end(`${JSON.stringify({ ok: true, result })}\n`);
          if (request.method === "shutdown") server?.close();
        });
      });
      await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
      await onLaunched?.();
    },
  });
  cleanup.push(async () => {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    host,
    env,
    launchArgs,
    socketPath,
    token,
    requestLog,
    preflightPaths,
    counts: () => ({ launches, installs }),
    isListening: () => server?.listening,
    idleExit: async () => {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    },
  };
}

it("并发 start 只安装/启动一次并读取 Helper 生成的真实 authority", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.host.start(), f.host.start()]);
  expect(a).toEqual(b);
  expect(a.pluginAuthority).toBe(f.token);
  expect(f.counts()).toEqual({ installs: 1, launches: 1 });
  expect(f.host.running).toBe(true);
  expect(f.launchArgs[0]).toContain("--allow-unsigned-launcher-local-dev");
  expect(f.launchArgs[0]).toContain("--allow-external-broker-client-local-dev");
});

it("production runtime 即使收到 unsigned-local 环境变量也不带 peer 例外 argv", async () => {
  const f = await fixture();
  f.env.ZCODE_RUNTIME_ENV = "production";
  await f.host.start();
  expect(f.launchArgs[0]).not.toContain("--allow-unsigned-launcher-local-dev");
  expect(f.launchArgs[0]).not.toContain("--allow-external-broker-client-local-dev");
});

it("Helper idle 自退后显式权限查询在请求边缘单飞恢复并保留 authority", async () => {
  const f = await fixture();
  await f.host.start();
  await f.idleExit();
  expect(f.host.running).toBe(true);
  const [first, second] = await Promise.all([
    f.host.queryPermissionStatus(),
    f.host.queryPermissionStatus(),
  ]);
  expect(first).toMatchObject({ accessibility: "denied", screen_recording: "denied" });
  expect(second).toEqual(first);
  expect(f.counts().launches).toBe(2);
  expect(f.host.pluginAuthority).toBe(f.token);
});

it("dispose 穿过 launch 时不重新绑定当前 Host，也不回收其他窗口共享的 Helper", async () => {
  let release!: () => void;
  let markLaunched!: () => void;
  const launched = new Promise<void>((resolve) => {
    markLaunched = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async () => {
    markLaunched();
    await gate;
  });
  const startup = f.host.start();
  const failed = expect(startup).rejects.toThrow(/disposed/i);
  await launched;
  const stopping = f.host.stop();
  release();
  await stopping;
  await failed;
  expect(f.requestLog).not.toContain("shutdown");
  expect(f.host.running).toBe(false);
  expect(f.isListening()).toBe(true);
});

it("一个窗口 detach 后另一个窗口仍能查询共享 Helper 的权限", async () => {
  const f = await fixture();
  await f.host.start();
  const other = createProductCuaHelperHost({
    env: f.env,
    helperInstaller: {
      ensureInstalled: async () => "/fixture/Helper.app",
      verifyInstalled: async () => {},
    },
  });
  await other.start();
  await f.host.stop();
  await expect(other.queryPermissionStatus()).resolves.toMatchObject({
    accessibility: "denied",
    screen_recording: "denied",
  });
  expect(f.requestLog).not.toContain("shutdown");
  expect(other.running).toBe(true);
});

it("detach 后显式 restart 仍执行物理重启并保留 transport", async () => {
  const f = await fixture();
  await f.host.start();
  await f.host.stop();
  await expect(f.host.restart()).resolves.toMatchObject({
    socketPath: f.socketPath,
    pluginAuthority: f.token,
  });
  expect(f.requestLog.filter((method) => method === "shutdown")).toHaveLength(1);
  expect(f.counts().launches).toBe(2);
});

it("重启保留 socket 与 authority 并通过 shutdown 等待旧进程退出", async () => {
  const f = await fixture();
  await f.host.start();
  const result = await f.host.restartAfterCurrentStartPreservingTransport!();
  expect(result).toMatchObject({
    reused: true,
    handle: { socketPath: f.socketPath, pluginAuthority: f.token },
  });
  expect(f.counts().launches).toBe(2);
  expect(f.requestLog.filter((method) => method === "shutdown")).toHaveLength(1);
});

it("权限预检使用独立短命进程结果，不读取常驻 Helper 的缓存", async () => {
  const f = await fixture();
  await f.host.start();
  await expect(f.host.queryScreenRecordingPreflight()).resolves.toBe("denied");
  expect(f.preflightPaths).toHaveLength(1);
  await expect(readFile(f.preflightPaths[0])).rejects.toMatchObject({ code: "ENOENT" });
});

it("完整fresh权限只经LS新实例等待退出，不继承直接exec责任身份或等待常驻Helper", async () => {
  const f = await fixture();
  await f.host.start();
  await expect(f.host.queryPermissionStatusFresh()).resolves.toEqual({
    accessibility: "granted",
    screen_recording: "denied",
  });
  const freshArgs = f.launchArgs.find((args) => args.includes("--permission-status-file"))!;
  expect(freshArgs.slice(0, 5)).toEqual(["-n", "-W", "-g", "-a", "/fixture/Helper.app"]);
  expect(freshArgs).not.toContain("--socket");
  expect(f.launchArgs[0]).not.toContain("-W");
  expect(f.requestLog).not.toContain("shutdown");
  expect(f.isListening()).toBe(true);
});

it("fresh缺少AX字段不能只凭Screen字段伪造完整授权，临时文件仍清理", async () => {
  const f = await fixture(undefined, { screenRecording: true });
  await expect(f.host.queryPermissionStatusFresh()).rejects.toThrow(/invalid/i);
  await expect(readFile(f.preflightPaths[0])).rejects.toMatchObject({ code: "ENOENT" });
});

it("authority 权限过宽时 Host 不接管 broker", async () => {
  const f = await fixture();
  await f.host.start();
  await chmod(`${f.socketPath}.authority`, 0o644);
  const next = createProductCuaHelperHost({
    env: { ZCODE_CUA_PERMISSION_BROKER_SOCKET: f.socketPath },
    helperInstaller: {
      ensureInstalled: async () => "/fixture/Helper.app",
      verifyInstalled: async () => {},
    },
    healthTimeoutMs: 1000,
  });
  await expect(next.start()).rejects.toThrow(/private/i);
});

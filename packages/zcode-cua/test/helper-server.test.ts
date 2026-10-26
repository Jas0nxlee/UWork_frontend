import { connect } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, lstat, symlink, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCuaHelperServer } from "../helper-server.js";

const servers: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup(runtimeOverrides = {}, serverOverrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "uwork-helper-socket-"));
  directories.push(dir);
  const runtime = {
    execute: vi.fn(async (input) => ({ context: input.context })),
    closeSession: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    ...runtimeOverrides,
  };
  const server = await createCuaHelperServer({
    socketPath: join(dir, "helper.sock"),
    runtime,
    authorizePeer: async () => {},
    readPermissions: () => ({ accessibility: true, screenRecording: false }),
    ...serverOverrides,
  });
  servers.push(server);
  return { dir, runtime, server, token: (await readFile(server.tokenPath, "utf8")).trim() };
}

function request(socketPath: string, value: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = "";
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\n")) {
        socket.destroy();
        resolve(JSON.parse(response.split("\n")[0]));
      }
    });
  });
}

describe("independent Helper socket authority", () => {
  it("fails closed when no native peer verifier was configured", async () => {
    const { server, token, runtime } = await setup({}, { authorizePeer: undefined });
    expect(
      await request(server.socketPath, { method: "execute", token, params: { context: {} } }),
    ).toMatchObject({ ok: false, error: { code: "not_authorized", actionSent: false } });
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("requires a verified peer even when the caller knows the authority", async () => {
    const authorizePeer = vi.fn(async () => {
      throw Object.assign(new Error("Untrusted peer"), { code: "not_authorized" });
    });
    const { server, token, runtime } = await setup({}, { authorizePeer });
    for (const method of ["execute", "close_session", "shutdown"]) {
      expect(
        await request(server.socketPath, { method, token, params: { context: {} } }),
      ).toMatchObject({ ok: false, error: { code: "not_authorized" } });
    }
    expect(authorizePeer).toHaveBeenCalledTimes(3);
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(runtime.closeSession).not.toHaveBeenCalled();
    expect(runtime.dispose).not.toHaveBeenCalled();
    expect(await request(server.socketPath, { method: "ping" })).toMatchObject({ ok: true });
  });

  it("preserves possibly-sent status and details when native execution throws", async () => {
    const { server, token } = await setup({
      execute: vi.fn(async () => {
        throw Object.assign(new Error("Native call was canceled"), {
          code: "aborted",
          details: { stage: "native" },
        });
      }),
    });
    expect(
      await request(server.socketPath, { method: "execute", token, params: { context: {} } }),
    ).toMatchObject({
      ok: false,
      error: { code: "aborted", actionSent: true, details: { stage: "native" } },
    });
  });

  it("reports only aggregate in-flight activity for valid request frames", async () => {
    const onRequestActivity = vi.fn();
    const { server } = await setup({}, { onRequestActivity });
    await request(server.socketPath, { method: "ping" });
    await request(server.socketPath, { method: "unknown" });
    expect(onRequestActivity.mock.calls).toEqual([[{ inflight: 1 }], [{ inflight: 0 }]]);
  });
  it("exposes only identity and read-only TCC status without authority", async () => {
    const { server, runtime, token } = await setup();
    expect(await request(server.socketPath, { id: "ping", method: "ping" })).toMatchObject({
      id: "ping",
      ok: true,
      result: { bundleId: "dev.zcode.cua-helper", pid: process.pid },
    });
    expect(await request(server.socketPath, { method: "permission_status" })).toMatchObject({
      ok: true,
      result: {
        accessibility: "granted",
        screen_recording: "denied",
        accessibility_probe_ok: false,
      },
    });
    expect(await request(server.socketPath, { method: "execute", params: {} })).toMatchObject({
      ok: false,
      error: { code: "not_authorized" },
    });
    expect(
      await request(server.socketPath, {
        method: "close_session",
        token: token.slice(2),
        params: {},
      }),
    ).toMatchObject({ ok: false, error: { code: "not_authorized" } });
    expect(await request(server.socketPath, { method: "shutdown" })).toMatchObject({
      ok: false,
      error: { code: "not_authorized" },
    });
    expect(runtime.execute).not.toHaveBeenCalled();
    expect(runtime.closeSession).not.toHaveBeenCalled();
  });

  it("uses private socket/authority files and replaces serialized signals with connection cancellation", async () => {
    const { server, runtime, token, dir } = await setup();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(server.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(server.tokenPath)).mode & 0o777).toBe(0o600);
    const context = {
      sessionId: "session",
      workspaceIdentity: "workspace",
      runtimeScope: "main",
      deliveryKind: "desktop-continuous",
    };
    expect(
      await request(server.socketPath, {
        method: "execute",
        token,
        params: { toolName: "list_apps", context, signal: "forged" },
      }),
    ).toMatchObject({ ok: true, result: { context } });
    expect(runtime.execute.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    await request(server.socketPath, { method: "close_session", token, params: { context } });
    expect(runtime.closeSession).toHaveBeenCalledWith(context);
    await server.close();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    await expect(lstat(server.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(server.tokenPath, "utf8")).trim()).toBe(token);
    const restarted = await createCuaHelperServer({
      socketPath: server.socketPath,
      runtime,
      authorizePeer: async () => {},
      readPermissions: () => ({ accessibility: true, screenRecording: false }),
    });
    servers.push(restarted);
    expect((await readFile(restarted.tokenPath, "utf8")).trim()).toBe(token);
    expect(
      await request(restarted.socketPath, { method: "execute", token, params: { context } }),
    ).toMatchObject({ ok: true });
  });

  it("rejects malformed or oversized frames without terminating other clients", async () => {
    const { server } = await setup();
    expect(
      await request(server.socketPath, { method: "eval", params: "process.exit()" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(
      await request(server.socketPath, { method: "ping", params: "x".repeat(1024 * 1024) }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await request(server.socketPath, null)).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(await request(server.socketPath, { method: "ping" })).toMatchObject({ ok: true });
  });

  it("refuses existing files and symlink paths instead of replacing them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uwork-helper-existing-"));
    directories.push(dir);
    const path = join(dir, "helper.sock");
    await writeFile(path, "preserve");
    const options = {
      socketPath: path,
      runtime: { dispose: async () => {} },
      readPermissions: () => ({ accessibility: false, screenRecording: false }),
    };
    await expect(createCuaHelperServer(options)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("preserve");
    const link = join(dir, "link.sock");
    await symlink(path, link);
    await expect(createCuaHelperServer({ ...options, socketPath: link })).rejects.toThrow();
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it("recovers a socket left by a crashed Helper without rotating its authority", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uwork-helper-crash-"));
    directories.push(dir);
    const socketPath = join(dir, "helper.sock");
    const token = "c".repeat(64);
    await writeFile(`${socketPath}.authority`, token, { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { createServer } from "node:net"; createServer().listen(process.argv[1], () => process.stdout.write("ready"));',
        socketPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => resolve());
        child.once("exit", (code) =>
          reject(new Error(`Socket fixture exited before readiness: ${code}`)),
        );
      });
      child.kill("SIGKILL");
      await exited;
      expect((await lstat(socketPath)).isSocket()).toBe(true);
      const recovered = await createCuaHelperServer({
        socketPath,
        runtime: { dispose: async () => {} },
        readPermissions: () => ({ accessibility: false, screenRecording: false }),
      });
      servers.push(recovered);
      expect((await readFile(recovered.tokenPath, "utf8")).trim()).toBe(token);
      expect(await request(socketPath, { method: "ping" })).toMatchObject({ ok: true });
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("never replaces an active Helper socket during concurrent startup", async () => {
    const { server } = await setup();
    const before = await lstat(server.socketPath);
    await expect(
      createCuaHelperServer({
        socketPath: server.socketPath,
        runtime: { dispose: async () => {} },
        readPermissions: () => ({ accessibility: false, screenRecording: false }),
      }),
    ).rejects.toThrow();
    const after = await lstat(server.socketPath);
    expect({ ino: after.ino, dev: after.dev }).toEqual({ ino: before.ino, dev: before.dev });
    expect(await request(server.socketPath, { method: "ping" })).toMatchObject({ ok: true });
  });

  it("sends authenticated shutdown acknowledgement then disposes once", async () => {
    const { server, token, runtime } = await setup();
    expect(await request(server.socketPath, { id: 4, method: "shutdown", token })).toMatchObject({
      id: 4,
      ok: true,
    });
    await vi.waitFor(() => expect(runtime.dispose).toHaveBeenCalledTimes(1));
  });

  it("cancels in-flight execution when its authenticated client disconnects", async () => {
    let signal: AbortSignal | undefined;
    const { server, token } = await setup({
      execute: vi.fn((input) => {
        signal = input.signal;
        return new Promise((resolve) =>
          input.signal.addEventListener("abort", () => resolve({ canceled: true }), { once: true }),
        );
      }),
    });
    const socket = connect(server.socketPath);
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    socket.write(`${JSON.stringify({ method: "execute", token, params: { context: {} } })}\n`);
    await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    socket.destroy();
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("refuses unsafe existing authority instead of rotating or trusting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uwork-helper-authority-"));
    directories.push(dir);
    const socketPath = join(dir, "helper.sock");
    const tokenPath = `${socketPath}.authority`;
    await writeFile(tokenPath, "a".repeat(64), { mode: 0o644 });
    const options = {
      socketPath,
      runtime: { dispose: async () => {} },
      readPermissions: () => ({ accessibility: false, screenRecording: false }),
    };
    await expect(createCuaHelperServer(options)).rejects.toThrow("0600");
    await chmod(tokenPath, 0o600);
    await writeFile(tokenPath, "malformed");
    await expect(createCuaHelperServer(options)).rejects.toThrow("malformed");
    expect(await readFile(tokenPath, "utf8")).toBe("malformed");
    await rm(tokenPath);
    const other = join(dir, "other");
    await writeFile(other, "a".repeat(64), { mode: 0o600 });
    await symlink(other, tokenPath);
    await expect(createCuaHelperServer(options)).rejects.toThrow("0600");
    expect((await lstat(tokenPath)).isSymbolicLink()).toBe(true);
  });
});

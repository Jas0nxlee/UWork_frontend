import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  scheduleCuaHelperIdleClose,
  startCuaHelper,
  trackCuaRuntimeActivity,
} from "../helper-entry.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SEA Helper entry", () => {
  it("keeps the native operation alive after its broker response has timed out", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    const idle = scheduleCuaHelperIdleClose({ close, idleTimeoutMs: 20 });
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let nativeInflight = 0;
    const runtime = trackCuaRuntimeActivity(
      {
        execute: () => operation,
        closeSession: async () => {},
        dispose: async () => {},
      },
      (inflight: number) => {
        nativeInflight = inflight;
        idle.onRequestActivity({ inflight });
      },
    );
    const pending = runtime.execute({});
    // broker 的超时响应已发完，但原生 Promise 尚未真正结束。
    expect(nativeInflight).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(close).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(nativeInflight).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes after 300s without requests and resets from the final in-flight request", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    const idle = scheduleCuaHelperIdleClose({ close });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(close).not.toHaveBeenCalled();
    idle.onRequestActivity({ inflight: 2 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(close).not.toHaveBeenCalled();
    idle.onRequestActivity({ inflight: 1 });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(close).not.toHaveBeenCalled();
    idle.onRequestActivity({ inflight: 0 });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("supports a bounded test idle interval and cancels timers on explicit close", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    const idle = scheduleCuaHelperIdleClose({ close, idleTimeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(19);
    idle.onRequestActivity({ inflight: 0 });
    await vi.advanceTimersByTimeAsync(19);
    expect(close).not.toHaveBeenCalled();
    idle.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(close).not.toHaveBeenCalled();
  });

  it("reports the development app identity from its compiled build mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "uwork-helper-entry-"));
    roots.push(root);
    const socketPath = join(root, "helper.sock");
    const helper = await startCuaHelper({
      argv: ["--socket", socketPath],
      development: true,
      loadSdk: () => ({
        currentMacOsPermissionStatus: () => ({ accessibility: false, screenRecording: false }),
      }),
    });
    try {
      const response = await new Promise<any>((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once("error", reject);
        socket.once("connect", () => socket.write('{"method":"ping"}\n'));
        socket.once("data", (chunk) => {
          socket.destroy();
          resolve(JSON.parse(String(chunk)));
        });
      });
      expect(response.result.bundleId).toBe("dev.zcode.cua-helper.dev");
    } finally {
      await helper.close();
    }
  });

  it("writes a fresh no-prompt permission snapshot without starting driver/socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "uwork-helper-entry-"));
    roots.push(root);
    const output = join(root, "status.json");
    const requestPermissions = vi.fn();
    const createDriver = vi.fn();
    await startCuaHelper({
      argv: ["--permission-status-file", output],
      loadSdk: () => ({
        currentMacOsPermissionStatus: () => ({ accessibility: false, screenRecording: true }),
        requestMacOsPermissions: requestPermissions,
        CuaDriver: { create: createDriver },
      }),
    });
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      accessibility: false,
      screenRecording: true,
    });
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(createDriver).not.toHaveBeenCalled();
  });

  it("refuses invalid native permission values instead of inventing denied", async () => {
    const root = await mkdtemp(join(tmpdir(), "uwork-helper-entry-"));
    roots.push(root);
    await expect(
      startCuaHelper({
        argv: ["--permission-status-file", join(root, "status.json")],
        loadSdk: () => ({
          currentMacOsPermissionStatus: () => ({ accessibility: null, screenRecording: true }),
        }),
      }),
    ).rejects.toThrow(/permission snapshot/);
  });
});

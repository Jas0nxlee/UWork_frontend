import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { createLazyCuaBroker } from "../lazy-broker.js";
import { callBrokerMethod } from "../broker.js";

const context = {
  sessionId: "a",
  workspaceKey: "/tmp/workspace",
  runtimeScope: "main",
  deliveryKind: "desktop-continuous",
};
describe("Host CUA transport discovery", () => {
  it("rejects actions even with discovery authority; the Helper must see the actual caller", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ucl-"));
    const target = join(directory, "helper.sock");
    let received = 0;
    const upstream = createServer((socket) =>
      socket.once("data", () => {
        received++;
        socket.end(`${JSON.stringify({ ok: true, result: {} })}\n`);
      }),
    );
    await new Promise<void>((resolve) => upstream.listen(target, resolve));
    let starts = 0;
    const broker = createLazyCuaBroker({
      resolveTransport: async () => {
        starts++;
        return { socketPath: target, pluginAuthority: "helper-token" };
      },
    });
    try {
      await broker.ready;
      for (const method of ["execute", "close_session", "shutdown"]) {
        await expect(
          callBrokerMethod({
            socketPath: broker.socketPath,
            method,
            token: broker.pluginAuthority,
            params: { toolName: "left_click", context },
          }),
        ).rejects.toMatchObject({ code: "invalid_request", actionSent: false });
      }
      expect(starts).toBe(0);
      expect(received).toBe(0);
    } finally {
      await broker.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("only authenticated local discovery starts Helper, without forwarding any action", async () => {
    let starts = 0;
    const broker = createLazyCuaBroker({
      resolveTransport: async () => {
        starts++;
        return { socketPath: "/private/helper.sock", pluginAuthority: "helper-token", pid: 123 };
      },
    });
    try {
      await broker.ready;
      await expect(
        callBrokerMethod({
          socketPath: broker.socketPath,
          method: "resolve_transport",
          token: "incorrect",
          params: { context },
        }),
      ).rejects.toThrow();
      expect(starts).toBe(0);
      const result = await callBrokerMethod({
        socketPath: broker.socketPath,
        method: "resolve_transport",
        token: broker.pluginAuthority,
        params: { context },
      });
      expect(result).toEqual({
        socketPath: "/private/helper.sock",
        pluginAuthority: "helper-token",
      });
      expect(starts).toBe(1);
      await expect(
        callBrokerMethod({
          socketPath: broker.socketPath,
          method: "resolve_transport",
          token: broker.pluginAuthority,
          params: { context: { ...context, runtimeScope: "subagent" } },
        }),
      ).rejects.toThrow();
      expect(starts).toBe(1);
    } finally {
      await broker.close();
    }
  });
});

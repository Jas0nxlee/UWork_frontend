import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { isRemoteWorkspaceIdentity } from "@zcode/shared";

/** Host 只提供连接发现；动作由 node_repl 直连 Helper，保留真实内核 peer。 */
export function createLazyCuaBroker({ resolveTransport }) {
  const suffix = randomBytes(12).toString("hex");
  const directory = `/tmp/uwcb-${process.getuid?.() ?? "user"}-${suffix}`;
  const socketPath = join(directory, "broker.sock");
  const pluginAuthority = randomBytes(32).toString("hex");
  const active = new Set();
  let closed = false;
  const server = createServer((socket) => {
    active.add(socket);
    socket.once("close", () => active.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(30_000, () => socket.destroy());
    let buffer = "";
    let admitted = false;
    socket.on("data", (chunk) => {
      if (admitted) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      admitted = true;
      const abort = new AbortController();
      socket.once("close", () => abort.abort());
      void dispatch(buffer.slice(0, newline), abort.signal).then(
        (result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`),
        (error) =>
          socket.end(
            `${JSON.stringify({ ok: false, error: { code: error.code ?? "broker_unavailable", message: error.message, actionSent: error.actionSent === true, details: error.details } })}\n`,
          ),
      );
    });
  });
  async function dispatch(line, signal) {
    const request = JSON.parse(line);
    const provided =
      typeof request.token === "string" ? Buffer.from(request.token) : Buffer.alloc(0);
    const expected = Buffer.from(pluginAuthority);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
      throw new Error("Computer Use request is not authorized");
    if (closed) throw new Error("Computer Use Host is disposed");
    if (request.method !== "resolve_transport")
      throw Object.assign(new Error("Host broker only provides connection metadata"), {
        code: "invalid_request",
      });
    const context = request.params?.context;
    if (
      !context ||
      context.runtimeScope !== "main" ||
      (context.deliveryKind ?? context.clientMode) !== "desktop-continuous" ||
      context.remoteSessionId?.trim() ||
      (context.workspaceIdentity && isRemoteWorkspaceIdentity(context.workspaceIdentity))
    ) {
      throw new Error("Computer Use requires a local desktop main session");
    }
    const transport = await resolveTransport(context);
    if (signal.aborted || closed) throw new Error("Computer Use request was canceled");
    if (!transport?.socketPath || !transport?.pluginAuthority)
      throw new Error("Computer Use Helper is unavailable");
    return { socketPath: transport.socketPath, pluginAuthority: transport.pluginAuthority };
  }
  const ready = (async () => {
    await mkdir(directory, { mode: 0o700 });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    server.unref();
  })();
  // ready 的失败只使本能力不可用，不允许未处理拒绝中断普通 Agent 启动。
  void ready.catch(() => {});
  return {
    socketPath,
    pluginAuthority,
    ready,
    async close() {
      closed = true;
      await ready.catch(() => {});
      for (const socket of active) socket.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

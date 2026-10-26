import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { HELPER_BUNDLE_ID, HELPER_DISPLAY_NAME } from "./broker-helper-constants.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const PROTECTED_METHODS = new Set(["execute", "close_session", "shutdown"]);
const ALL_METHODS = new Set(["ping", "permission_status", ...PROTECTED_METHODS]);

function fail(message, code = "invalid_request") {
  return Object.assign(new Error(message), { code });
}

function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function removeOwned(path, identity) {
  if (!identity) return;
  try {
    if (sameFile(identity, await lstat(path))) await unlink(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function prepareSocketPath(path, directoryIdentity) {
  let previous;
  try {
    previous = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    !previous.isSocket() ||
    previous.isSymbolicLink() ||
    (process.getuid && previous.uid !== process.getuid())
  )
    throw fail("Helper socket path is not an owned socket; refusing to replace it.");
  // 崩溃/SIGKILL 不会清理 Unix socket；仅明确拒绝连接才证明旧 listener 已消失。
  // 活跃连接、超时或其他错误都不能作为删除依据，避免并发启动拆掉仍在工作的 Helper。
  await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(fail("Existing Helper socket could not be verified inactive."));
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      reject(fail("Helper socket is still active; refusing to replace it."));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve();
      else reject(fail("Existing Helper socket could not be verified inactive."));
    });
  });
  const [current, currentDirectory] = await Promise.all([lstat(path), lstat(dirname(path))]);
  if (
    !sameFile(previous, current) ||
    !current.isSocket() ||
    !sameFile(directoryIdentity, currentDirectory) ||
    !currentDirectory.isDirectory() ||
    (currentDirectory.mode & 0o777) !== 0o700 ||
    (process.getuid &&
      (current.uid !== process.getuid() || currentDirectory.uid !== process.getuid()))
  )
    throw fail("Helper socket changed during recovery; refusing to replace it.");
  await unlink(path);
}

async function readOrCreateAuthority(tokenPath) {
  let file;
  try {
    file = await open(tokenPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await file.writeFile(randomBytes(32).toString("hex"));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally {
    await file?.close();
  }
  // 重启必须保留同一 authority；只从私有普通文件读取，绝不跟随符号链接或接受客户端覆写。
  const before = await lstat(tokenPath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > 65 ||
    (before.mode & 0o777) !== 0o600 ||
    (process.getuid && before.uid !== process.getuid())
  ) {
    throw fail("Helper authority must be an owned regular file with mode 0600.", "not_authorized");
  }
  const handle = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(before, await handle.stat()))
      throw fail("Helper authority changed while opening.", "not_authorized");
    const value = (await handle.readFile("utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(value))
      throw fail("Helper authority is malformed.", "not_authorized");
    return { value, identity: before };
  } finally {
    await handle.close();
  }
}

/** Only this independent Helper process owns native execution and TCC reads. */
export async function createCuaHelperServer({
  socketPath,
  tokenPath = `${socketPath}.authority`,
  runtime,
  readPermissions,
  bundleId = HELPER_BUNDLE_ID,
  displayName = HELPER_DISPLAY_NAME,
  preserveAuthority = true,
  authorizePeer = async () => {
    throw fail("Helper peer verification is unavailable.", "not_authorized");
  },
  onRequestActivity,
}) {
  if (!isAbsolute(socketPath) || dirname(tokenPath) !== dirname(socketPath)) {
    throw fail("Helper socket and authority must share an absolute private directory.");
  }
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (directoryStat.mode & 0o777) !== 0o700 ||
    (process.getuid && directoryStat.uid !== process.getuid())
  ) {
    throw fail(
      "Helper socket directory must be owned, non-symlink and mode 0700.",
      "not_authorized",
    );
  }
  await prepareSocketPath(socketPath, directoryStat);
  const authority = await readOrCreateAuthority(tokenPath);
  const clients = new Set();
  let socketIdentity;
  let closing;
  let inflight = 0;
  const server = createServer((socket) => {
    clients.add(socket);
    const controllers = new Set();
    let buffer = "";
    let executing = 0;
    const respond = (response, end = false, callback) => {
      if (socket.destroyed) return;
      const line = `${JSON.stringify(response)}\n`;
      if (end) socket.end(line, callback);
      else socket.write(line);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => {
      respond(
        {
          ok: false,
          error: {
            code: "timeout",
            message: "Helper request timed out.",
            actionSent: executing > 0,
          },
        },
        true,
      );
      for (const controller of controllers) controller.abort();
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clients.delete(socket);
      for (const controller of controllers) controller.abort();
    });
    const dispatch = async (line) => {
      const controller = new AbortController();
      controllers.add(controller);
      let id;
      let timer;
      let counted = false;
      let executionEntered = false;
      let peerDenied = false;
      try {
        if (Buffer.byteLength(line) > MAX_REQUEST_BYTES)
          throw fail("Helper request exceeds size limit.");
        const request = JSON.parse(line);
        if (
          !request ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          !ALL_METHODS.has(request.method)
        )
          throw fail("Unknown or malformed Helper request.");
        counted = true;
        onRequestActivity?.({ inflight: ++inflight });
        id = request.id;
        if (id !== undefined && typeof id !== "string" && typeof id !== "number" && id !== null)
          throw fail("Invalid Helper request id.");
        if (PROTECTED_METHODS.has(request.method)) {
          const token = typeof request.token === "string" ? request.token : "";
          if (
            !/^[a-f0-9]{64}$/.test(token) ||
            !timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(authority.value, "hex"))
          )
            throw fail("Helper authority is required.", "not_authorized");
          // bearer 本身不能证明调用者是 UWork：同 UID 进程能自行拉起已获 TCC 的 Helper。
          // 必须让原生验证器检查内核 peer 凭据与签名祖先，再 admission 任何控制方法。
          try {
            await authorizePeer(socket);
          } catch {
            peerDenied = true;
            throw fail("Helper peer is not authorized.", "not_authorized");
          }
          if (controller.signal.aborted || socket.destroyed)
            throw fail("Helper request was canceled.", "aborted");
        }
        const operation = async () => {
          if (request.method === "ping") return { bundleId, pid: process.pid };
          if (request.method === "permission_status") {
            const permissions = await readPermissions();
            if (
              typeof permissions?.accessibility !== "boolean" ||
              typeof permissions?.screenRecording !== "boolean"
            )
              throw fail(
                "Helper permission probe returned no definitive status.",
                "helper_unavailable",
              );
            return {
              grant_owner: bundleId,
              owner: { display_name: displayName },
              accessibility: permissions.accessibility ? "granted" : "denied",
              screen_recording: permissions.screenRecording ? "granted" : "denied",
              accessibility_probe_ok: false,
            };
          }
          if (request.method === "shutdown") return {};
          if (
            !request.params ||
            typeof request.params !== "object" ||
            Array.isArray(request.params)
          )
            throw fail("Helper request params must be an object.");
          if (request.method === "close_session") {
            if (!request.params.context || typeof request.params.context !== "object")
              throw fail("close_session requires context.");
            await runtime.closeSession(request.params.context);
            return {};
          }
          // AbortSignal 不能跨 JSON 传输：只信本进程连接生命周期，断连后停止排队/在途动作。
          executionEntered = true;
          executing += 1;
          return runtime.execute({ ...request.params, signal: controller.signal });
        };
        const result = await Promise.race([
          operation(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(fail("Helper request timed out.", "timeout"));
            }, REQUEST_TIMEOUT_MS);
          }),
        ]);
        respond(
          { ...(id === undefined ? {} : { id }), ok: true, result },
          request.method === "shutdown",
          () => {
            void close();
          },
        );
      } catch (error) {
        respond(
          {
            ...(id === undefined ? {} : { id }),
            ok: false,
            error: {
              code:
                typeof error.code === "string"
                  ? error.code
                  : error instanceof SyntaxError
                    ? "invalid_request"
                    : "internal",
              message: error.message ?? String(error),
              // native 抛错/取消不能证明输入未发出；未知结果必须提醒调用者先观察，禁止重放。
              actionSent: executionEntered || error.actionSent === true,
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          },
          peerDenied,
        );
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
        if (executionEntered) executing -= 1;
        if (counted) onRequestActivity?.({ inflight: --inflight });
      }
    };
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void dispatch(line);
      }
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        respond(
          {
            ok: false,
            error: { code: "invalid_request", message: "Helper request exceeds size limit." },
          },
          true,
        );
        buffer = "";
      }
    });
  });
  async function close() {
    if (!closing)
      closing = (async () => {
        for (const socket of clients) socket.destroy();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        try {
          await runtime.dispose();
        } finally {
          await removeOwned(socketPath, socketIdentity);
          if (!preserveAuthority) await removeOwned(tokenPath, authority.identity);
        }
      })();
    return closing;
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  socketIdentity = await lstat(socketPath);
  await chmod(socketPath, 0o600);
  return { socketPath, tokenPath, close };
}

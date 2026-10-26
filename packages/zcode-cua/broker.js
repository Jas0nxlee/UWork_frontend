import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
    this.actionSent = options.actionSent === true;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

export async function callBrokerMethod(args) {
  if (!isBrokerMethod(args.method))
    throw new BrokerError("Unknown Computer Use broker method", { code: "invalid_request" });
  if (!args.socketPath || typeof args.socketPath !== "string")
    throw new BrokerError("Computer Use broker socket is missing", { code: "broker_unavailable" });
  if (!isReadOnlyBrokerMethod(args.method) && !args.token)
    throw new BrokerError("Computer Use authority is missing", { code: "not_authorized" });
  if (args.signal?.aborted) throw args.signal.reason ?? new DOMException("Aborted", "AbortError");
  const request =
    JSON.stringify({
      id: randomUUID(),
      method: args.method,
      params: args.params ?? {},
      ...(args.token ? { token: args.token } : {}),
    }) + "\n";
  if (Buffer.byteLength(request) > 1024 * 1024)
    throw new BrokerError("Computer Use request exceeds 1 MiB", { code: "invalid_request" });
  return new Promise((resolveRequest, reject) => {
    const socket = createConnection(args.socketPath);
    let received = "";
    let sent = false;
    let done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolveRequest(result);
    };
    // 原因：连接中断不能证明输入未发送。动作写入后出现超时/取消时保留 possibly_sent，绝不自动重放。
    const transportError = (message, code) =>
      new BrokerError(message, { code, actionSent: sent && args.method === "execute" });
    const onAbort = () => finish(transportError("Computer Use request was canceled", "aborted"));
    const timer = setTimeout(
      () => finish(transportError("Computer Use broker request timed out", "timeout")),
      args.timeoutMs ?? 15000,
    );
    args.signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      if (args.signal?.aborted) {
        onAbort();
        return;
      }
      sent = true;
      socket.write(request);
    });
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (Buffer.byteLength(received) > 32 * 1024 * 1024) {
        finish(transportError("Computer Use response exceeds 32 MiB", "invalid_response"));
        return;
      }
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(received.slice(0, newline));
        if (response?.ok === true) finish(null, response.result);
        else if (
          response?.ok === false &&
          response.error &&
          typeof response.error.message === "string"
        )
          finish(
            new BrokerError(response.error.message, {
              code: response.error.code,
              details: response.error.details,
              actionSent: response.error.actionSent === true || response.error.action_sent === true,
            }),
          );
        else finish(transportError("Malformed Computer Use broker response", "invalid_response"));
      } catch {
        finish(transportError("Malformed Computer Use broker response", "invalid_response"));
      }
    });
    socket.once("error", (error) =>
      finish(
        transportError(
          `Computer Use broker connection failed: ${error.message}`,
          "broker_unavailable",
        ),
      ),
    );
    socket.once("end", () => {
      if (!done)
        finish(transportError("Computer Use broker closed before replying", "broker_unavailable"));
    });
  });
}

export async function probeHelperHealth(socketPath, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 3000);
  let lastError;
  do {
    try {
      const result = await callBrokerMethod({
        socketPath,
        method: "ping",
        timeoutMs: Math.max(1, Math.min(options.perTryTimeoutMs ?? 300, deadline - Date.now())),
      });
      const bundleId = result?.bundleId ?? result?.bundle_id;
      if (typeof bundleId !== "string" || !Number.isInteger(result?.pid) || result.pid <= 0)
        throw new BrokerError("Invalid Computer Use Helper identity", { code: "invalid_response" });
      return { ...result, bundleId, pid: result.pid };
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolveWait) =>
      setTimeout(
        resolveWait,
        Math.min(options.pollIntervalMs ?? 50, Math.max(1, deadline - Date.now())),
      ),
    );
  } while (Date.now() < deadline);
  throw lastError ?? new BrokerError("Computer Use Helper is unavailable");
}

export function mintBrokerSocketPath(options = {}) {
  const dir = typeof options.dir === "string" ? options.dir : "/tmp";
  return join(dir, `uwc-${randomUUID()}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  const root = resolve(
    env.ZCODE_STORAGE_DIR?.trim() ||
      env.UWORK_HOME?.trim() ||
      env.ZCODE_HOME?.trim() ||
      join(
        env.UWORK_DATA_BASE_DIR?.trim() || env.ZCODE_DATA_BASE_DIR?.trim() || env.HOME || homedir(),
        ".uwork",
      ),
  );
  const variant = env.ZCODE_CUA_HELPER_INSTALL_VARIANT?.trim() || "stable";
  const digest = createHash("sha256").update(`${root}\0${variant}`).digest("hex").slice(0, 20);
  // macOS sockaddr_un 只有 104 bytes；不能把冗长的 dataRoot 直接拼进 socket 文件名。
  return join("/tmp", `uwc-${process.getuid?.() ?? "user"}-${digest}`, "broker.sock");
}

export function parseRequestLine(line) {
  try {
    const request = JSON.parse(line);
    return request && typeof request === "object" && isBrokerMethod(request.method)
      ? request
      : undefined;
  } catch {
    return undefined;
  }
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: { message, ...(options.code ? { code: options.code } : {}) },
  };
}

export function errorResponseFromException(error) {
  return errorResponse(error instanceof Error ? error.message : String(error), {
    code: error?.code,
  });
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

export async function dispatchRequest(backend, request) {
  const handler = backend[request.method];
  if (!isBrokerMethod(request.method) || typeof handler !== "function")
    return errorResponse("Unknown Computer Use broker method", { code: "invalid_request" });
  if (
    !isReadOnlyBrokerMethod(request.method) &&
    (typeof backend.authorize !== "function" || (await backend.authorize(request)) !== true)
  )
    return errorResponse("Computer Use request is not authorized", { code: "not_authorized" });
  try {
    return okResponse(await handler(request.params ?? {}, request));
  } catch (error) {
    return errorResponseFromException(error);
  }
}

export async function handleRequestLine(backend, line) {
  const request = parseRequestLine(line);
  return request
    ? dispatchRequest(backend, request)
    : errorResponse("Invalid Computer Use request", { code: "invalid_request" });
}

export function isBrokerMethod(method) {
  return [
    "ping",
    "permission_status",
    "resolve_transport",
    "execute",
    "close_session",
    "shutdown",
    "screen_capture_probe",
  ].includes(method);
}

export function isReadOnlyBrokerMethod(method) {
  return method === "ping" || method === "permission_status";
}

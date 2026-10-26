import { isRemoteWorkspaceIdentity } from "@zcode/shared";
import { callBrokerMethod, BrokerError } from "./broker.js";

function failure(error) {
  const payload = {
    code: error.code ?? "broker_unavailable",
    message: error.message,
    ...(error.actionSent ? { action_sent: true, dispatch_status: "possibly_sent" } : {}),
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function assertLocalContext(context) {
  if (
    !context ||
    context.runtimeScope !== "main" ||
    isRemoteWorkspaceIdentity(context.workspaceIdentity?.trim() || "") ||
    context.remoteSessionId?.trim() ||
    (context.deliveryKind ?? context.clientMode) !== "desktop-continuous" ||
    (context.deliveryKind !== undefined && context.deliveryKind !== "desktop-continuous") ||
    (context.clientMode !== undefined && context.clientMode !== "desktop-continuous")
  )
    throw new BrokerError("Computer Use is restricted to the main local desktop session", {
      code: "not_authorized",
    });
  if (
    !context.sessionId?.trim() ||
    !(
      context.workspaceIdentity?.trim() ||
      context.workspacePath?.trim() ||
      context.workspaceKey?.trim()
    )
  )
    throw new BrokerError("Computer Use session and workspace identity are required", {
      code: "invalid_request",
    });
}

export function createComputerUseRuntime(options = {}) {
  const env = options.env ?? process.env;
  const proxySocketPath = options.brokerSocketPath ?? env.ZCODE_CUA_PERMISSION_BROKER_SOCKET;
  const token = env.ZCODE_CUA_PLUGIN_AUTHORITY?.trim();
  const lifetime = new AbortController();
  let disposed = false;
  const contexts = new Map();
  const contextEpochs = new Map();
  const contextKey = (context) =>
    JSON.stringify([
      context.workspaceIdentity?.trim() || context.workspacePath?.trim() || context.workspaceKey,
      context.remoteSessionId ?? "",
      context.sessionId,
    ]);
  const assertActive = () => {
    if (disposed)
      throw new BrokerError("Computer Use runtime is disposed", { code: "broker_unavailable" });
  };
  const resolveTransport = async (context, signal) => {
    assertActive();
    if (!token)
      throw new BrokerError("Computer Use authority is missing", { code: "not_authorized" });
    await options.ensureBrokerAvailable?.();
    assertActive();
    let transport;
    try {
      transport = await callBrokerMethod({
        socketPath: proxySocketPath,
        method: "resolve_transport",
        params: { context },
        token,
        signal,
      });
    } catch (error) {
      // metadata 阶段没有动作路径，不能把启动/连接失败投影为“可能已发送输入”。
      throw new BrokerError(error.message, { code: error.code, details: error.details });
    }
    assertActive();
    if (
      !transport ||
      typeof transport.socketPath !== "string" ||
      !transport.socketPath ||
      transport.socketPath === proxySocketPath ||
      typeof transport.pluginAuthority !== "string" ||
      !/^[a-f0-9]{64}$/u.test(transport.pluginAuthority)
    ) {
      throw new BrokerError("Host returned an invalid Computer Use Helper transport", {
        code: "invalid_response",
      });
    }
    return { socketPath: transport.socketPath, pluginAuthority: transport.pluginAuthority };
  };
  const closeUsedContext = (entry) =>
    callBrokerMethod({
      socketPath: entry.transport.socketPath,
      method: "close_session",
      params: { context: entry.context },
      token: entry.transport.pluginAuthority,
      timeoutMs: 3000,
    });
  return {
    async execute(input) {
      try {
        assertLocalContext(input.context);
        const { signal: callerSignal, ...params } = input;
        const signal = callerSignal
          ? AbortSignal.any([callerSignal, lifetime.signal])
          : lifetime.signal;
        const key = contextKey(input.context);
        const epoch = contextEpochs.get(key) ?? 0;
        const transport = await resolveTransport(input.context, signal);
        if ((contextEpochs.get(key) ?? 0) !== epoch)
          throw new BrokerError("Computer Use session closed before execution", {
            code: "aborted",
          });
        const entryKey = JSON.stringify([key, transport.socketPath, transport.pluginAuthority]);
        contexts.set(entryKey, { key, context: input.context, transport });
        // 原因：Host 转发动作会隐藏真实 peer。客户端必须亲自连接 Helper，保留 node_repl 原生身份校验。
        return await callBrokerMethod({
          socketPath: transport.socketPath,
          method: "execute",
          params,
          token: transport.pluginAuthority,
          signal,
        });
      } catch (error) {
        return failure(error);
      }
    },
    async closeSession(context) {
      assertLocalContext(context);
      if (disposed) return;
      const key = contextKey(context);
      contextEpochs.set(key, (contextEpochs.get(key) ?? 0) + 1);
      await Promise.all(
        [...contexts.entries()]
          .filter(([, entry]) => entry.key === key)
          .map(async ([entryKey, entry]) => {
            await closeUsedContext(entry);
            if (contexts.get(entryKey) === entry) contexts.delete(entryKey);
          }),
      );
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort(new DOMException("Computer Use runtime is disposed", "AbortError"));
      // 清理仅直连已经解析且使用过的真实 tuple；不经 proxy，也不为关闭会话而拉起 Helper。
      const used = [...contexts.values()];
      contexts.clear();
      contextEpochs.clear();
      await Promise.allSettled(used.map(closeUsedContext));
    },
  };
}

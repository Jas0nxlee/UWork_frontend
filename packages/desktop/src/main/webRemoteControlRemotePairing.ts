import { setTimeout as delay } from "node:timers/promises";

/**
 * 自建后台（uwork）的远控设备登记与配对应答。
 *
 * 与 relay 无关：这里只和后台的 `/api/client/remote-*` 说话。
 * - 远控开启期间登记本机设备并心跳续期（不含任何密钥）；
 * - 长轮询取"本人 pending 的配对请求"（后台按会话成员过滤，天然同人），
 *   应答时把本次运行的配对材料（sid + passHash）交回，材料不落后台存储。
 */

export interface RemotePairingChannelOptions {
  apiBaseUrl: string;
  /** 本机企业会话令牌（Bearer）。 */
  token: string;
  deviceSid: string;
  deviceMid: string;
  deviceName: string;
  platform: string;
  /** 本次运行的 pass_hash；运行结束/轮换后不再应答。 */
  readPassHash: () => string | undefined;
  fetchImpl?: typeof fetch;
  logger: {
    info: (message: string, fields?: Record<string, unknown>) => void;
    warn: (message: string, fields?: Record<string, unknown>) => void;
  };
  signal: AbortSignal;
  /** 心跳间隔（默认 40s，后台 TTL 120s）。 */
  heartbeatMs?: number;
  /** 单轮长轮询的等待秒数（后台上限 30s）。 */
  pollWaitSeconds?: number;
  /** 登记成功后回报"本机在这个后台是谁"（tenant + member 实体），用于校验手机身份帧。 */
  onRegistered?: (identity: { tenantId: string; memberId: string }) => void;
}

export interface RemotePairingChannel {
  /** 停止轮询并从后台注销设备（幂等，可重复调用）。 */
  dispose(): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 40_000;
const DEFAULT_POLL_WAIT_SECONDS = 25;

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function startRemotePairingChannel(
  options: RemotePairingChannelOptions,
): RemotePairingChannel {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `${options.apiBaseUrl}/`;
  const devicePath = `/api/client/remote-devices/${encodeURIComponent(options.deviceSid)}`;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const pollWait = options.pollWaitSeconds ?? DEFAULT_POLL_WAIT_SECONDS;
  let disposed = false;

  const register = async (): Promise<boolean> => {
    try {
      const response = await fetchImpl(new URL(devicePath, base), {
        method: "PUT",
        headers: { ...auth(options.token), "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceMid: options.deviceMid,
          name: options.deviceName,
          platform: options.platform,
        }),
        signal: options.signal,
      });
      if (!response.ok) {
        options.logger.warn("[web-remote-control] remote device registration rejected", {
          status: response.status,
        });
        return false;
      }
      const body = (await response.json().catch(() => null)) as {
        tenantId?: unknown;
        memberId?: unknown;
      } | null;
      if (
        typeof body?.tenantId === "string" &&
        typeof body.memberId === "string" &&
        body.tenantId &&
        body.memberId
      )
        options.onRegistered?.({ tenantId: body.tenantId, memberId: body.memberId });
      return true;
    } catch {
      return false;
    }
  };

  const loop = async () => {
    while (!disposed && !options.signal.aborted) {
      try {
        const response = await fetchImpl(
          new URL(
            `/api/client/remote-pairings/next?deviceSid=${encodeURIComponent(options.deviceSid)}&wait=${pollWait}`,
            base,
          ),
          { method: "GET", headers: auth(options.token), signal: options.signal },
        );
        if (!response.ok) throw new Error(`next ${response.status}`);
        const body = (await response.json()) as {
          pairing?: { id?: unknown; deviceSid?: unknown } | null;
        };
        const pairing = body.pairing;
        const pairingId = typeof pairing?.id === "string" ? pairing.id : "";
        if (!pairingId) continue;
        const passHash = options.readPassHash();
        if (!passHash) continue;
        const answered = await fetchImpl(
          new URL(`/api/client/remote-pairings/${encodeURIComponent(pairingId)}/answer`, base),
          {
            method: "POST",
            headers: { ...auth(options.token), "Content-Type": "application/json" },
            body: JSON.stringify({ sid: options.deviceSid, hash: passHash }),
            signal: options.signal,
          },
        );
        options.logger.info("[web-remote-control] remote pairing answered", {
          pairingId,
          status: answered.status,
        });
      } catch (error) {
        if (disposed || options.signal.aborted) return;
        // 网络抖动不应结束通道；退避后继续，直到运行结束或注销。
        options.logger.warn("[web-remote-control] remote pairing poll failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        await delay(2_000).catch(() => undefined);
      }
    }
  };

  const heartbeat = async () => {
    while (!disposed && !options.signal.aborted) {
      await delay(heartbeatMs).catch(() => undefined);
      if (disposed || options.signal.aborted) return;
      await register();
    }
  };

  void (async () => {
    if (!(await register())) return;
    void heartbeat();
    void loop();
  })();

  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await fetchImpl(new URL(devicePath, base), {
          method: "DELETE",
          headers: auth(options.token),
        });
      } catch {
        // 注销失败只会让设备在 TTL 后自然过期。
      }
    },
  };
}

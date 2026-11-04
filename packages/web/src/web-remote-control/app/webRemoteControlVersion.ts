import type { WebRemoteControlWindowBootstrapResult } from "@zcode/shared";

interface WebRemoteControlVersionGuardOptions {
  /** 只读取响应；依赖当前连接的副作用由 onAccepted 同步提交。 */
  requestBootstrap(): Promise<WebRemoteControlWindowBootstrapResult>;
  onAccepted?(result: WebRemoteControlWindowBootstrapResult): void;
  getUrl(): string;
  isPageReady(): boolean;
  navigate(url: string): void;
  onMismatch(desktopVersion: string): void;
  /**
   * 本会话已经为哪个桌面版本导航过（可选）。
   *
   * 企微内置浏览器会把页面以**裸 URL** 重新打开（`app_version` 参数丢失），只按 URL 判断时
   * 守卫会再次导航、又被裸 URL 打回，形成“重载→重新配对→握手”的循环——用户看到的就是
   * “第二次找回连接特别慢”。记住已协商的版本后，同一版本不再导航。
   */
  readAgreedVersion?(): string | undefined;
  rememberAgreedVersion?(version: string): void;
  /**
   * 部署侧开关（缺省开启）：自托管只发布**单一构建**，没有按桌面版本分发的静态包，
   * 用 `app_version` 导航换来的只是整页重载（企微会丢参数，表现为“配对完成→加载工作区→
   * 又跳回恢复连接”的循环）。关掉后仍做一次 bootstrap 并接受结果，只是不再导航。
   */
  enabled?: boolean;
}

/** 只管理当前手机连接的版本校验；资源路由由服务端处理。 */
export function createWebRemoteControlVersionGuard(options: WebRemoteControlVersionGuardOptions) {
  let generation = 0;
  let disposed = false;
  let pendingUrl: string | undefined;
  let navigated = false;
  let inFlight: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;

  const confirm = () => {
    if (disposed || navigated || !pendingUrl) return;
    navigated = true;
    options.navigate(pendingUrl);
  };

  const invalidate = () => {
    generation += 1;
    inFlight = undefined;
  };

  return {
    isBlocked: () => pendingUrl !== undefined,
    confirm,
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
    check(): Promise<WebRemoteControlWindowBootstrapResult | undefined> {
      if (disposed || pendingUrl) return Promise.resolve(undefined);
      if (options.enabled === false) {
        // 不做版本导航：直接读一次 bootstrap，把结果交给业务（onAccepted）。
        if (inFlight) return inFlight;
        const request = Promise.resolve()
          .then(() => options.requestBootstrap())
          .then((result) => {
            if (disposed) return undefined;
            options.onAccepted?.(result);
            return result;
          })
          .finally(() => {
            if (inFlight === request) inFlight = undefined;
          });
        inFlight = request;
        return request;
      }
      if (inFlight) return inFlight;
      const requestGeneration = generation;
      const request = Promise.resolve()
        .then(() => options.requestBootstrap())
        .then((result) => {
          // 重连可能让旧响应晚于新连接返回，不能用旧桌面的版本导航或初始化业务。
          if (disposed || requestGeneration !== generation) return undefined;
          const version = result.desktopAppVersion?.trim();
          if (version) {
            const agreed = options.readAgreedVersion?.();
            const url = new URL(options.getUrl());
            if (
              agreed !== version &&
              url.pathname.replace(/\/+$/, "") === "/remote/v4" &&
              url.searchParams.get("app_version") !== version
            ) {
              url.searchParams.set("app_version", version);
              pendingUrl = url.toString();
              options.rememberAgreedVersion?.(version);
              if (options.isPageReady()) options.onMismatch(version);
              else confirm();
              return undefined;
            }
          }
          // 旧 bootstrap 曾先写入查看 epoch 再被丢弃；副作用必须和代际校验在同一同步段。
          options.onAccepted?.(result);
          return result;
        })
        .catch((error: unknown) => {
          if (disposed || requestGeneration !== generation) return undefined;
          throw error;
        })
        .finally(() => {
          if (inFlight === request) inFlight = undefined;
        });
      inFlight = request;
      return request;
    },
  };
}

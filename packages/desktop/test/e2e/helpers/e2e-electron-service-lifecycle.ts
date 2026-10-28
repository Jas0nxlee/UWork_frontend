export interface E2EElectronServiceBridgeLifecycle {
  initialize: () => Promise<void>;
  probe: () => Promise<void>;
  reset: () => void | Promise<void>;
}

const reloadBridgeByBrowser = new WeakMap<WebdriverIO.Browser, () => Promise<void>>();

export function registerE2EElectronServiceBridgeReload(
  browser: WebdriverIO.Browser,
  reload: () => Promise<void>,
) {
  reloadBridgeByBrowser.set(browser, reload);
}

export async function reloadE2EElectronServiceBridge(browser: WebdriverIO.Browser) {
  const reload = reloadBridgeByBrowser.get(browser);
  if (!reload) {
    throw new Error("Electron service reload callback 未注册");
  }
  await reload();
}

export async function initializeE2EElectronServiceBridge(
  lifecycle: E2EElectronServiceBridgeLifecycle,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await lifecycle.initialize();
      await lifecycle.probe();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        // Bug 根因：wdio-electron-service 会吞掉首次 ContextId 初始化异常并返回
        // 不可用的 API stub；只检查 before 已 resolve 会让 renderer preflight 继续超时。
        await lifecycle.reset();
      }
    }
  }

  throw new Error("Electron service bridge 两次初始化后仍不可用", {
    cause: lastError,
  });
}

/** 冷存储页交给业务窗口后，再绑定 Electron bridge；不查询旧 Main/CDP context。 */
export async function waitForE2EBusinessRendererHandoff(
  browser: WebdriverIO.Browser,
  timeout = 60_000,
): Promise<void> {
  let lastError: unknown;
  await browser
    .waitUntil(
      async () => {
        // 迁移会销毁首次取得的 cold handle；每轮必须从 WebDriver 重取现存窗口。
        const handles = await browser.getWindowHandles().catch((error: unknown) => {
          lastError = error;
          return [];
        });
        for (const handle of handles) {
          try {
            await browser.switchToWindow(handle);
            const businessReady = await browser.execute(() =>
              Boolean(
                document.querySelector('[data-testid="onboarding-page"]') ||
                document.querySelector('[data-testid="task-settings-button"]'),
              ),
            );
            if (!businessReady) continue;
            (browser.electron as typeof browser.electron & { windowHandle?: string }).windowHandle =
              handle;
            await reloadE2EElectronServiceBridge(browser);
            return true;
          } catch (error) {
            // 窗口可在枚举与探测之间关闭；下一轮重取 handles，而非复用失效 context。
            lastError = error;
          }
        }
        return false;
      },
      { timeout, interval: 100, timeoutMsg: "冷启动后未找到可用的业务 renderer 窗口" },
    )
    .catch((error: unknown) => {
      throw new Error("业务 renderer 窗口交接失败", { cause: lastError ?? error });
    });
}

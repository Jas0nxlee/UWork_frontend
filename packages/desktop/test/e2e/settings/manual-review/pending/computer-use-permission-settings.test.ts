import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom } from "../../../helpers/desktop-app.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";
import { callBrokerMethod, resolveBrokerSocketPath } from "@zcode/zcode-cua/broker";
import { dismissOccupationOnboarding } from "../../../helpers/occupation-onboarding.js";

// 合同：specs/restore-macos-computer-use-runtime.md；用例边界见
// docs/testing/computer-use-permission-settings-e2e-cases.md。
const ACCESSIBILITY_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
const SCREEN_RECORDING_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const ENABLE_SWITCH =
  '[role="switch"][aria-label="启用电脑控制"], [role="switch"][aria-label="Enable Computer Use"]';
const UNKNOWN_HELPER =
  /暂时无法确认 Helper|Helper may still be starting|unable to confirm.*Helper/i;

describe("Computer Use permission settings with real Helper", () => {
  let external: Awaited<ReturnType<typeof browser.electron.mock>>;

  before(async function () {
    this.timeout(120_000);
    if (process.platform !== "darwin") throw new Error("This real Helper case requires macOS");
    if (!process.env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH) {
      throw new Error("Provide the current source-built Dev Helper path");
    }
    if (!process.env.ZCODE_CUA_HELPER_INSTALL_VARIANT?.startsWith("e2e-")) {
      throw new Error("Provide an isolated e2e- Helper install variant");
    }
    // 隔离账号未配置企业微信；先通过产品入口跳过登录，不能点被登录层遮住的底层设置。
    const skipSignIn = $('[data-testid="enterprise-login-skip"]');
    await skipSignIn.waitForClickable({ timeout: 30_000 });
    await skipSignIn.click();
    await skipSignIn.waitForExist({ reverse: true, timeout: 15_000 });
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="onboarding-page"]').isExisting()) ||
        (await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).isExisting()),
      { timeout: 30_000, timeoutMsg: "Initial isolated workspace UI was not ready" },
    );
    if (await $('[data-testid="onboarding-page"]').isExisting()) {
      // 本例只验证权限设置；用产品支持的退出引导操作，避免首跑 Skip 布局影响准备阶段。
      await dismissOccupationOnboarding();
      await $('[data-testid="onboarding-page"]').waitForExist({ reverse: true, timeout: 15_000 });
    }
    await prepareV4ConversationE2E({ skipProvider: true });
    external = await browser.electron.mock("shell", "openExternal");
    await external.mockResolvedValue(undefined);
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    const socketPath = resolveBrokerSocketPath();
    // 停止请求由受信的 Electron Main 发出；测试 runner 不冒充有桌面控制权限的本机宿主。
    await browser.electron.execute(async (_electron, path) => {
      const { readFile } = process.getBuiltinModule("node:fs/promises");
      const { createConnection } = process.getBuiltinModule("node:net");
      const token = await readFile(`${path}.authority`, "utf8").catch(() => "");
      if (!token) return;
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(path);
        socket.once("error", reject);
        socket.setTimeout(5000, () => {
          socket.destroy();
          reject(new Error("Helper cleanup timed out"));
        });
        socket.once("connect", () =>
          socket.write(`${JSON.stringify({ method: "shutdown", token: token.trim() })}\n`),
        );
        socket.once("data", (chunk) => {
          socket.destroy();
          const response = JSON.parse(String(chunk));
          if (response.ok) resolve();
          else reject(new Error(response.error?.message ?? "Helper cleanup failed"));
        });
      });
    }, socketPath);
    await clearAppData();
  });

  async function openComputerUseSettings() {
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 15_000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "computerUse"));
    const toggle = $(ENABLE_SWITCH);
    await toggle.waitForClickable({ timeout: 15_000 }).catch(async (cause) => {
      await browser.saveScreenshot("/tmp/uwork-computer-use-settings-before-toggle.png");
      const state = await browser.execute((selector) => {
        const element = document.querySelector<HTMLButtonElement>(selector);
        const rect = element?.getBoundingClientRect();
        return {
          section: document
            .querySelector('[data-testid="settings-page"]')
            ?.getAttribute("data-active-section"),
          disabled: element?.disabled,
          rect: rect?.toJSON(),
          covering: rect
            ? document
                .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                ?.outerHTML.slice(0, 400)
            : null,
        };
      }, ENABLE_SWITCH);
      throw new Error(`Enable switch unavailable: ${JSON.stringify(state)}`, { cause });
    });
    if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
    await browser.waitUntil(async () => (await toggle.getAttribute("aria-checked")) === "true", {
      timeout: 15_000,
      timeoutMsg: "Computer Use plugin did not become enabled",
    });
  }

  async function clickPermissionAndExpectUrl(labels: string[], url: string) {
    const button = $(labels.map((label) => `button[aria-label="${label}"]`).join(","));
    await button.waitForClickable({ timeout: 30_000 });
    // 按钮可用只代表查询结束；必须断言真实状态是缺权，而不是 unknown 终态。
    const page = $(`[data-testid="${TID_SETTINGS_PAGE}"]`);
    await browser.waitUntil(async () => !/未知|Unknown/.test(await page.getText()), {
      timeout: 30_000,
      timeoutMsg: "Real Helper did not provide a definitive permission snapshot",
    });
    const socketPath = resolveBrokerSocketPath();
    const ping = await callBrokerMethod<{ bundleId: string; pid: number }>({
      socketPath,
      method: "ping",
    });
    expect(ping.bundleId).toBe("dev.zcode.cua-helper.dev");
    expect(ping.pid).toBeGreaterThan(0);
    expect(await callBrokerMethod({ socketPath, method: "permission_status" })).toMatchObject({
      grant_owner: "dev.zcode.cua-helper.dev",
      accessibility: "denied",
      screen_recording: "denied",
    });
    const before = external.mock.calls.length;
    await button.click();
    await browser.waitUntil(
      () => external.mock.calls.slice(before).some(([target]) => target === url),
      {
        timeout: 30_000,
        timeoutMsg: `Permission button did not reach Main shell.openExternal: ${url}`,
      },
    );
    expect(external.mock.calls.slice(before).map(([target]) => target)).toContain(url);
    // Toast 挂在 body portal，不属于设置页容器；必须读取实际可见的全页文本。
    expect(await $("body").getText()).not.toMatch(UNKNOWN_HELPER);
  }

  async function cancelMockedOnboarding() {
    // Settings 外层会保留已选分区；先切换到 General，确保 ComputerUseSection 真正卸载。
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
    await browser.waitUntil(
      async () =>
        browser.electron.execute((electron) =>
          electron.BrowserWindow.getAllWindows().every((window) => window.isFocusable()),
        ),
      {
        timeout: 15_000,
        timeoutMsg: "Canceled permission onboarding did not destroy its native panel",
      },
    );
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  }

  it("CUPS-01: Accessibility button reaches the exact system settings pane", async function () {
    this.timeout(90_000);
    await openComputerUseSettings();
    await clickPermissionAndExpectUrl(
      ["打开辅助功能设置", "Open Accessibility Settings"],
      ACCESSIBILITY_URL,
    );
    // shell 被 mock 后不会产生真实系统设置返回；用真实导航卸载分区并取消当前 participant。
    await cancelMockedOnboarding();
  });

  it("CUPS-02: Screen Recording button reaches the exact system settings pane", async function () {
    this.timeout(90_000);
    await openComputerUseSettings();
    await clickPermissionAndExpectUrl(
      ["打开屏幕录制设置", "Open Screen Recording"],
      SCREEN_RECORDING_URL,
    );
    await cancelMockedOnboarding();
  });
});

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@zcode/ui", () => ({ recordArmsCustomEventForE2E: vi.fn() }));
vi.mock("../src/renderer/src/desktopBrowserPlatformBridge.js", () => ({
  desktopBrowserPlatformBridge: {},
}));

describe("Desktop platform CUA onboarding lifecycle", () => {
  it("forwards cancellation through the existing preload bridge for the exact operation", async () => {
    const cancel = vi.fn();
    Object.defineProperty(window, "zcode", {
      value: { cancelCuaPermissionOnboarding: cancel },
      configurable: true,
    });
    const { createDesktopPlatform } = await import("../src/renderer/src/desktopPlatform.js");
    const platform = createDesktopPlatform({ isLocalDevelopmentRuntime: true });
    expect(typeof platform.cancelCuaPermissionOnboarding).toBe("function");
    platform.cancelCuaPermissionOnboarding?.("onboarding-operation-a");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("onboarding-operation-a");
  });
});

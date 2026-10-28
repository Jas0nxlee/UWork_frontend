import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  registerSchemesAsPrivileged: vi.fn(),
  sdkInit: vi.fn(),
  setPath: vi.fn(),
}));
vi.mock("electron", () => ({
  protocol: { registerSchemesAsPrivileged: fixture.registerSchemesAsPrivileged },
  app: {
    isReady: () => false,
    isPackaged: false,
    getPath: () => "/isolated-appdata",
    commandLine: { appendSwitch: vi.fn() },
    setName: vi.fn(),
    setPath: fixture.setPath,
  },
}));
vi.mock("@arms/rum-electron", () => {
  // 复现当前 SDK 的模块顶层行为；init 不能在冷迁移前触发。
  fixture.registerSchemesAsPrivileged([
    { scheme: "rum-event", privileges: { supportFetchAPI: true, corsEnabled: true } },
  ]);
  return { default: { init: fixture.sdkInit } };
});
vi.mock("../src/main/pluginSandbox/index.js", () => ({
  PLUGIN_SANDBOX_PRIVILEGED_SCHEME: {
    scheme: "zcode-sandbox",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
  },
}));
it("keeps media, plugin and SDK schemes together in the final preready registration", async () => {
  const originalTitle = process.title;
  try {
    const { configureDesktopPrereadyRuntime } =
      await import("../src/main/data-directory-startup/preready.js");
    configureDesktopPrereadyRuntime();
    configureDesktopPrereadyRuntime();
    expect(fixture.registerSchemesAsPrivileged).toHaveBeenCalledTimes(2);
    expect(fixture.registerSchemesAsPrivileged).toHaveBeenLastCalledWith([
      { scheme: "zcode-media", privileges: { standard: true, secure: true, stream: true } },
      {
        scheme: "zcode-sandbox",
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false },
      },
      { scheme: "rum-event", privileges: { supportFetchAPI: true, corsEnabled: true } },
    ]);
    expect(fixture.sdkInit).not.toHaveBeenCalled();
  } finally {
    process.title = originalTitle;
  }
});

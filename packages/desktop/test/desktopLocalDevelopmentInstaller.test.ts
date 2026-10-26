import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CuaHelperInstallerOptions } from "@zcode/services/node";

vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("@zcode/services/node", () => ({
  getAppConfigDir: () => "/mock/config",
  canonicalizeCuaHelperInstallerOptions: (options: unknown) => options,
  createCuaHelperInstaller: vi.fn(),
}));
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])("Main安装桥仅以编译档位%j锁定对应随包路径与开发门", async (local) => {
  vi.stubGlobal("__UWORK_LOCAL_DEVELOPMENT_BUILD__", local);
  const { createDesktopCuaHelperInstaller } =
    await import("../src/main/desktopCuaHelperInstaller.js");
  const factory = vi.fn((_options: CuaHelperInstallerOptions) => ({
    ensureInstalled: async () => "fixture",
    verifyInstalled: async () => {},
  }));
  createDesktopCuaHelperInstaller(
    {
      platform: "darwin",
      isPackaged: true,
      resourcesPath: "/App/Contents/Resources",
      ...(local ? { bundledHelperAppPath: "/tmp/also-untrusted.app" } : {}),
      env: {
        UWORK_DESKTOP_BUILD_PROFILE: "local-development",
        ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
        ZCODE_CUA_BUNDLED_HELPER_APP_PATH: "/tmp/untrusted.app",
      },
    },
    factory,
  );
  expect(factory.mock.calls[0][0]).toMatchObject({
    bundledAppPath: `/App/Contents/Resources/cua-helper/ZCode Computer Use${local ? " Dev" : ""}.app`,
  });
  expect(factory.mock.calls[0][0].env?.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL).toBe(
    local ? "1" : undefined,
  );
  if (local)
    expect(factory.mock.calls[0][0].env?.ZCODE_CUA_HELPER_INSTALL_VARIANT).toBe(
      "local-development",
    );
});

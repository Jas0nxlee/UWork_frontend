import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveDesktopBuildProfile,
  resolveDesktopDisplayVersion,
  resolveDesktopHelperPackaging,
  validateDesktopHelperBuildManifest,
} from "../scripts/desktop-build-profile.mjs";
import { resolveDesktopProductIdentity } from "../scripts/desktop-product-identity.mjs";

const require = createRequire(resolve(import.meta.dirname, "../../../apps/zcode-cli/package.json"));
const { build } = require("esbuild");
afterEach(() => vi.unstubAllGlobals());

describe("explicit local development build", () => {
  it("默认正式档位且非法选择器拒绝，开发包名称/版本明确并保留原 appId", () => {
    expect(resolveDesktopBuildProfile({})).toBe("release");
    expect(() => resolveDesktopBuildProfile({ UWORK_DESKTOP_BUILD_PROFILE: "1" })).toThrow();
    const env = { ZCODE_ENV: "production", UWORK_DESKTOP_BUILD_PROFILE: "local-development" };
    expect(resolveDesktopProductIdentity(env)).toMatchObject({
      appId: "dev.zcode.app",
      productName: "UWork Local Development",
      flavor: "production",
    });
    expect(resolveDesktopDisplayVersion("0.1.2", env)).toBe("0.1.2-local-development");
    expect(resolveDesktopDisplayVersion("0.1.2", {})).toBe("0.1.2");
  });

  it("打包只选择本档位的Helper，manifest混配必须失败", () => {
    const env = { UWORK_DESKTOP_BUILD_PROFILE: "local-development" };
    expect(resolveDesktopHelperPackaging("/repo", "arm64", env)).toEqual({
      appName: "ZCode Computer Use Dev.app",
      source: "/repo/packages/desktop/dist-cua-helper/ZCode Computer Use Dev.app",
      development: true,
      bundleId: "dev.zcode.cua-helper.dev",
    });
    expect(() =>
      validateDesktopHelperBuildManifest(
        { development: false, bundleId: "dev.zcode.cua-helper" },
        env,
      ),
    ).toThrow(/profile/);
    expect(() =>
      validateDesktopHelperBuildManifest(
        { development: true, bundleId: "dev.zcode.cua-helper.dev" },
        {},
      ),
    ).toThrow(/profile/);
    expect(() =>
      validateDesktopHelperBuildManifest(
        { development: true, bundleId: "dev.zcode.cua-helper.dev" },
        env,
      ),
    ).not.toThrow();
  });

  it("真实编译 release 不能被运行时环境开启；本地开发编译可用，源码dev仍可用", async () => {
    async function compiled(flag: boolean) {
      const result = await build({
        entryPoints: [resolve(import.meta.dirname, "../../zcode-cua/helper-installer.js")],
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        define: { __UWORK_LOCAL_DEVELOPMENT_BUILD__: JSON.stringify(flag) },
      });
      return import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
      );
    }
    const pollution = {
      UWORK_DESKTOP_BUILD_PROFILE: "local-development",
      ZCODE_RUNTIME_ENV: "development",
      ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: "1",
    };
    const release = await compiled(false);
    expect(release.isCuaLocalDevelopmentRuntime(pollution)).toBe(false);
    const local = await compiled(true);
    expect(
      local.isCuaLocalDevelopmentRuntime({ ...pollution, ZCODE_RUNTIME_ENV: "production" }),
    ).toBe(true);
    const raw = await import(
      pathToFileURL(resolve(import.meta.dirname, "../../zcode-cua/helper-installer.js")).href
    );
    expect(raw.isCuaLocalDevelopmentRuntime(pollution)).toBe(true);
    expect(
      raw.isCuaLocalDevelopmentRuntime({ ...pollution, ZCODE_RUNTIME_ENV: "production" }),
    ).toBe(false);
  });
});

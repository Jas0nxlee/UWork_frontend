import { afterEach, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: (name: string) => `/mock/${name}` },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it.each(["/new-root", "/fixture-home"])(
  "overrides both active-root aliases for Host/Scheduler when Main selects %s",
  async (target) => {
    vi.stubEnv("HOME", "/fixture-home");
    vi.stubEnv("ZCODE_DESKTOP_HOME_DIR", "/fixture-home");
    vi.stubEnv("UWORK_DATA_BASE_DIR", "/parent-canonical-old");
    vi.stubEnv("ZCODE_DATA_BASE_DIR", "/parent-legacy-old");
    vi.resetModules();
    const paths = await import("@zcode/services/paths");
    paths.setDataBaseDir(target);
    const { buildHostProcessEnv } = await import("../src/main/desktopRuntimeEnv.js");
    const env = buildHostProcessEnv({
      UWORK_DATA_BASE_DIR: "/dotenv-old",
      ZCODE_DATA_BASE_DIR: "/dotenv-legacy-old",
    });
    expect(env.UWORK_DATA_BASE_DIR).toBe(target);
    expect(env.ZCODE_DATA_BASE_DIR).toBe(target);
  },
);

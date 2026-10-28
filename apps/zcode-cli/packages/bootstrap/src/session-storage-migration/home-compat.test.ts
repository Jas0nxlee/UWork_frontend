import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import * as sharedPaths from "@zcode/shared";

type PathFunctions = {
  getSessionDbPath(config: object, cwd: undefined, env: Record<string, string>): string;
  resolveLegacySessionDatabaseMigration(
    config: object,
    options: { env: Record<string, string> },
  ): { sourcePath: string; targetPath: string };
};

it.each([
  { platform: "win32", home: "C:\\alternate-home-A", profile: "C:\\Users\\profile-B" },
  { platform: "darwin", home: "/alternate-home-A", profile: "/profile-B" },
  { platform: "linux", home: "/alternate-home-A", profile: "/profile-B" },
  { platform: "win32", home: "C:\\wrong-platform-home-A", profile: undefined },
  { platform: "linux", home: undefined, profile: "/wrong-platform-profile-B" },
])(
  "保留v0.1.2默认源与显式tilde的Node home合同: $platform HOME=$home USERPROFILE=$profile",
  async ({ platform, home, profile }) => {
    const paths = platform === "win32" ? win32 : posix;
    const fallback =
      platform === "win32" ? "C:\\native-system-fallback" : "/native-system-fallback";
    const desktopHome = platform === "win32" ? "C:\\desktop-C" : "/desktop-C";
    const env: Record<string, string> = {
      UWORK_SESSION_DB_MIGRATION: "1",
      ZCODE_DESKTOP_HOME_DIR: desktopHome,
    };
    if (home !== undefined) env.HOME = home;
    if (profile !== undefined) env.USERPROFILE = profile;
    // v0.1.2 的 DefaultRuntimeConfig 使用 ~/；config.resolvePath 的旧实现调用 Node homedir()。
    // 按 Node 的公开平台合同注入 native home，仅执行路径函数，不访问任何真实库或目录。
    const nativeHome = () => (platform === "win32" ? profile : home) ?? fallback;
    const legacyResolvePath = (configured: string) =>
      configured.startsWith("~/")
        ? paths.join(nativeHome(), configured.slice(2))
        : paths.resolve(configured);
    const source = await readFile(new URL("../app/session-store.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports = {};
    runInNewContext(code, {
      exports,
      process: { platform, env },
      require(id: string) {
        if (id === "node:path") return paths;
        if (id === "node:os") return { homedir: nativeHome };
        if (id === "@zcode/shared") return sharedPaths;
        return {};
      },
    });
    const current = exports as PathFunctions;
    const targetPath = paths.join(desktopHome, ".uwork", "cli", "db", "db.sqlite");
    const managedConfig = {
      sources: { sessionDb: "system" },
      config: { storage: { sessionDbPath: targetPath } },
    };
    expect(current.resolveLegacySessionDatabaseMigration(managedConfig, { env })).toEqual({
      sourcePath: paths.resolve(legacyResolvePath("~/.zcode/cli/db/db.sqlite")),
      targetPath,
    });
    const explicitConfig = {
      sources: { sessionDb: "user" },
      config: { storage: { sessionDbPath: "~/custom/session.sqlite" } },
    };
    expect(current.getSessionDbPath(explicitConfig, undefined, env)).toBe(
      paths.resolve(legacyResolvePath("~/custom/session.sqlite")),
    );
    expect(current.resolveLegacySessionDatabaseMigration(explicitConfig, { env })).toBeUndefined();
  },
);

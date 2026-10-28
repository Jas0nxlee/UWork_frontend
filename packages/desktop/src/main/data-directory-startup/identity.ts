import { join } from "node:path";
/** Electron userData/home 身份不等于业务数据根；此纯解析器可在冷迁移之前运行。 */
export function resolveDesktopLifecycleIdentity(
  packaged: boolean,
  flavor: string,
  env: Record<string, string | undefined>,
  getAppDataPath: () => string,
  localDevelopmentBuild = false,
) {
  const read = (key: string) => env[key]?.trim() || undefined;
  const development = !packaged;
  const preview = packaged && flavor === "preview";
  const runtimeApplicationName =
    read("ZCODE_DESKTOP_APPLICATION_NAME") ??
    (packaged && localDevelopmentBuild
      ? "UWork Local Development"
      : development
        ? "UWork Dev"
        : preview
          ? "UWork Preview"
          : "UWork");
  const shouldUseElectronDefaultUserDataPath = ["1", "true", "yes", "on"].includes(
    read("ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA")?.toLowerCase() ?? "",
  );
  const runtimeUserDataPath =
    read("ZCODE_DESKTOP_USER_DATA_DIR") ??
    (shouldUseElectronDefaultUserDataPath
      ? undefined
      : // 开发打包版只隔离名称与 Helper；Chromium 目录沿用主线规则，不能因提取 resolver 丢登录状态。
        join(
          getAppDataPath(),
          read("ZCODE_DESKTOP_APPLICATION_NAME") ??
            (development ? "UWork Dev" : preview ? "UWork Preview" : "UWork"),
        ));
  return {
    runtimeApplicationName,
    runtimeHomePath: read("ZCODE_DESKTOP_HOME_DIR") ?? read("HOME") ?? read("USERPROFILE"),
    shouldUseElectronDefaultUserDataPath,
    runtimeUserDataPath,
    runtimeSessionDataPath:
      read("ZCODE_DESKTOP_SESSION_DATA_DIR") ??
      (runtimeUserDataPath ? join(runtimeUserDataPath, "session") : undefined),
  };
}

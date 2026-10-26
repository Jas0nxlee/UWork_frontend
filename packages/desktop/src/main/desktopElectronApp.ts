import { app } from "electron";
import { getAppConfigDir } from "@zcode/services/node";

declare const __UWORK_LOCAL_DEVELOPMENT_BUILD__: boolean | undefined;

// 仅编译期事实；正式包固定 false，不能读取用户机器的 profile 环境来放宽 Helper 验证。
export const isLocalDevelopmentDesktopBuild =
  typeof __UWORK_LOCAL_DEVELOPMENT_BUILD__ === "boolean" && __UWORK_LOCAL_DEVELOPMENT_BUILD__;

export type ElectronAppPathName = "appData" | "userData";

export function isElectronAppPackaged(): boolean {
  return (app as unknown as { isPackaged?: boolean } | undefined)?.isPackaged === true;
}

export function getElectronAppPath(name: ElectronAppPathName): string {
  const electronApp = app as unknown as
    | { getPath?: (pathName: ElectronAppPathName) => string }
    | undefined;
  if (electronApp?.getPath) {
    return electronApp.getPath(name);
  }

  // 部分 main-process 单测只 mock 被测模块直接需要的 Electron API，
  // 间接导入 desktopRuntimeEnv 时可能拿不到 app。真实桌面运行仍走 app.getPath；
  // Node-only 测试用配置目录兜底，避免导入期常量把无关测试打断。
  return getAppConfigDir();
}

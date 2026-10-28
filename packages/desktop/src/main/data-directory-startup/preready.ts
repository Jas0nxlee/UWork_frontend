// SDK 模块求值会注册 rum-event privileged scheme，必须发生在 app.ready 前；
// 这里只加载其无业务存储的单例，appARMSBootstrap/init 仍等冷迁移完成后由业务 Main 执行。
import "@arms/rum-electron";
import { app, protocol } from "electron";
import { registerLocalMediaPreviewScheme } from "../localMediaPreviewProtocol.js";
import { PLUGIN_SANDBOX_PRIVILEGED_SCHEME } from "../pluginSandbox/index.js";
import { ZCODE_PRODUCT_FLAVOR } from "@zcode/shared";
import { resolveDesktopLifecycleIdentity } from "./identity.js";
import { resolve } from "node:path";
import { homedir } from "node:os";
const initialDefaultBaseDir = resolve(
  process.env.UWORK_DATA_BASE_DIR?.trim() ||
    process.env.ZCODE_DATA_BASE_DIR?.trim() ||
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    homedir(),
);
export function getInitialDataDirectoryDefaultBaseDir(): string {
  return initialDefaultBaseDir;
}
let configured = false;
/** pending 分支需要先创建进度窗口；所有必须早于 ready 的生命周期配置在此一次性完成。 */
export function configureDesktopPrereadyRuntime(): void {
  if (configured) return;
  if (app.isReady()) throw new Error("Desktop pre-ready bootstrap executed too late");
  const {
    runtimeApplicationName,
    runtimeHomePath,
    runtimeUserDataPath,
    runtimeSessionDataPath,
    shouldUseElectronDefaultUserDataPath,
  } = resolveDesktopLifecycleIdentity(app.isPackaged, ZCODE_PRODUCT_FLAVOR, process.env, () =>
    app.getPath("appData"),
  );
  // Electron 后一次 privileged 注册会覆盖前一次；最终集合须保留 SDK 顶层注册的权限。
  registerLocalMediaPreviewScheme(protocol, [
    PLUGIN_SANDBOX_PRIVILEGED_SCHEME,
    { scheme: "rum-event", privileges: { supportFetchAPI: true, corsEnabled: true } },
  ]);
  if (!app.isPackaged && process.env.ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT !== "1")
    app.commandLine.appendSwitch("remote-debugging-port", "9229");
  app.setName(runtimeApplicationName);
  if (runtimeHomePath) app.setPath("home", runtimeHomePath);
  if (!shouldUseElectronDefaultUserDataPath) {
    if (!runtimeUserDataPath || !runtimeSessionDataPath)
      throw new Error("Desktop runtime data paths are required");
    app.setPath("userData", runtimeUserDataPath);
    app.setPath("sessionData", runtimeSessionDataPath);
  }
  process.title = runtimeApplicationName;
  configured = true;
}

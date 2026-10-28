import "../desktopEarlyChromiumHardwareAccelerationBootstrap.js";
import { app } from "electron";
import { inspectDataDirectoryStartup } from "@zcode/services/data-directory-startup";
import {
  configureDesktopPrereadyRuntime,
  getInitialDataDirectoryDefaultBaseDir,
} from "./preready.js";
import { createDeepLinkSingleInstanceData } from "../desktopDeepLinkUrl.js";
import { bufferMainLifecycleIntents } from "./events.js";

configureDesktopPrereadyRuntime();
const coldFrames = (stack: unknown) =>
  typeof stack === "string"
    ? stack
        .split("\n")
        .filter((line) => /^\s*at\s/.test(line))
        .slice(0, 10)
    : [];
const intents = bufferMainLifecycleIntents(app);
const loadBusiness = async () => {
  await import("../index.js");
  intents.handoff();
};
const inspection = await inspectDataDirectoryStartup(
  app.getPath("home"),
  getInitialDataDirectoryDefaultBaseDir(),
);
if (inspection.desktopChromiumHardwareAccelerationEnabled === false)
  app.disableHardwareAcceleration();
if (!inspection.required) {
  await loadBusiness();
} else if (
  !app.hasSingleInstanceLock() &&
  !app.requestSingleInstanceLock(createDeepLinkSingleInstanceData(process.argv))
) {
  app.exit(0);
} else {
  // 不在顶层 await ready：Electron ESM 会等待入口完成才发 ready。
  // 业务 Main 的路径缓存直到 copy+settings 提交成功后才第一次求值。
  void app
    .whenReady()
    .then(async () => {
      const { openDataDirectoryStartupGate } = await import("./window.js");
      await openDataDirectoryStartupGate(
        inspection.locale,
        loadBusiness,
        getInitialDataDirectoryDefaultBaseDir(),
      );
    })
    .catch((error: unknown) => {
      const value = error as { name?: unknown; code?: unknown; stack?: unknown } | null;
      console.error("[data-directory-startup] bootstrap-failed", {
        name: typeof value?.name === "string" ? value.name : "Unknown",
        code: typeof value?.code === "string" ? value.code : undefined,
        frames: coldFrames(value?.stack),
      });
      app.exit(1);
    });
}

import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import {
  databaseStartupControlSchema,
  InternalChannels,
  type DatabaseStartupState,
  type Locale,
} from "@zcode/shared";
import { DatabaseStartupCoordinator } from "../../host/databaseStartupCoordinator.js";
import {
  createDataDirectoryStartup,
  registerColdDataDirectoryWindow,
  unregisterColdDataDirectoryWindow,
} from "./index.js";

/** 没有 ServicePort 的现有启动页；业务 Main 导入后由正常窗口接班。 */
export async function openDataDirectoryStartupGate(
  locale: Locale,
  loadBusiness: () => Promise<unknown>,
  defaultBaseDir: string,
): Promise<void> {
  const cold = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    title: "UWork",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });
  registerColdDataDirectoryWindow(cold.id);
  const abort = new AbortController();
  const storage = createDataDirectoryStartup(undefined, app.getPath("home"), defaultBaseDir);
  let imported = false;
  let handedOff = false;
  let resolveBusiness!: () => void;
  let rejectBusiness!: (error: unknown) => void;
  const business = new Promise<void>((resolve, reject) => {
    resolveBusiness = resolve;
    rejectBusiness = reject;
  });
  const forward = (state: DatabaseStartupState) => {
    if (!cold.isDestroyed() && !cold.webContents.isDestroyed())
      cold.webContents.send(InternalChannels.DatabaseStartupState, state);
  };
  const coordinator = new DatabaseStartupCoordinator({
    operation: "data-directory-migration",
    publish: forward,
    prepare: async (report, action) => {
      if (action === "cancel-data-directory-migration") {
        report("preparing_host_storage", "committing");
        await storage.cancel(abort.signal);
      } else
        await storage.prepare((phase) => report("preparing_host_storage", phase), abort.signal);
    },
  });
  const focus = () => {
    if (!cold.isDestroyed()) {
      cold.show();
      cold.focus();
    }
  };
  const cleanup = () => {
    handedOff = true;
    ipcMain.removeListener(InternalChannels.DatabaseStartupControl, control);
    unregisterColdDataDirectoryWindow(cold.id);
    app.removeListener("second-instance", focus);
    app.removeListener("browser-window-created", newWindow);
    if (!cold.isDestroyed()) cold.destroy();
  };
  const newWindow = (_event: unknown, window: BrowserWindow) => {
    if (window === cold) return;
    window.once("ready-to-show", () => {
      if (window.isDestroyed()) return;
      const url = window.webContents.getURL();
      let expectedBusiness = false;
      try {
        const parsed = new URL(url);
        const developmentUrl = process.env.ELECTRON_RENDERER_URL;
        const development = developmentUrl ? new URL(developmentUrl) : undefined;
        expectedBusiness =
          parsed.searchParams.get("windowKind") !== "update-status" &&
          parsed.searchParams.get("windowKind") !== "data-directory-startup" &&
          (parsed.protocol === "file:"
            ? parsed.pathname.endsWith("/renderer/index.html")
            : !!development &&
              parsed.origin === development.origin &&
              parsed.pathname === development.pathname);
      } catch {}
      // 辅助 about:blank/更新页的 ready 不是业务窗口接班证明，不能提前销毁唯一冷页。
      if (!expectedBusiness) return;
      cleanup();
    });
  };
  const launch = async () => {
    if (imported || coordinator.snapshot.phase !== "ready") return;
    imported = true;
    app.on("browser-window-created", newWindow);
    try {
      await loadBusiness();
      app.removeListener("second-instance", focus);
      resolveBusiness();
    } catch (error) {
      rejectBusiness(error);
    }
  };
  const run = async () => {
    await coordinator.start();
    await launch();
  };
  const control = (event: Electron.IpcMainEvent, raw: unknown) => {
    if (event.sender !== cold.webContents) return;
    const parsed = databaseStartupControlSchema.safeParse(raw);
    if (!parsed.success) return;
    if (parsed.data.action === "snapshot") forward(coordinator.snapshot);
    else if (parsed.data.action === "exit") {
      abort.abort();
      app.exit(0);
    } else if (parsed.data.action === "cancel-data-directory-migration") {
      // 不在 Main 保存待消费意图；只有协调器接纳的当前代取消才能成为下一次 Worker 动作。
      void coordinator
        .cancelDataDirectoryMigration(parsed.data.attemptId)
        .then(launch)
        .catch(rejectBusiness);
    } else void coordinator.retry(parsed.data.attemptId).then(launch).catch(rejectBusiness);
  };
  ipcMain.on(InternalChannels.DatabaseStartupControl, control);
  app.on("second-instance", focus);
  cold.once("closed", () => {
    unregisterColdDataDirectoryWindow(cold.id);
    if (!handedOff) {
      abort.abort();
      if (imported) app.quit();
      else app.exit(0);
    }
  });
  cold.once("ready-to-show", () => cold.show());
  cold.webContents.on("did-finish-load", () => forward(coordinator.snapshot));
  const query = {
    locale,
    restoreSession: "false",
    supportsSettings: "false",
    windowKind: "data-directory-startup",
  };
  const url = process.env.ELECTRON_RENDERER_URL;
  if (url) {
    const target = new URL(url);
    Object.entries(query).forEach(([key, value]) => target.searchParams.set(key, value));
    await cold.loadURL(target.toString());
  } else await cold.loadFile(join(import.meta.dirname, "../renderer/index.html"), { query });
  void run().catch(rejectBusiness);
  await business;
}

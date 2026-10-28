import { expect, it, vi, afterEach } from "vitest";
import { InternalChannels, type DatabaseStartupState } from "@zcode/shared";
const fixture = vi.hoisted(() => ({
  prepare: vi.fn(),
  cancel: vi.fn(async () => {}),
  windows: [] as unknown[],
  cold: new Set<number>(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), {
    getPath: () => "/isolated",
    exit: vi.fn(),
    quit: vi.fn(),
  });
  const ipcMain = new EventEmitter();
  class Window extends EventEmitter {
    id = fixture.windows.length + 1;
    destroyed = false;
    url = "file:///app/renderer/index.html";
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      getURL: () => this.url,
    });
    constructor() {
      super();
      fixture.windows.push(this);
    }
    async loadFile() {
      this.webContents.emit("did-finish-load");
    }
    async loadURL(url: string) {
      this.url = url;
      this.webContents.emit("did-finish-load");
    }
    isDestroyed() {
      return this.destroyed;
    }
    show() {}
    focus() {}
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
  }
  return { app, ipcMain, BrowserWindow: Window };
});
vi.mock("./index.js", () => ({
  createDataDirectoryStartup: () => ({ prepare: fixture.prepare, cancel: fixture.cancel }),
  registerColdDataDirectoryWindow: (id: number) => fixture.cold.add(id),
  unregisterColdDataDirectoryWindow: (id: number) => fixture.cold.delete(id),
}));
import { app, ipcMain, BrowserWindow } from "electron";
import { openDataDirectoryStartupGate } from "./window.js";
afterEach(() => {
  fixture.prepare.mockReset();
  fixture.cancel.mockReset();
  fixture.cancel.mockResolvedValue(undefined);
  fixture.windows.length = 0;
  fixture.cold.clear();
  app.removeAllListeners();
  ipcMain.removeAllListeners();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
it.each([
  "about:blank",
  "https://wrong.example.test/",
  "file:///app/login.html",
  "file:///app/renderer/index.html?windowKind=update-status",
  "file:///app/renderer/index.html?windowKind=data-directory-startup",
])("does not hand off to auxiliary renderer %s", async (auxiliaryUrl) => {
  vi.stubEnv("ELECTRON_RENDERER_URL", undefined);
  fixture.prepare.mockResolvedValue(undefined);
  await openDataDirectoryStartupGate("en-US", async () => {}, "/default");
  const cold = fixture.windows[0] as BrowserWindow;
  const auxiliary = new BrowserWindow({});
  app.emit("browser-window-created", {}, auxiliary);
  await auxiliary.loadURL(auxiliaryUrl);
  auxiliary.emit("ready-to-show");
  expect(cold.isDestroyed()).toBe(false);
  const normal = new BrowserWindow({});
  app.emit("browser-window-created", {}, normal);
  const target = new URL(cold.webContents.getURL());
  target.searchParams.delete("windowKind");
  await normal.loadURL(target.href);
  normal.emit("ready-to-show");
  expect(cold.isDestroyed()).toBe(true);
});
it("hands off only to the exact configured development renderer origin and pathname", async () => {
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://127.0.0.1:5173/app/");
  fixture.prepare.mockResolvedValue(undefined);
  await openDataDirectoryStartupGate("en-US", async () => {}, "/default");
  const cold = fixture.windows[0] as BrowserWindow;
  for (const url of [
    "http://127.0.0.1:5173/other/",
    "http://wrong.example.test:5173/app/",
    "http://127.0.0.1:5173/app/?windowKind=update-status",
  ]) {
    const auxiliary = new BrowserWindow({});
    app.emit("browser-window-created", {}, auxiliary);
    await auxiliary.loadURL(url);
    auxiliary.emit("ready-to-show");
    expect(cold.isDestroyed()).toBe(false);
  }
  const normal = new BrowserWindow({});
  app.emit("browser-window-created", {}, normal);
  await normal.loadURL("http://127.0.0.1:5173/app/?locale=en-US&restoreSession=true");
  normal.emit("ready-to-show");
  expect(cold.isDestroyed()).toBe(true);
});
it("keeps the cold window until a new normal window is ready and never imports business before preparation", async () => {
  let complete!: () => void;
  fixture.prepare.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const load = vi.fn(async () => {});
  const operation = openDataDirectoryStartupGate("en-US", load, "/default");
  await tick();
  expect(load).not.toHaveBeenCalled();
  const cold = fixture.windows[0] as BrowserWindow;
  expect(cold.isDestroyed()).toBe(false);
  complete();
  await operation;
  expect(load).toHaveBeenCalledOnce();
  expect(cold.isDestroyed()).toBe(false);
  const normal = new BrowserWindow({});
  app.emit("browser-window-created", {}, normal);
  normal.emit("ready-to-show");
  expect(cold.isDestroyed()).toBe(true);
  expect(fixture.cold.size).toBe(0);
  expect(app.exit).not.toHaveBeenCalled();
});
it("routes preparation failure through explicit retry while keeping business services closed", async () => {
  fixture.prepare
    .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }))
    .mockResolvedValueOnce(undefined);
  const load = vi.fn(async () => {});
  const operation = openDataDirectoryStartupGate("en-US", load, "/default");
  await tick();
  await tick();
  const cold = fixture.windows[0] as BrowserWindow;
  const calls = vi.mocked(cold.webContents.send).mock.calls;
  const state = calls
    .map((args) => args[1] as DatabaseStartupState)
    .filter((value) => value?.phase === "failed")
    .at(-1)!;
  expect(state.errorCode).toBe("permission_denied");
  expect(load).not.toHaveBeenCalled();
  ipcMain.emit(
    InternalChannels.DatabaseStartupControl,
    { sender: cold.webContents },
    { action: "retry", attemptId: state.attemptId },
  );
  await operation;
  expect(load).toHaveBeenCalledOnce();
  const normal = new BrowserWindow({});
  app.emit("browser-window-created", {}, normal);
  normal.emit("ready-to-show");
  expect(cold.isDestroyed()).toBe(true);
});
it("cancels only a verified failed cold request after its Worker has exited", async () => {
  fixture.prepare.mockRejectedValueOnce(
    Object.assign(new Error("target occupied"), {
      kind: "sql_failed",
      canCancelDataDirectoryMigration: true,
    }),
  );
  const load = vi.fn(async () => {});
  const operation = openDataDirectoryStartupGate("en-US", load, "/default");
  await tick();
  await tick();
  const cold = fixture.windows[0] as BrowserWindow;
  const state = vi
    .mocked(cold.webContents.send)
    .mock.calls.map((args) => args[1] as DatabaseStartupState)
    .filter((value) => value?.phase === "failed")
    .at(-1)!;
  expect(state.canCancelDataDirectoryMigration).toBe(true);
  expect(load).not.toHaveBeenCalled();
  ipcMain.emit(
    InternalChannels.DatabaseStartupControl,
    { sender: cold.webContents },
    { action: "cancel-data-directory-migration", attemptId: state.attemptId },
  );
  await operation;
  expect(fixture.cancel).toHaveBeenCalledOnce();
  expect(fixture.prepare).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledOnce();
  const normal = new BrowserWindow({});
  app.emit("browser-window-created", {}, normal);
  normal.emit("ready-to-show");
  expect(cold.isDestroyed()).toBe(true);
});

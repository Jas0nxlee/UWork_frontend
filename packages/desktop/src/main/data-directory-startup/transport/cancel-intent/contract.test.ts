import { afterEach, expect, it, vi } from "vitest";
import { InternalChannels, type DatabaseStartupState } from "@zcode/shared";

const fixture = vi.hoisted(() => ({
  prepare: vi.fn(),
  cancel: vi.fn(async () => {}),
  windows: [] as unknown[],
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const app = Object.assign(new EventEmitter(), {
    getPath: () => "/isolated",
    exit: vi.fn(),
    quit: vi.fn(),
  });
  class Window extends EventEmitter {
    id = fixture.windows.length + 1;
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      getURL: () => "file:///app/renderer/index.html",
    });
    constructor() {
      super();
      fixture.windows.push(this);
    }
    async loadFile() {
      this.webContents.emit("did-finish-load");
    }
    async loadURL() {
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
  return { app, BrowserWindow: Window, ipcMain: new EventEmitter() };
});
vi.mock("../../index.js", () => ({
  createDataDirectoryStartup: () => ({ prepare: fixture.prepare, cancel: fixture.cancel }),
  registerColdDataDirectoryWindow() {},
  unregisterColdDataDirectoryWindow() {},
}));
import { app, BrowserWindow, ipcMain } from "electron";
import { openDataDirectoryStartupGate } from "../../window.js";
import { DatabaseStartupCoordinator } from "../../../../host/databaseStartupCoordinator.js";

afterEach(() => {
  fixture.prepare.mockReset();
  fixture.cancel.mockClear();
  fixture.windows.length = 0;
  app.removeAllListeners();
  ipcMain.removeAllListeners();
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

it("does not let a stale cancel replace the next accepted prepare retry", async () => {
  const blocked = Object.assign(new Error("target occupied"), {
    kind: "sql_failed",
    canCancelDataDirectoryMigration: true,
  });
  fixture.prepare
    .mockRejectedValueOnce(blocked)
    .mockRejectedValueOnce(blocked)
    .mockResolvedValueOnce(undefined);
  const load = vi.fn(async () => {});
  const operation = openDataDirectoryStartupGate("en-US", load, "/default");
  await tick();
  const cold = fixture.windows[0] as BrowserWindow;
  const failed = () =>
    vi
      .mocked(cold.webContents.send)
      .mock.calls.map((args) => args[1] as DatabaseStartupState)
      .filter((state) => state?.phase === "failed")
      .at(-1)!;
  const firstAttempt = failed().attemptId;
  const dispatch = (action: "retry" | "cancel-data-directory-migration", attemptId: string) =>
    ipcMain.emit(
      InternalChannels.DatabaseStartupControl,
      { sender: cold.webContents },
      { action, attemptId },
    );

  dispatch("retry", firstAttempt);
  await tick();
  const secondAttempt = failed().attemptId;
  expect(secondAttempt).not.toBe(firstAttempt);
  dispatch("cancel-data-directory-migration", firstAttempt);
  await tick();
  dispatch("retry", secondAttempt);
  await operation;

  expect(fixture.prepare).toHaveBeenCalledTimes(3);
  expect(fixture.cancel).not.toHaveBeenCalled();
  expect(load).toHaveBeenCalledOnce();
  const normal = new BrowserWindow({});
  app.emit("browser-window-created", {}, normal);
  normal.emit("ready-to-show");
  expect(cold.isDestroyed()).toBe(true);
});

it.each(["unsupported_runtime", "corrupt"])(
  "admits a validated cancel for %s without enabling ordinary retry",
  async (kind) => {
    fixture.prepare.mockRejectedValueOnce(
      Object.assign(new Error("cannot retry safely"), {
        kind,
        canCancelDataDirectoryMigration: true,
      }),
    );
    const load = vi.fn(async () => {});
    const operation = openDataDirectoryStartupGate("en-US", load, "/default");
    await tick();
    const cold = fixture.windows[0] as BrowserWindow;
    const state = vi
      .mocked(cold.webContents.send)
      .mock.calls.map((args) => args[1] as DatabaseStartupState)
      .filter((value) => value?.phase === "failed")
      .at(-1)!;
    expect(state.errorCode).toBe(kind);
    expect(state.canCancelDataDirectoryMigration).toBe(true);

    ipcMain.emit(
      InternalChannels.DatabaseStartupControl,
      { sender: cold.webContents },
      {
        action: "retry",
        attemptId: state.attemptId,
      },
    );
    await tick();
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    ipcMain.emit(
      InternalChannels.DatabaseStartupControl,
      { sender: cold.webContents },
      {
        action: "cancel-data-directory-migration",
        attemptId: state.attemptId,
      },
    );
    await tick();
    expect(fixture.cancel).toHaveBeenCalledOnce();
    await operation;
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    const normal = new BrowserWindow({});
    app.emit("browser-window-created", {}, normal);
    normal.emit("ready-to-show");
  },
);

it.each(["other-operation", "unconfirmed-owner", "stale-attempt", "partial-services"] as const)(
  "rejects cancel admission for %s without changing the next action",
  async (scenario) => {
    const actions: string[] = [];
    const coordinator = new DatabaseStartupCoordinator({
      ...(scenario === "other-operation" ? {} : { operation: "data-directory-migration" as const }),
      prepare: async (report, action) => {
        actions.push(action);
        report(scenario === "partial-services" ? "starting_services" : "preparing_host_storage");
        throw Object.assign(new Error("blocked"), {
          kind: "corrupt",
          canCancelDataDirectoryMigration: scenario !== "unconfirmed-owner",
        });
      },
      publish: () => {},
    });
    await coordinator.start();
    const before = coordinator.snapshot;
    await coordinator.cancelDataDirectoryMigration(
      scenario === "stale-attempt" ? "stale" : before.attemptId,
    );
    expect(actions).toEqual(["prepare"]);
    expect(coordinator.snapshot.attemptId).toBe(before.attemptId);
    expect(coordinator.snapshot.phase).toBe("failed");
  },
);

it("admits one cancel attempt and rejects concurrent cancel/retry or cancellation after ready", async () => {
  const actions: string[] = [];
  let release!: () => void;
  const coordinator = new DatabaseStartupCoordinator({
    operation: "data-directory-migration",
    prepare: async (report, action) => {
      actions.push(action);
      report("preparing_host_storage");
      if (action === "prepare")
        throw Object.assign(new Error("unsupported"), {
          kind: "unsupported_runtime",
          canCancelDataDirectoryMigration: true,
        });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    publish: () => {},
  });
  await coordinator.start();
  const failed = coordinator.snapshot;
  const cancelling = coordinator.cancelDataDirectoryMigration(failed.attemptId);
  await coordinator.cancelDataDirectoryMigration(failed.attemptId);
  await coordinator.retry(failed.attemptId);
  expect(actions).toEqual(["prepare", "cancel-data-directory-migration"]);
  release();
  await cancelling;
  expect(coordinator.snapshot.phase).toBe("ready");
  expect(coordinator.snapshot.canCancelDataDirectoryMigration).toBeUndefined();
  await coordinator.cancelDataDirectoryMigration(coordinator.snapshot.attemptId);
  expect(actions).toEqual(["prepare", "cancel-data-directory-migration"]);
});

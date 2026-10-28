import { expect, it, vi } from "vitest";
import { tasksStorageWorkerDataSchema, workerMessageSchema } from "./contract.js";
import { exampleWorkerData } from "./contract.example.js";
import { createHostDatabaseStartup } from "./hostDatabaseStartup.js";
const preparations = vi.hoisted(() => ({
  session: vi.fn(async (_options: { cwd: string }) => {}),
  initialize: vi.fn(async () => {}),
}));
vi.mock("./storagePreparationProcesses.js", () => ({
  ensureHostFallbackCwd: async () => {},
  prepareHostStorage: async () => {},
  prepareSessionStorage: preparations.session,
}));
vi.mock("@zcode/services/storage-startup", () => ({
  getTasksIndexDatabasePath: () => "/fixture/tasks.sqlite",
  markTasksStoragePrepared: () => {},
  createSessionStorageOwnershipManifest: async () => ({
    path: "/fixture/ownership.json",
    dispose: async () => {},
  }),
  resolveZCodeAgentSpawnCwd: async (options: { requestedCwd: string }) => ({
    cwd: options.requestedCwd,
  }),
}));
vi.mock("../startupDiskSampler.js", () => ({
  StartupDiskSampler: class {
    async addPath() {}
    sealBaseline() {}
    snapshot() {
      return [];
    }
    start() {}
    stop() {}
  },
}));

it("既有项目均使用显式库时也先准备受控fallback库，才能开放全局新任务", async () => {
  preparations.session.mockClear();
  preparations.initialize.mockClear();
  const startup = createHostDatabaseStartup({
    cwd: "/fixture/managed-fallback",
    workingDirectories: ["/fixture/project-custom"],
    publish: () => {},
    initializeServices: preparations.initialize,
    onFailure: (error) => {
      throw error;
    },
  });
  await startup.coordinator.start();
  expect(startup.coordinator.snapshot.phase).toBe("ready");
  expect(preparations.session.mock.calls.map((args) => args[0])).toEqual([
    expect.objectContaining({ cwd: "/fixture/managed-fallback" }),
    expect.objectContaining({ cwd: "/fixture/project-custom" }),
  ]);
  expect(preparations.initialize).toHaveBeenCalledOnce();
});

it("拒绝空路径和未约定输入，不接受缺少迁移阶段的进度", () => {
  expect(tasksStorageWorkerDataSchema.parse(exampleWorkerData)).toEqual(exampleWorkerData);
  expect(tasksStorageWorkerDataSchema.safeParse({ path: "" }).success).toBe(false);
  expect(tasksStorageWorkerDataSchema.safeParse({ path: "./db", hostId: "other" }).success).toBe(
    false,
  );
  expect(workerMessageSchema.safeParse({ type: "progress" }).success).toBe(false);
  expect(workerMessageSchema.parse({ type: "progress", phase: "maintaining" })).toEqual({
    type: "progress",
    phase: "maintaining",
  });
  expect(workerMessageSchema.parse({ type: "done" })).toEqual({ type: "done" });
});

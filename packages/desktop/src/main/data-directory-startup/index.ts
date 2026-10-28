import { Worker } from "node:worker_threads";
import {
  dataDirectoryWorkerFrameSchema,
  type DataDirectoryPreparationPhase,
  type DataDirectoryStartupContract,
} from "./contract.js";
export { resolveDesktopLifecycleIdentity } from "./identity.js";
const coldWindows = new Set<number>();
export function registerColdDataDirectoryWindow(id: number): void {
  coldWindows.add(id);
}
export function unregisterColdDataDirectoryWindow(id: number): void {
  coldWindows.delete(id);
}
export function isColdDataDirectoryWindow(id: number): boolean {
  return coldWindows.has(id);
}

/** Worker 与 Main 同 PID；任务复制及设置 CAS 只在此独立存储执行面发生。 */
export function createDataDirectoryStartup(
  entry = new URL("./dataDirectoryMigrationWorker.js", import.meta.url),
  homeDir?: string,
  defaultBaseDir?: string,
): DataDirectoryStartupContract {
  const run = (
    action: "prepare" | "cancel",
    report: (phase: DataDirectoryPreparationPhase) => void,
    signal: AbortSignal,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const worker = new Worker(entry, {
        workerData: { schemaVersion: 1, action, defaultBaseDir },
        env: {
          ...process.env,
          ...(homeDir
            ? { HOME: homeDir, USERPROFILE: homeDir, ZCODE_DESKTOP_HOME_DIR: homeDir }
            : {}),
        },
      });
      let done = false;
      let failure: unknown;
      const abort = () => {
        failure ??= Object.assign(new Error("Cold migration aborted"), {
          kind: "transport_closed",
        });
        void worker.terminate();
      };
      signal.addEventListener("abort", abort, { once: true });
      worker.on("message", (raw: unknown) => {
        const parsed = dataDirectoryWorkerFrameSchema.safeParse(raw);
        if (!parsed.success) {
          failure ??= Object.assign(new Error("Invalid cold storage worker frame"), {
            kind: "transport_closed",
          });
          void worker.terminate();
          return;
        }
        const frame = parsed.data;
        if (frame.type === "progress") report(frame.phase);
        else if (frame.type === "done") done = true;
        else
          failure = Object.assign(new Error("Cold storage worker failed"), {
            kind: frame.errorCode,
            code: frame.systemCode,
            errcode: frame.sqliteCode,
            canCancelDataDirectoryMigration: frame.canCancel === true,
          });
      });
      worker.once("error", (error) => {
        failure ??= error;
      });
      worker.once("exit", (code) => {
        signal.removeEventListener("abort", abort);
        if (code === 0 && done && !failure) resolve();
        else
          reject(
            failure ??
              Object.assign(new Error("Cold storage worker exited"), {
                kind: "transport_closed",
              }),
          );
      });
      if (signal.aborted) abort();
    });
  return {
    prepare: (report, signal) => run("prepare", report, signal),
    cancel: (signal) => run("cancel", () => {}, signal),
  };
}

import { parentPort, workerData } from "node:worker_threads";
import {
  executePendingDataDirectoryMigration,
  cancelPendingDataDirectoryMigration,
  canCancelPendingDataDirectoryMigration,
} from "@zcode/services/data-directory-startup";
import { classifyDatabaseStartupError, databaseStartupErrorDetails } from "@zcode/shared";
import {
  assertNoLegacySessionWriters,
  collectLegacySessionWriters,
} from "../../host/database-startup/storagePreparationProcesses.js";

async function run() {
  if (workerData?.schemaVersion !== 1 || !parentPort)
    throw new Error("Invalid cold storage Worker invocation");
  try {
    if (workerData.action === "cancel")
      await cancelPendingDataDirectoryMigration({ defaultDataBaseDir: workerData.defaultBaseDir });
    else
      await executePendingDataDirectoryMigration({
        defaultDataBaseDir: workerData.defaultBaseDir,
        assertNoWriters: (path) =>
          assertNoLegacySessionWriters(path, (source) =>
            collectLegacySessionWriters(source, { includeAllHolders: true }),
          ),
        report: (phase) => parentPort!.postMessage({ type: "progress", phase }),
      });
    parentPort.postMessage({ type: "done" });
  } catch (error) {
    parentPort.postMessage({
      type: "failed",
      errorCode: classifyDatabaseStartupError(error),
      ...databaseStartupErrorDetails(error),
      canCancel: await canCancelPendingDataDirectoryMigration({
        defaultDataBaseDir: workerData.defaultBaseDir,
      }),
    });
    process.exitCode = 1;
  } finally {
    parentPort.close();
  }
}
void run();

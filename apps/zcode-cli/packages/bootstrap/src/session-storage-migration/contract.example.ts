/**
 * cli-session-storage-migration 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type {
  SessionDatabaseMigrationContract,
  SessionDatabaseMigrationOptions,
} from "./contract.js";

export async function exampleCliSessionStorageMigration(
  contract: SessionDatabaseMigrationContract,
  options: SessionDatabaseMigrationOptions,
): Promise<void> {
  await contract.migrate(options);
  await contract.assertReady(options);
}

import type { DataDirectoryStartupContract } from "./contract.js";
/** 仅在启动阶段调用，完成后才创建业务服务；退出窗口时取消当前 Worker。 */
export async function exampleDataDirectoryStartup(
  contract: DataDirectoryStartupContract,
  signal: AbortSignal,
): Promise<void> {
  await contract.prepare(() => {}, signal);
}

/**
 * cua-runtime 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { CuaRuntimeContract } from "./contract.js";

export async function exampleCuaRuntime(contract: CuaRuntimeContract): Promise<unknown> {
  return contract.execute({
    toolName: "list_apps",
    context: {
      sessionId: "example-session",
      runtimeScope: "main",
      workspaceKey: "/example/workspace",
      workspacePath: "/example/workspace",
      deliveryKind: "desktop-continuous",
    },
  });
}

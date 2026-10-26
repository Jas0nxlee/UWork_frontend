import { describe, expect, it } from "vitest";

import { createComputerUseRuntime } from "./index.js";

describe("cua-runtime contract", () => {
  it("缺少可信 Host 的凭据时明确拒绝执行，不能降级为在调用方加载原生驱动", async () => {
    const runtime = createComputerUseRuntime({ env: {} });
    try {
      const result = await runtime.execute({
        toolName: "list_apps",
        context: {
          sessionId: "contract",
          workspaceKey: "/workspace",
          runtimeScope: "main",
          deliveryKind: "desktop-continuous",
        },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { code: "not_authorized" },
      });
    } finally {
      await runtime.dispose();
    }
  });
});

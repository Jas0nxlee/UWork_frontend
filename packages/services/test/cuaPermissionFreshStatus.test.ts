import { describe, expect, it } from "vitest";
import { resolveCuaPermissionStates } from "../src/node.js";

describe("Helper责任身份的fresh权限与运行能力分离", () => {
  const running = { accessibility: "denied" as const, screen_recording: "granted" as const };
  it("fresh拒绝不能被父进程或历史运行granted覆盖", async () => {
    expect(
      await resolveCuaPermissionStates(
        {
          queryPermissionStatusFresh: async () => ({
            accessibility: "denied",
            screen_recording: "granted",
          }),
        },
        { accessibility: "granted", screen_recording: "granted" },
      ),
    ).toEqual({ accessibility: "denied", screen_recording: "granted" });
  });
  it("freshAX已授予但当前实例仍拒绝时需要恢复，不能假绿", async () => {
    expect(
      await resolveCuaPermissionStates(
        {
          queryPermissionStatusFresh: async () => ({
            accessibility: "granted",
            screen_recording: "granted",
          }),
        },
        running,
      ),
    ).toEqual({ accessibility: "stale", screen_recording: "granted" });
  });
  it("同一新实例已实测两项拒绝或授予，保留明确结果；失败时沿用真实运行报告", async () => {
    expect(
      await resolveCuaPermissionStates(
        {
          queryPermissionStatusFresh: async () => ({
            accessibility: "granted",
            screen_recording: "denied",
          }),
        },
        { accessibility: "granted", screen_recording: "granted" },
      ),
    ).toEqual({ accessibility: "granted", screen_recording: "denied" });
    expect(
      await resolveCuaPermissionStates(
        {
          queryPermissionStatusFresh: async () => {
            throw new Error("LS failed");
          },
        },
        running,
      ),
    ).toEqual(running);
  });
});

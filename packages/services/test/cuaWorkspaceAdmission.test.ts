import { describe, expect, it } from "vitest";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import { shouldCreateDefaultCuaProductHelper } from "../src/node.js";

const base = {
  serviceAuthorityMode: "desktop-local" as const,
  hasInjectedResolver: false,
  hasBuiltInCuaPlugin: true,
};
describe("local Helper identity admission", () => {
  it("accepts a local identity and rejects a shared-parser remote identity", () => {
    const remote = buildRemoteWorkspaceIdentity("/workspace", {
      kind: "ssh",
      host: "example.invalid",
      username: "fixture",
    });
    expect(
      shouldCreateDefaultCuaProductHelper({ ...base, workspaceIdentity: "local-fixture" }),
    ).toBe(true);
    expect(shouldCreateDefaultCuaProductHelper({ ...base, workspaceIdentity: remote })).toBe(false);
  });
  it("retains all authority, injected-owner and plugin fences", () => {
    expect(shouldCreateDefaultCuaProductHelper({ ...base, hasRemoteWorkspaceIdentity: true })).toBe(
      false,
    );
    expect(
      shouldCreateDefaultCuaProductHelper({ ...base, serviceAuthorityMode: "standalone-server" }),
    ).toBe(false);
    expect(shouldCreateDefaultCuaProductHelper({ ...base, hasInjectedResolver: true })).toBe(false);
    expect(shouldCreateDefaultCuaProductHelper({ ...base, hasBuiltInCuaPlugin: false })).toBe(
      false,
    );
  });
});

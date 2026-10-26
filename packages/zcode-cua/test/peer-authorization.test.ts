import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCuaPeerAuthorizer } from "../peer-authorization.js";

const connectedSocket = () => ({ destroyed: false, _handle: { fd: 42 } });
function fixture(...args: unknown[]) {
  const result = args.length ? args[0] : true;
  const verifyPeer = vi.fn(async () => result);
  const loadAddon = vi.fn(() => ({ verifyPeer }));
  return { verifyPeer, loadAddon };
}
describe("in-process native Helper peer authorization", () => {
  it("never executes JavaScript disguised as a native addon through a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uwork-peer-addon-link-"));
    try {
      const payload = join(directory, "payload.cjs");
      const nativeAddonPath = join(directory, "peer-addon.node");
      await writeFile(payload, "module.exports = { verifyPeer: async () => true };");
      await symlink(payload, nativeAddonPath);
      await expect(
        createCuaPeerAuthorizer({ nativeAddonPath })(connectedSocket()),
      ).rejects.toMatchObject({ code: "not_authorized" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("loads only the fixed native addon and passes the accepted socket fd", async () => {
    const { loadAddon, verifyPeer } = fixture();
    const authorize = createCuaPeerAuthorizer({
      nativeAddonPath: "/signed/peer-addon.node",
      loadAddon,
    });
    await authorize(connectedSocket());
    expect(loadAddon).toHaveBeenCalledWith("/signed/peer-addon.node");
    expect(verifyPeer).toHaveBeenCalledWith(42);
  });
  it.each([false, undefined, "authorized", 1])(
    "rejects non-true native result %j",
    async (result) => {
      const { loadAddon } = fixture(result);
      await expect(
        createCuaPeerAuthorizer({ nativeAddonPath: "/signed/peer-addon.node", loadAddon })(
          connectedSocket(),
        ),
      ).rejects.toMatchObject({ code: "not_authorized" });
    },
  );
  it("never bypasses production verification when unsigned-local is requested", async () => {
    const { loadAddon, verifyPeer } = fixture(false);
    const authorize = createCuaPeerAuthorizer({
      nativeAddonPath: "/signed/peer-addon.node",
      development: false,
      allowUnsignedLocalDev: true,
      loadAddon,
    });
    await expect(authorize(connectedSocket())).rejects.toMatchObject({ code: "not_authorized" });
    expect(verifyPeer).toHaveBeenCalledOnce();
  });
  it("allows the compiled development plus explicit opt-in without loading native code", async () => {
    const { loadAddon } = fixture(false);
    await createCuaPeerAuthorizer({ development: true, allowUnsignedLocalDev: true, loadAddon })({
      destroyed: false,
    });
    expect(loadAddon).not.toHaveBeenCalled();
    await expect(
      createCuaPeerAuthorizer({
        nativeAddonPath: "/signed/peer-addon.node",
        development: true,
        loadAddon,
      })(connectedSocket()),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });
  it.each([
    undefined,
    "relative/peer-addon.node",
    "/signed/peer-validator",
    "/signed/peer-addon.js",
  ])("refuses non-native addon path %j before loading any code", async (nativeAddonPath) => {
    const { loadAddon } = fixture();
    await expect(
      createCuaPeerAuthorizer({ nativeAddonPath, loadAddon })(connectedSocket()),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(loadAddon).not.toHaveBeenCalled();
  });
  it.each([
    { destroyed: true, _handle: { fd: 42 } },
    { destroyed: false },
    { destroyed: false, _handle: { fd: -1 } },
  ])("fails closed for unavailable socket descriptor %j", async (socket) => {
    const { loadAddon } = fixture();
    await expect(
      createCuaPeerAuthorizer({ nativeAddonPath: "/signed/peer-addon.node", loadAddon })(socket),
    ).rejects.toMatchObject({ code: "not_authorized" });
    expect(loadAddon).not.toHaveBeenCalled();
  });
  it("fails closed on native loading or verification errors", async () => {
    const loadAddon = vi.fn(() => {
      throw new Error("Library validation rejected this addon");
    });
    await expect(
      createCuaPeerAuthorizer({ nativeAddonPath: "/signed/peer-addon.node", loadAddon })(
        connectedSocket(),
      ),
    ).rejects.toMatchObject({ code: "not_authorized" });
    const rejected = fixture();
    rejected.verifyPeer.mockRejectedValueOnce(new Error("Native validation failed"));
    await expect(
      createCuaPeerAuthorizer({
        nativeAddonPath: "/signed/peer-addon.node",
        loadAddon: rejected.loadAddon,
      })(connectedSocket()),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });
  it("rechecks connection lifetime after asynchronous native verification", async () => {
    const socket = connectedSocket();
    const loadAddon = () => ({
      verifyPeer: async () => {
        socket.destroyed = true;
        return true;
      },
    });
    await expect(
      createCuaPeerAuthorizer({ nativeAddonPath: "/signed/peer-addon.node", loadAddon })(socket),
    ).rejects.toMatchObject({ code: "not_authorized" });
  });
});

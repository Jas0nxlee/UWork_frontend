import { isAbsolute } from "node:path";

const denied = () =>
  Object.assign(new Error("Computer Use peer verification failed."), {
    code: "not_authorized",
  });

function loadNativeAddon(path) {
  const module = { exports: {} };
  // require 会追 symlink 后按 .js/.cjs 解释；必须直接 dlopen，强制走 Mach-O 与 Team 校验。
  process.dlopen(module, path);
  return module.exports;
}

/** 原生库由 macOS hardened library validation 约束同 Team；不执行外置脚本或验证器。 */
export function createCuaPeerAuthorizer({
  nativeAddonPath,
  development = false,
  allowUnsignedLocalDev = false,
  loadAddon = loadNativeAddon,
} = {}) {
  let addon;
  return async (socket) => {
    if (!socket || socket.destroyed) throw denied();
    if (development === true && allowUnsignedLocalDev === true) return;
    const fd = socket._handle?.fd;
    if (
      typeof nativeAddonPath !== "string" ||
      !isAbsolute(nativeAddonPath) ||
      !nativeAddonPath.endsWith(".node") ||
      !Number.isInteger(fd) ||
      fd < 0
    )
      throw denied();
    try {
      addon ??= loadAddon(nativeAddonPath);
      if (
        typeof addon?.verifyPeer !== "function" ||
        (await addon.verifyPeer(fd)) !== true ||
        socket.destroyed
      ) {
        throw denied();
      }
    } catch {
      throw denied();
    }
  };
}

// 旧 npm 包的许可字段缺失或使用非 SPDX 拼写，不能因此给所有版本或未知包放行。
// 原作者补充的同版 metadata 和发布包证据见 third-party/README.md。
const reviewed = new Set(["buffers@0.1.1", "chainsaw@0.1.0"]);

/** 复合许可仍保留 MPL 义务，不因同时含 MIT 就归为纯宽松许可。 */
export function isMplWithPermissiveConjunction(raw) {
  const terms = raw
    .replace(/[()]/g, " ")
    .trim()
    .split(/\s+AND\s+/i);
  return (
    terms.length > 1 &&
    terms.includes("MPL-2.0") &&
    terms.every((term) => ["MIT", "MPL-2.0"].includes(term))
  );
}

/** 只接受本次固定驱动版本及原样许可，升级必须重新核对材料。 */
export function isReviewedCuaDriverLicense(pkg) {
  if (
    pkg.name === "@ubjs/core" ||
    pkg.name === "@ubjs/node" ||
    /^@ubjs\/node-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)-(?:gnu|musl)|win32-(?:arm64|x64)-msvc)$/.test(
      pkg.name,
    )
  ) {
    return pkg.version === "0.31.0-3" && pkg.license === "MPL-2.0";
  }
  return (
    /^@trycua\/cua-driver-(?:darwin-(?:arm64|x64)|linux-(?:arm64|x64)-gnu|win32-(?:arm64|x64)-msvc)$/.test(
      pkg.name,
    ) &&
    pkg.version === "0.28.2" &&
    pkg.license === "MIT AND MPL-2.0"
  );
}

export function legacyLicenseIdentifier(pkg) {
  return pkg.name === "buffers" && pkg.version === "0.1.1" ? "MIT/X11" : undefined;
}

export function isReviewedLegacyLicense(pkg) {
  return reviewed.has(`${pkg.name}@${pkg.version}`) && pkg.license === "MIT/X11";
}

// 文档查看器原样分发字体分片并附完整许可；通用分类未收录 OFL 导致导出误阻断。
// 仅接受已核验的精确依赖，不将所有 OFL 字体放行；材料与分发方式见 third-party/README.md。
export function isReviewedBundledFontLicense(pkg) {
  return (
    pkg.name === "@fontsource/noto-sans-sc" && pkg.version === "5.3.1" && pkg.license === "OFL-1.1"
  );
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  legacyLicenseIdentifier,
  isReviewedLegacyLicense,
  isReviewedBundledFontLicense,
  isMplWithPermissiveConjunction,
  isReviewedCuaDriverLicense,
} from "../license-identifiers.mjs";

test("CUA 原生许可复核锁定包、版本和原始复合许可，不放行未来版本或其他包", () => {
  const pkg = {
    name: "@trycua/cua-driver-darwin-arm64",
    version: "0.28.2",
    license: "MIT AND MPL-2.0",
  };
  assert.equal(isReviewedCuaDriverLicense(pkg), true);
  for (const value of [
    { ...pkg, version: "0.28.3" },
    { ...pkg, license: "AGPL-3.0" },
    { ...pkg, name: "@trycua/unreviewed" },
  ])
    assert.equal(isReviewedCuaDriverLicense(value), false);
  assert.equal(
    isReviewedCuaDriverLicense({ name: "@ubjs/node", version: "0.31.0-3", license: "MPL-2.0" }),
    true,
  );
  assert.equal(
    isReviewedCuaDriverLicense({
      name: "@ubjs/unreviewed",
      version: "0.31.0-3",
      license: "MPL-2.0",
    }),
    false,
  );
});

test("MIT AND MPL 保留弱 copyleft 分类，不能放行包含未知或强 copyleft 的复合许可", () => {
  assert.equal(isMplWithPermissiveConjunction("MIT AND MPL-2.0"), true);
  for (const value of [
    "MIT",
    "MIT AND AGPL-3.0",
    "MIT AND MPL-2.0 AND unknown",
    "MIT OR MPL-2.0",
    "MPL-2.0 AND GPL-3.0",
  ]) {
    assert.equal(isMplWithPermissiveConjunction(value), false);
  }
});

test("缺失的历史许可标识仅补齐已核验的精确版本", () => {
  assert.equal(legacyLicenseIdentifier({ name: "buffers", version: "0.1.1" }), "MIT/X11");
  assert.equal(legacyLicenseIdentifier({ name: "buffers", version: "0.1.2" }), undefined);
  assert.equal(legacyLicenseIdentifier({ name: "unrelated", version: "0.1.1" }), undefined);
});

test("旧标识复核不能放行其他版本、其他包或已变化的许可", () => {
  for (const [name, version] of [
    ["buffers", "0.1.1"],
    ["chainsaw", "0.1.0"],
  ]) {
    assert.equal(isReviewedLegacyLicense({ name, version, license: "MIT/X11" }), true);
    assert.equal(isReviewedLegacyLicense({ name, version, license: "AGPL-3.0" }), false);
    assert.equal(isReviewedLegacyLicense({ name, version: "9.9.9", license: "MIT/X11" }), false);
  }
  assert.equal(
    isReviewedLegacyLicense({ name: "unknown", version: "0.1.0", license: "MIT/X11" }),
    false,
  );
});

test("随包字体许可仅接受已核验的包、版本与 OFL 标识", () => {
  const font = { name: "@fontsource/noto-sans-sc", version: "5.3.1", license: "OFL-1.1" };
  assert.equal(isReviewedBundledFontLicense(font), true);
  for (const changed of [
    { name: "@fontsource/unreviewed-font" },
    { version: "5.3.2" },
    { license: "OFL-1.0" },
    { license: "AGPL-3.0" },
    { license: undefined },
  ]) {
    assert.equal(isReviewedBundledFontLicense({ ...font, ...changed }), false);
  }
});

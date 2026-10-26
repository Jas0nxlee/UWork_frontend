import assert from "node:assert/strict";
import test from "node:test";
import { selectWecomReleaseAssets } from "../release-installer-assets.mjs";

const names = [
  "mac-arm64.dmg",
  "mac-x64.dmg",
  "win-x64.exe",
  "linux-x86_64.AppImage",
  "linux-amd64.deb",
  "linux-x86_64.rpm",
  "linux-arm64.AppImage",
  "linux-arm64.deb",
  "linux-aarch64.rpm",
].map((suffix) => `UWork-0.1.2-${suffix}`);
const release = {
  tag_name: "v0.1.2",
  draft: false,
  body: "notes",
  assets: [
    ...names,
    "UWork-0.1.2-mac-arm64.zip",
    "UWork-0.1.2-linux-x64.pkg.tar.zst",
    "UWork-0.1.2-linux-aarch64.pkg.tar.zst",
    "UWork-0.1.3-mac-arm64.dmg",
    "SHA256SUMS",
    "dependency-audit.json",
  ].map((name) => ({ name })),
};

test("全部五平台九个安装包按槽位选择，排除压缩归档和辅助附件", () => {
  const selected = selectWecomReleaseAssets(release);
  assert.deepEqual(
    selected.assets.map((asset) => asset.name),
    names,
  );
  assert.equal(selected.body, "notes");
  assert.equal(release.assets.length, 15);
});

test("任一安装格式/架构缺失或重复都失败，不能回退到 ZIP 或其它版本", () => {
  for (const name of names) {
    assert.throws(
      () =>
        selectWecomReleaseAssets({
          ...release,
          assets: release.assets.filter((asset) => asset.name !== name),
        }),
      /安装文件/,
    );
    assert.throws(
      () => selectWecomReleaseAssets({ ...release, assets: [...release.assets, { name }] }),
      /安装文件/,
    );
  }
  assert.throws(() => selectWecomReleaseAssets(release, "v0.1.3"), /不一致/);
  assert.throws(() => selectWecomReleaseAssets({ ...release, draft: true }), /草稿/);
});

test("Linux 支持打包架构别名，同一槽位有多个别名产物仍判为重复", () => {
  const alternate = {
    ...release,
    assets: names.map((name) => ({
      name: name.replace("x86_64", "x64").replace("amd64", "x64").replace("aarch64", "arm64"),
    })),
  };
  assert.equal(selectWecomReleaseAssets(alternate).assets.length, 9);
  assert.throws(
    () =>
      selectWecomReleaseAssets({
        ...release,
        assets: [...release.assets, { name: "UWork-0.1.2-linux-x64.deb" }],
      }),
    /重复/,
  );
});

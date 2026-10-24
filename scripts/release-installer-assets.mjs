import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { releaseTargets } from "./desktop-release.mjs";

export function validateRelease(release, tag) {
  if (!release || typeof release !== "object" || Array.isArray(release))
    throw new Error("Release 元数据为空或格式错误");
  if (!Array.isArray(release.assets) || !release.assets.length) throw new Error("Release 缺少附件");
  if (release.draft === true) throw new Error(`Release ${tag} 仍是草稿，先公开再同步`);
  if (release.tag_name && release.tag_name !== tag)
    throw new Error(`Release 标签 ${release.tag_name} 与同步标签 ${tag} 不一致`);
}

export async function validateLocalAssets({ config, release }) {
  if (!config.assetDir) throw new Error("缺少发布附件目录 ASSET_DIR");
  const seen = new Set();
  for (const asset of release.assets) {
    if (basename(asset.name) !== asset.name || seen.has(asset.name))
      throw new Error(`非法或重复附件名：${asset.name}`);
    seen.add(asset.name);
    const path = join(config.assetDir, asset.name);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`缺少发布附件：${asset.name}`);
    if (info.size !== asset.size) throw new Error(`附件大小不一致：${asset.name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (asset.digest !== `sha256:${hash.digest("hex")}`)
      throw new Error(`附件摘要不一致：${asset.name}`);
  }
}

export function selectWecomReleaseAssets(release, tag = release?.tag_name) {
  validateRelease(release, tag);
  const version = String(tag).replace(/^v(?=\d)/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("安装文件分发要求明确的发布版本");
  const formats = { mac: [".dmg"], win: [".exe"], linux: [".AppImage", ".deb", ".rpm"] };
  const assets = releaseTargets.flatMap((target) => {
    const [platform, arch] = target.split("-");
    const architectures =
      platform === "linux"
        ? arch === "x64"
          ? ["x64", "x86_64", "amd64"]
          : ["arm64", "aarch64"]
        : [arch];
    // 原三包规则漏掉其它架构和 Linux 安装格式；按发布目标和格式逐槽检查，归档不能补位。
    return formats[platform].map((extension) => {
      const names = architectures.map(
        (value) => `UWork-${version}-${platform}-${value}${extension}`,
      );
      const matches = release.assets.filter((asset) => names.includes(asset?.name));
      if (matches.length !== 1) throw new Error(`必需安装文件缺失或重复：${target}${extension}`);
      return matches[0];
    });
  });
  return { ...release, assets };
}

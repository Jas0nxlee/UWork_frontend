#!/usr/bin/env node
// GitLab 仅保存发布附件；标签引用独立元数据根提交，绝不推送应用源码历史。
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveSyncConfig,
  createGitLabClient,
  apiError,
  messageOf,
  requireValue,
} from "./gitlab-release-client.mjs";
export { resolveSyncConfig } from "./gitlab-release-client.mjs";

import {
  checked,
  listAll,
  inspectGitLab,
  ensureMetadataBranch,
  ensureReleaseTag,
  cleanupSourceBranches,
} from "./gitlab-release-repository.mjs";

export function releaseDescription(release, tag) {
  const body = typeof release?.body === "string" ? release.body.trim() : "";
  if (body) return body;
  const name = typeof release?.name === "string" ? release.name.trim() : "";
  return name || `UWork ${tag}`;
}

export function validateRelease(release, tag) {
  if (!release || typeof release !== "object" || Array.isArray(release))
    throw new Error("Release 元数据为空或格式错误");
  if (!Array.isArray(release.assets) || !release.assets.length)
    throw new Error("Release 缺少附件");
  if (release.draft === true)
    throw new Error(`Release ${tag} 仍是草稿，先公开再同步`);
  if (release.tag_name && release.tag_name !== tag)
    throw new Error(
      `Release 标签 ${release.tag_name} 与同步标签 ${tag} 不一致`,
    );
}

export async function upsertRelease({
  client,
  config,
  release,
  log = console.log,
}) {
  const payload = {
    name:
      typeof release.name === "string" && release.name.trim()
        ? release.name.trim()
        : config.tag,
    tag_name: config.tag,
    description: releaseDescription(release, config.tag),
  };
  const created = await client.request("POST", "/releases", payload);
  if (created.ok) {
    log(`GitLab 创建 Release ${config.tag}`);
    return "created";
  }
  const exists =
    created.status === 409 ||
    (created.status === 400 &&
      /already exists/i.test(JSON.stringify(created.data)));
  if (!exists) throw apiError("POST", "/releases", created);
  const path = `/releases/${encodeURIComponent(config.tag)}`;
  const updated = await client.request("PUT", path, {
    name: payload.name,
    description: payload.description,
  });
  if (!updated.ok) throw apiError("PUT", path, updated);
  log(`GitLab 更新 Release ${config.tag}`);
  return "updated";
}

export function buildAssetLinks({ release, uploaded = new Map() }) {
  const links = (Array.isArray(release.assets) ? release.assets : [])
    .filter((asset) => typeof asset?.name === "string" && asset.name.trim())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((asset) => {
      const packageUrl = uploaded.get(asset.name);
      if (!packageUrl) throw new Error(`附件未上传到 GitLab：${asset.name}`);
      return {
        name: asset.name,
        url: packageUrl,
        link_type: "package",
        // 直链下载路径只使用 URL 安全的文件名，避免 GitLab 对路径做二次编码。
        ...(/^[A-Za-z0-9._-]+$/.test(asset.name)
          ? { direct_asset_path: `/binaries/${asset.name}` }
          : {}),
      };
    })
    .filter(
      (link) => typeof link.url === "string" && /^https?:\/\//.test(link.url),
    );
  if (
    typeof release.html_url === "string" &&
    /^https?:\/\//.test(release.html_url)
  )
    links.push({
      name: "GitHub Release 页面",
      url: release.html_url,
      link_type: "other",
    });
  return links;
}

export async function syncAssetLinks({
  client,
  config,
  links,
  log = console.log,
}) {
  const path = `/releases/${encodeURIComponent(config.tag)}/assets/links`;
  const listed = await client.request("GET", path);
  if (!listed.ok) throw apiError("GET", path, listed);
  const existing = new Map(
    (Array.isArray(listed.data) ? listed.data : []).map((link) => [
      link.name,
      link,
    ]),
  );
  for (const link of links) {
    const current = existing.get(link.name);
    if (!current) {
      const created = await client.request("POST", path, link);
      if (!created.ok) throw apiError("POST", path, created);
      log(`GitLab 新增资产链接 ${link.name}`);
      continue;
    }
    const same =
      current.url === link.url &&
      (current.link_type ?? "other") === link.link_type &&
      (current.direct_asset_path ?? "") === (link.direct_asset_path ?? "");
    if (same) continue;
    const updatePath = `${path}/${current.id}`;
    const updated = await client.request("PUT", updatePath, link);
    if (!updated.ok) throw apiError("PUT", updatePath, updated);
    log(`GitLab 更新资产链接 ${link.name}`);
  }
}

async function packageFileExists({ fetchImpl, config, url }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { "PRIVATE-TOKEN": config.token },
    });
  } catch (error) {
    throw new Error(`检查 GitLab 包文件失败：${messageOf(error)}`);
  }
  if (response.ok) {
    // 只探测状态码，不下载已有包内容。
    if (typeof response.body?.cancel === "function")
      await response.body.cancel().catch(() => {});
    return true;
  }
  if (response.status === 404) return false;
  throw new Error(
    `检查 GitLab 包文件返回 ${response.status} ${(await response.text()).slice(0, 300)}`,
  );
}

export async function uploadReleaseAssets({
  config,
  release,
  fetchImpl = fetch,
  log = console.log,
}) {
  const assets = (Array.isArray(release.assets) ? release.assets : []).filter(
    (asset) => typeof asset?.name === "string" && asset.name.trim(),
  );
  const uploaded = new Map();
  if (!assets.length) {
    log("Release 没有资产，跳过上传");
    return uploaded;
  }
  if (!config.assetDir) throw new Error("缺少发布附件目录 ASSET_DIR");
  for (const asset of [...assets].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (basename(asset.name) !== asset.name)
      throw new Error(`非法资产名：${asset.name}`);
    const file = join(config.assetDir, asset.name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`缺少发布资产文件：${asset.name}`);
    if (
      Number.isInteger(asset.size) &&
      asset.size > 0 &&
      info.size !== asset.size
    )
      throw new Error(
        `发布资产大小不一致：${asset.name}（本地 ${info.size} 字节，GitHub ${asset.size} 字节）`,
      );
    const url = `${config.apiUrl}/packages/generic/${encodeURIComponent(config.packageName)}/${encodeURIComponent(config.packageVersion)}/${encodeURIComponent(asset.name)}`;
    if (await packageFileExists({ fetchImpl, config, url })) {
      log(`资产 ${asset.name} 已在 GitLab 包注册表，跳过上传`);
      uploaded.set(asset.name, url);
      continue;
    }
    log(`上传资产 ${asset.name}（${info.size} 字节）`);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "PUT",
        headers: {
          "PRIVATE-TOKEN": config.token,
          "Content-Length": String(info.size),
        },
        body: createReadStream(file),
        duplex: "half",
      });
    } catch (error) {
      throw new Error(`上传资产 ${asset.name} 失败：${messageOf(error)}`);
    }
    if (!response.ok)
      throw new Error(
        `上传资产 ${asset.name} 失败：GitLab 返回 ${response.status} ${(await response.text()).slice(0, 300)}`,
      );
    await response.text().catch(() => "");
    uploaded.set(asset.name, url);
  }
  return uploaded;
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
    if (info.size !== asset.size)
      throw new Error(`附件大小不一致：${asset.name}`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (asset.digest !== `sha256:${hash.digest("hex")}`)
      throw new Error(`附件摘要不一致：${asset.name}`);
  }
}

export async function verifyPackageFiles({ client, config, release }) {
  const packages = await listAll(
    client,
    `/packages?package_type=generic&package_name=${config.packageName}&package_version=${encodeURIComponent(config.packageVersion)}`,
  );
  const files = [];
  for (const pkg of packages.filter(
    (p) => p.name === config.packageName && p.version === config.packageVersion,
  ))
    files.push(...(await listAll(client, `/packages/${pkg.id}/package_files`)));
  for (const asset of release.assets) {
    const matches = files.filter((f) => f.file_name === asset.name);
    if (
      !matches.length ||
      matches.some(
        (f) =>
          f.size !== asset.size || `sha256:${f.file_sha256}` !== asset.digest,
      )
    )
      throw new Error(`GitLab 包文件大小或摘要不一致：${asset.name}`);
  }
  return files;
}

export async function syncGitLabRelease({
  env = process.env,
  release,
  fetchImpl = fetch,
  log = console.log,
} = {}) {
  const config = resolveSyncConfig(env);
  const client = createGitLabClient({ config, fetchImpl });
  const snapshot = await inspectGitLab({ client });
  if (config.reportPath)
    await writeFile(
      config.reportPath,
      JSON.stringify({ before: snapshot }, null, 2) + "\n",
    );
  log(
    JSON.stringify({
      defaultBranch: snapshot.project.default_branch,
      branches: snapshot.branches.map((b) => ({
        name: b.name,
        sha: b.commit.id,
      })),
      tags: snapshot.tags.map((t) => ({ name: t.name, sha: t.commit.id })),
      releases: snapshot.releases.map((r) => r.tag_name),
    }),
  );
  if (config.inspectOnly) return { inspected: true };
  const metadata =
    release ??
    JSON.parse(
      await readFile(requireValue(env.RELEASE_JSON, "RELEASE_JSON"), "utf8"),
    );
  validateRelease(metadata, config.tag);
  // 删除旧源码标签会同时影响 Release，迁移前先阻止未知其它版本被误处理。
  if (
    config.cleanupSource &&
    (snapshot.tags.some((t) => t.name !== config.tag) ||
      snapshot.releases.some((r) => r.tag_name !== config.tag))
  )
    throw new Error("发现其它标签或 Release，停止源码迁移并先调查");
  await validateLocalAssets({ config, release: metadata });
  const uploaded = await uploadReleaseAssets({
    config,
    release: metadata,
    fetchImpl,
    log,
  });
  await verifyPackageFiles({ client, config, release: metadata });
  log(`GitLab 已校验全部 ${metadata.assets.length} 个包文件大小与 SHA256`);
  const metadataSha = await ensureMetadataBranch({ client, config });
  await ensureReleaseTag({
    client,
    config,
    metadataSha,
    expectedTagSha: snapshot.tags.find((t) => t.name === config.tag)?.commit.id,
    log,
  });
  const outcome = await upsertRelease({
    client,
    config,
    release: metadata,
    log,
  });
  const links = buildAssetLinks({ release: metadata, uploaded });
  await syncAssetLinks({ client, config, links, log });
  const actual = await checked(
    client,
    "GET",
    `/releases/${encodeURIComponent(config.tag)}`,
  );
  if (
    actual.commit?.id !== metadataSha ||
    links.some(
      (link) =>
        !actual.assets?.links?.some(
          (a) => a.name === link.name && a.url === link.url,
        ),
    )
  )
    throw new Error("GitLab Release 回读校验失败");
  if (config.cleanupSource)
    await cleanupSourceBranches({ client, config, snapshot, log });
  const after = await inspectGitLab({ client });
  if (
    after.branches.some(
      (b) => b.name !== config.metadataBranch || b.commit.id !== metadataSha,
    ) ||
    after.tags.some((t) => t.commit.id !== metadataSha)
  )
    throw new Error("GitLab 仍存在源码引用，发布未完成");
  if (config.reportPath)
    await writeFile(
      config.reportPath,
      JSON.stringify(
        {
          before: snapshot,
          after,
          files: metadata.assets.map((a) => ({
            name: a.name,
            size: a.size,
            digest: a.digest,
          })),
          metadataSha,
        },
        null,
        2,
      ) + "\n",
    );
  log(
    `GitLab Release 已同步：${config.webUrl}/-/releases/${encodeURIComponent(config.tag)}；全部附件存储在 GitLab，源码引用为零`,
  );
  return { outcome, tag: config.tag, uploaded: uploaded.size };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await syncGitLabRelease();
  } catch (error) {
    console.error(`[gitlab-sync] ${messageOf(error)}`);
    process.exitCode = 1;
  }
}

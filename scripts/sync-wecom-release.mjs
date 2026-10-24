#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectWecomReleaseAssets, validateLocalAssets } from "./release-installer-assets.mjs";
import { blockDigests, fileBlocks } from "./wecom-block-digest.mjs";
import { createWecomClient, readWecomFilePage } from "./wecom-release-client.mjs";

export function resolveWecomConfig(env) {
  const required = ["WECOM_CORP_ID", "WECOM_SECRET", "WECOM_SPACE_ID", "RELEASE_TAG", "ASSET_DIR"];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error(`缺少微盘同步配置：${missing.join(", ")}`);
  const tag = env.RELEASE_TAG.trim();
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) throw new Error("微盘同步标签必须为正式发布版本");
  return {
    corpId: env.WECOM_CORP_ID.trim(),
    secret: env.WECOM_SECRET.trim(),
    space: env.WECOM_SPACE_ID.trim(),
    folder: env.WECOM_FOLDER_ID?.trim() || env.WECOM_SPACE_ID.trim(),
    tag,
    assetDir: resolve(env.ASSET_DIR),
  };
}

async function listFiles(client, config, folder) {
  const files = [];
  let start = 0;
  const seen = new Set();
  for (;;) {
    const data = await client.request("file_list", {
      spaceid: config.space,
      fatherid: folder,
      sort_type: 1,
      start,
      limit: 1000,
    });
    const page = readWecomFilePage(data);
    files.push(...page.items.filter((file) => file.file_status === 1));
    if (!page.hasMore) return files;
    if (
      !Number.isSafeInteger(data.next_start) ||
      data.next_start <= start ||
      seen.has(data.next_start)
    )
      throw new Error("微盘分页游标无效");
    seen.add(data.next_start);
    start = data.next_start;
  }
}

function named(files, name, type) {
  const matches = files.filter((file) => file.file_name === name);
  if (matches.length > 1) throw new Error(`微盘存在重复同名项：${name}`);
  const file = matches[0];
  if (file && (file.file_type !== type || typeof file.fileid !== "string" || !file.fileid))
    throw new Error(`微盘同名项类型错误：${name}`);
  return file;
}

async function ensureFolder(client, config) {
  const find = async () => named(await listFiles(client, config, config.folder), config.tag, 1);
  const existing = await find();
  if (existing) return existing.fileid;
  try {
    await client.request("file_create", {
      spaceid: config.space,
      fatherid: config.folder,
      file_type: 1,
      file_name: config.tag,
    });
  } catch (error) {
    // 创建成功但响应丢失时必须先回读；不能直接重发创建请求产生重名目录。
    const recovered = await find();
    if (recovered) return recovered.fileid;
    throw error;
  }
  const created = await find();
  if (!created) throw new Error("微盘版本目录创建后回读失败");
  return created.fileid;
}

async function verifyFile(client, config, folder, asset, sha1, fileid) {
  const { file_info: file } = await client.request("file_info", { fileid });
  if (
    !file ||
    file.fileid !== fileid ||
    file.file_name !== asset.name ||
    file.file_type !== 2 ||
    file.file_status !== 1 ||
    file.spaceid !== config.space ||
    file.fatherid !== folder ||
    file.file_size !== asset.size ||
    file.sha?.toLowerCase() !== sha1
  )
    throw new Error(`微盘安装包回读校验失败：${asset.name}`);
}

async function findVerified(client, config, folder, asset, sha1) {
  const file = named(await listFiles(client, config, folder), asset.name, 2);
  if (!file) return undefined;
  await verifyFile(client, config, folder, asset, sha1, file.fileid);
  return file.fileid;
}

async function uploadFile(client, config, folder, asset, hashes) {
  const sha1 = hashes.at(-1);
  let fileid;
  try {
    const init = await client.request("file_upload_init", {
      spaceid: config.space,
      fatherid: folder,
      file_name: asset.name,
      size: asset.size,
      block_sha: hashes,
      skip_push_card: true,
    });
    if (init.hit_exist === true) fileid = init.fileid;
    else {
      if (init.hit_exist !== false || typeof init.upload_key !== "string" || !init.upload_key)
        throw new Error("微盘上传初始化响应无效");
      let index = 0;
      for await (const { block } of fileBlocks(join(config.assetDir, asset.name)))
        await client.request("file_upload_part", {
          upload_key: init.upload_key,
          index: ++index,
          file_base64_content: block.toString("base64"),
        });
      fileid = (await client.request("file_upload_finish", { upload_key: init.upload_key })).fileid;
    }
  } catch (error) {
    // init 秒传或 finish 已提交但响应丢失：用远端文件事实恢复，缺少时留待下次补传。
    const recovered = await findVerified(client, config, folder, asset, sha1);
    if (recovered) return recovered;
    throw error;
  }
  if (typeof fileid !== "string" || !fileid) throw new Error("微盘上传未返回文件凭证");
  await verifyFile(client, config, folder, asset, sha1, fileid);
  return fileid;
}

export async function syncWecomRelease({
  env = process.env,
  release,
  client,
  log = console.log,
} = {}) {
  const report = { status: "failed", files: [] };
  try {
    const config = resolveWecomConfig(env);
    report.tag = config.tag;
    const selected = selectWecomReleaseAssets(
      release ?? JSON.parse(await readFile(env.RELEASE_JSON, "utf8")),
      config.tag,
    );
    await validateLocalAssets({ config, release: selected });
    // 所有分块摘要也在写入前准备；空文件/超大文件不能留下半个发布目录。
    const hashes = new Map();
    for (const asset of selected.assets)
      hashes.set(asset.name, await blockDigests(join(config.assetDir, asset.name)));
    client ??= createWecomClient({ config });
    const folder = await ensureFolder(client, config);
    for (const asset of selected.assets) {
      const blocks = hashes.get(asset.name);
      const existing = await findVerified(client, config, folder, asset, blocks.at(-1));
      if (!existing) await uploadFile(client, config, folder, asset, blocks);
      const file = {
        name: asset.name,
        size: asset.size,
        digest: asset.digest,
        action: existing ? "skipped" : "uploaded",
      };
      report.files.push(file);
      log(`微盘安装包已校验：${asset.name}（${existing ? "已存在，跳过" : "已上传"}）`);
    }
    const actual = await listFiles(client, config, folder);
    for (const asset of selected.assets) {
      const file = named(actual, asset.name, 2);
      if (!file) throw new Error(`微盘最终检查缺少安装包：${asset.name}`);
      await verifyFile(client, config, folder, asset, hashes.get(asset.name).at(-1), file.fileid);
    }
    report.status = "success";
    log(`微盘 ${config.tag} 的 ${selected.assets.length} 个安装包同步完成`);
    return report;
  } finally {
    // 报告只保存源摘要和成功进度，不保存 token、目录标识或服务端原始响应。
    if (env.SYNC_REPORT) await writeFile(env.SYNC_REPORT, JSON.stringify(report, null, 2) + "\n");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await syncWecomRelease();
  } catch (error) {
    console.error(`[wecom-sync] ${error.message}`);
    process.exitCode = 1;
  }
}

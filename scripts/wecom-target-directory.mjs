import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWecomClient,
  isWecomIdentifier,
  readWecomFilePage,
} from "./wecom-release-client.mjs";
import { encryptWecomTarget, validateWecomTargetPublicKey } from "./wecom-release-bootstrap.mjs";
import { withWecomProxy } from "./wecom-release-proxy.mjs";

const SPACE_NAME = "UWork 发布包";
const FOLDER_NAME = "发布包";
const TARGET_NAME = `${SPACE_NAME}/${FOLDER_NAME}`;

export function resolveTargetDirectoryConfig(env) {
  if (["WECOM_CORP_ID", "WECOM_SECRET", "WECOM_SPACE_ID"].some((key) => !env[key]?.trim()))
    throw new Error("缺少一次性目标目录配置");
  const encoded = env.WECOM_TARGET_PUBLIC_KEY?.trim() || "";
  let publicKey;
  try {
    // Buffer.from 的 Base64 解码会忽略非法字符；公钥输入必须完整、规范地解码。
    if (
      !encoded ||
      encoded.length > 16384 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
    )
      throw new Error();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new Error();
    publicKey = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    validateWecomTargetPublicKey(publicKey);
  } catch {
    throw new Error("目标目录交接公钥无效，未执行远端操作");
  }
  const space = env.WECOM_SPACE_ID.trim();
  if (space.startsWith("WECOM_SPACE_ID=")) throw new Error("目标目录空间配置无效");
  return { corpId: env.WECOM_CORP_ID.trim(), secret: env.WECOM_SECRET.trim(), space, publicKey };
}

export async function listDirectory(client, space, folder) {
  const files = [];
  const identifiers = new Set();
  let start = 0;
  for (let count = 0; count < 1000; count++) {
    const page = readWecomFilePage(
      await client.request("file_list", {
        spaceid: space,
        fatherid: folder,
        sort_type: 1,
        start,
        limit: 1000,
      }),
    );
    for (const file of page.items) {
      if (
        !file ||
        !isWecomIdentifier(file.fileid) ||
        identifiers.has(file.fileid) ||
        typeof file.file_name !== "string" ||
        !file.file_name ||
        !Number.isSafeInteger(file.file_type) ||
        file.file_type < 1 ||
        file.file_status !== 1 ||
        (file.spaceid !== undefined && file.spaceid !== space) ||
        (file.fatherid !== undefined && file.fatherid !== folder)
      )
        throw new Error("目标目录清单格式或归属无效");
      identifiers.add(file.fileid);
      files.push(file);
    }
    if (!page.hasMore) return files;
    if (!Number.isSafeInteger(page.nextStart) || page.nextStart <= start)
      throw new Error("目标目录分页未前进");
    start = page.nextStart;
  }
  throw new Error("目标目录分页未完成");
}

export function uniqueTarget(files) {
  const matches = files.filter((file) => file.file_name === FOLDER_NAME);
  if (matches.length > 1 || (matches[0] && matches[0].file_type !== 1))
    throw new Error("目标目录同名或类型冲突");
  return matches[0];
}
const inventory = (files) => files.map((file) => ({ name: file.file_name, type: file.file_type }));
const versions = (files) =>
  inventory(
    files.filter((file) => file.file_type === 1 && /^v?\d+\.\d+\.\d+$/.test(file.file_name)),
  );

export async function prepareWecomTargetDirectory({ config, client, saveHandoff }) {
  let stage = "configuration";
  try {
    validateWecomTargetPublicKey(config.publicKey);
    if (!isWecomIdentifier(config.space) || typeof saveHandoff !== "function") throw new Error();
    client ??= createWecomClient({ config });
    stage = "space";
    const { space_info: info } = await client.request("new_space_info", { spaceid: config.space });
    if (info?.space_name !== SPACE_NAME || !isWecomIdentifier(info.spaceid)) throw new Error();
    const space = info.spaceid;
    stage = "root-inventory";
    let root = await listDirectory(client, space, space);
    let target = uniqueTarget(root);
    let action = "reused";
    if (!target) {
      stage = "create-readback";
      let createdId;
      try {
        const created = await client.request("file_create", {
          spaceid: space,
          fatherid: space,
          file_type: 1,
          file_name: FOLDER_NAME,
        });
        if (isWecomIdentifier(created?.fileid)) createdId = created.fileid;
        action = "created";
      } catch {
        // 创建响应可能丢失；唯一写入路径只调用一次，之后必须回读而不是重发。
        action = "recovered";
      }
      root = await listDirectory(client, space, space);
      target = uniqueTarget(root);
      if (!target || (createdId && createdId !== target.fileid)) throw new Error();
    }
    stage = "target-readback";
    const { file_info: file } = await client.request("file_info", { fileid: target.fileid });
    if (
      !file ||
      file.fileid !== target.fileid ||
      file.file_name !== FOLDER_NAME ||
      file.file_type !== 1 ||
      file.file_status !== 1 ||
      file.spaceid !== space ||
      file.fatherid !== space
    )
      throw new Error();
    const targetFiles = await listDirectory(client, space, target.fileid);
    stage = "final-root-readback";
    root = await listDirectory(client, space, space);
    if (uniqueTarget(root)?.fileid !== target.fileid) throw new Error();
    const report = {
      kind: "wecom-target-directory",
      status: "success",
      action,
      space: { name: SPACE_NAME, type: "space" },
      root: inventory(root),
      target: { name: TARGET_NAME, type: 1, items: inventory(targetFiles) },
      versionFolders: { root: versions(root), target: versions(targetFiles) },
    };
    stage = "encrypted-handoff";
    await saveHandoff(
      encryptWecomTarget({ space, folder: target.fileid, name: TARGET_NAME }, config.publicKey),
    );
    return report;
  } catch {
    // 网络/API 原始错误可能带标识或凭据；此一次性边界只暴露固定阶段。
    throw new Error(`目标目录准备失败（stage=${stage}）；未执行删除、移动或上传`);
  }
}

export async function runChild(
  env,
  signal,
  scriptUrl = import.meta.url,
  childFlag = "--target-directory-child",
) {
  return new Promise((resolveCode, reject) => {
    const child = spawn(
      process.execPath,
      ["--use-env-proxy", fileURLToPath(scriptUrl), childFlag],
      { env, signal, stdio: "inherit" },
    );
    child.once("error", () => reject(new Error("目标目录子进程失败")));
    child.once("close", (code) => resolveCode(code ?? 1));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = resolveTargetDirectoryConfig(process.env);
    if (!process.env.TARGET_HANDOFF || !process.env.TARGET_REPORT) throw new Error();
    if (process.argv.includes("--target-directory-child")) {
      if (
        process.env.NODE_USE_ENV_PROXY !== "1" ||
        process.env.HTTPS_PROXY !== "http://127.0.0.1:17890" ||
        process.env.NO_PROXY !== ""
      )
        throw new Error();
      const report = await prepareWecomTargetDirectory({
        config,
        saveHandoff: (encryptedTarget) =>
          writeFile(process.env.TARGET_HANDOFF, JSON.stringify({ encryptedTarget }) + "\n", {
            mode: 0o600,
            flag: "wx",
          }),
      });
      const serialized = JSON.stringify(report, null, 2) + "\n";
      await writeFile(process.env.TARGET_REPORT, serialized, { mode: 0o600, flag: "wx" });
      console.log(serialized);
    } else {
      if (!process.env.WECOM_PROXY_CONFIG?.trim()) throw new Error();
      process.exitCode = await withWecomProxy({ env: process.env, runSync: runChild });
    }
  } catch {
    console.error("[wecom-target] 目标目录配置、创建或回读失败；未执行删除、移动或上传");
    process.exitCode = 1;
  }
}

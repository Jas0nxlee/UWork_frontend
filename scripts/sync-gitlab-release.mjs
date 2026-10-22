#!/usr/bin/env node
// 把已发布的 GitHub Release 同步到 GitLab：推送标签/分支，创建或更新 Release，并同步资产链接。
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaults = {
  baseUrl: "http://g.ucas.com.cn:8088",
  projectPath: "lijingping/uwork",
  branch: "main",
  packageName: "uwork-release",
};
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const projectPathPattern = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export async function runGitCommand(args) {
  return execFileAsync("git", args, {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 10 * 1024 * 1024,
  });
}

function requireValue(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`缺少必需的环境变量 ${name}`);
  return normalized;
}

function stripSlashes(value) {
  return value.replace(/^\/+|\/+$/g, "");
}

export function parseBoolean(value, name) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "false") return false;
  if (normalized === "true") return true;
  throw new Error(`${name} 必须是 true 或 false，实际为 ${normalized}`);
}

export function validateTag(tag) {
  // 标签会进入 URL 与 Git ref，限制字符集避免注入和非法引用。
  if (!tagPattern.test(tag)) throw new Error(`非法 Release tag：${tag}`);
  return tag;
}

export function resolveSyncConfig(env = process.env) {
  const token = requireValue(env.GITLAB_TOKEN, "GITLAB_TOKEN");
  const baseUrl = stripSlashes(
    requireValue(env.GITLAB_BASE_URL || defaults.baseUrl, "GITLAB_BASE_URL"),
  );
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error(`GITLAB_BASE_URL 必须是 http(s) 地址：${baseUrl}`);
  const projectPath = stripSlashes(env.GITLAB_PROJECT_PATH || defaults.projectPath).replace(
    /\.git$/i,
    "",
  );
  if (
    !projectPathPattern.test(projectPath) ||
    projectPath.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new Error(`非法 GitLab 项目路径：${projectPath}`);
  const branch = env.SYNC_BRANCH?.trim() || defaults.branch;
  if (!branchPattern.test(branch) || branch.includes("..") || branch.includes("//"))
    throw new Error(`非法同步分支：${branch}`);
  const tag = validateTag(requireValue(env.RELEASE_TAG, "RELEASE_TAG"));
  const projectId = encodeURIComponent(projectPath);
  return {
    token,
    baseUrl,
    projectPath,
    projectId,
    apiUrl: `${baseUrl}/api/v4/projects/${projectId}`,
    pushUrl: stripSlashes(env.GITLAB_PUSH_URL?.trim() || `${baseUrl}/${projectPath}.git`),
    webUrl: `${baseUrl}/${projectPath}`,
    branch,
    tag,
    uploadAssets: parseBoolean(env.UPLOAD_ASSETS, "UPLOAD_ASSETS"),
    forceBranch: parseBoolean(env.FORCE_BRANCH, "FORCE_BRANCH"),
    assetDir: env.ASSET_DIR?.trim() || "",
    packageName: defaults.packageName,
    packageVersion: tag.replace(/^v(?=\d)/, ""),
  };
}

function displayUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

export function releaseDescription(release, tag) {
  const body = typeof release?.body === "string" ? release.body.trim() : "";
  if (body) return body;
  const name = typeof release?.name === "string" ? release.name.trim() : "";
  return name || `UWork ${tag}`;
}

export function validateRelease(release, tag) {
  if (!release || typeof release !== "object" || Array.isArray(release))
    throw new Error("Release 元数据为空或格式错误");
  if (release.draft === true) throw new Error(`Release ${tag} 仍是草稿，先公开再同步`);
  if (release.tag_name && release.tag_name !== tag)
    throw new Error(`Release 标签 ${release.tag_name} 与同步标签 ${tag} 不一致`);
}

export function parseRemoteRef(stdout, ref) {
  for (const line of String(stdout).split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && /^[0-9a-f]{40,64}$/.test(sha ?? "")) return sha;
  }
  return "";
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function pushSourceRefs({ config, runGit = runGitCommand, log = console.log }) {
  const directory = await mkdtemp(join(tmpdir(), "gitlab-sync-"));
  const credentials = join(directory, "credentials");
  const url = new URL(config.pushUrl);
  // 令牌只写入 600 权限的临时凭据文件；推送 URL 与命令参数保持无凭据，日志不会泄露。
  if (url.host)
    await writeFile(
      credentials,
      `${url.protocol}//oauth2:${encodeURIComponent(config.token)}@${url.host}\n`,
      { mode: 0o600 },
    );
  const git = (args) => runGit(["-c", `credential.helper=store --file=${credentials}`, ...args]);
  try {
    const tagRef = `refs/tags/${config.tag}`;
    const localTagResult = await git(["rev-parse", "--verify", tagRef]).catch(() => null);
    if (!localTagResult)
      throw new Error(
        `工作区缺少标签 ${config.tag}，请用 fetch-depth: 0 与 fetch-tags 检出后再同步`,
      );
    const localTag = localTagResult.stdout.trim();
    const remoteTag = parseRemoteRef(
      (await git(["ls-remote", config.pushUrl, tagRef])).stdout,
      tagRef,
    );
    if (remoteTag && remoteTag !== localTag)
      throw new Error(
        `GitLab 已存在指向其它提交的标签 ${config.tag}（本地 ${localTag}，远端 ${remoteTag}）；标签不可变，请人工确认`,
      );
    if (remoteTag) log(`标签 ${config.tag} 已存在且指向同一提交，跳过推送`);
    else {
      log(`推送标签 ${config.tag} 到 ${displayUrl(config.pushUrl)}`);
      await git(["push", config.pushUrl, `${tagRef}:${tagRef}`]);
    }

    const branchRef = `refs/heads/${config.branch}`;
    // 分支推进到 Release 对应提交，而不是当前检出点，避免把标签之后的提交带到 GitLab。
    const head = (await git(["rev-parse", `${tagRef}^{commit}`])).stdout.trim();
    const remoteHead = parseRemoteRef(
      (await git(["ls-remote", config.pushUrl, branchRef])).stdout,
      branchRef,
    );
    if (remoteHead === head) {
      log(`分支 ${config.branch} 已指向 ${head}，跳过推送`);
      return;
    }
    let lease = [];
    if (config.forceBranch) {
      const tracking = `refs/remotes/gitlab-sync/${config.branch}`;
      try {
        await git(["fetch", "--no-tags", config.pushUrl, `+${branchRef}:${tracking}`]);
        const expected = (await git(["rev-parse", "--verify", tracking])).stdout.trim();
        lease = [`--force-with-lease=${branchRef}:${expected}`];
      } catch {
        // 远端分支尚不存在时 fetch 无引用可抓，普通推送会创建分支。
      }
    }
    log(`推送分支 ${config.branch}（${head.slice(0, 12)}）`);
    try {
      await git(["push", ...lease, config.pushUrl, `${head}:${branchRef}`]);
    } catch (error) {
      if (
        !config.forceBranch &&
        /non-fast-forward|fetch first|\[rejected\]/i.test(messageOf(error))
      )
        throw new Error(
          `GitLab 分支 ${config.branch} 无法快进到 ${head}；确认后可手工派发并勾选 force_branch 覆盖`,
        );
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function createGitLabClient({ config, fetchImpl = fetch }) {
  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${config.apiUrl}${path}`, {
        method,
        headers: {
          "PRIVATE-TOKEN": config.token,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(
        `无法连接 GitLab ${config.baseUrl}（${messageOf(error)}）；请确认 runner 能访问该地址，校内地址需使用自托管 runner`,
      );
    }
    const text = await response.text();
    let data = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        // 非 JSON 响应保留原文用于报错。
      }
    }
    return { ok: response.ok, status: response.status, data };
  }
  return { request };
}

function apiError(method, path, result) {
  const detail = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  return new Error(
    `GitLab API ${method} ${path} 返回 ${result.status}：${String(detail).slice(0, 500)}`,
  );
}

export async function upsertRelease({ client, config, release, log = console.log }) {
  const payload = {
    name:
      typeof release.name === "string" && release.name.trim() ? release.name.trim() : config.tag,
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
    (created.status === 400 && /already exists/i.test(JSON.stringify(created.data)));
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
      if (!packageUrl)
        return { name: asset.name, url: asset.browser_download_url, link_type: "other" };
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
    .filter((link) => typeof link.url === "string" && /^https?:\/\//.test(link.url));
  if (typeof release.html_url === "string" && /^https?:\/\//.test(release.html_url))
    links.push({ name: "GitHub Release 页面", url: release.html_url, link_type: "other" });
  return links;
}

export async function syncAssetLinks({ client, config, links, log = console.log }) {
  const path = `/releases/${encodeURIComponent(config.tag)}/assets/links`;
  const listed = await client.request("GET", path);
  if (!listed.ok) throw apiError("GET", path, listed);
  const existing = new Map(
    (Array.isArray(listed.data) ? listed.data : []).map((link) => [link.name, link]),
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
    response = await fetchImpl(url, { method: "GET", headers: { "PRIVATE-TOKEN": config.token } });
  } catch (error) {
    throw new Error(`检查 GitLab 包文件失败：${messageOf(error)}`);
  }
  if (response.ok) {
    // 只探测状态码，不下载已有包内容。
    if (typeof response.body?.cancel === "function") await response.body.cancel().catch(() => {});
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
  if (!config.assetDir) throw new Error("已启用 upload_assets，但没有提供资产目录 ASSET_DIR");
  for (const asset of [...assets].sort((a, b) => a.name.localeCompare(b.name))) {
    if (basename(asset.name) !== asset.name) throw new Error(`非法资产名：${asset.name}`);
    const file = join(config.assetDir, asset.name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`缺少发布资产文件：${asset.name}`);
    if (Number.isInteger(asset.size) && asset.size > 0 && info.size !== asset.size)
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
        headers: { "PRIVATE-TOKEN": config.token, "Content-Length": String(info.size) },
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

export async function syncGitLabRelease({
  env = process.env,
  release,
  fetchImpl = fetch,
  runGit = runGitCommand,
  log = console.log,
} = {}) {
  const config = resolveSyncConfig(env);
  const metadata =
    release ?? JSON.parse(await readFile(requireValue(env.RELEASE_JSON, "RELEASE_JSON"), "utf8"));
  validateRelease(metadata, config.tag);
  log(`同步 ${config.tag} 到 ${config.webUrl}`);
  await pushSourceRefs({ config, runGit, log });
  const uploaded = config.uploadAssets
    ? await uploadReleaseAssets({ config, release: metadata, fetchImpl, log })
    : new Map();
  const client = createGitLabClient({ config, fetchImpl });
  const outcome = await upsertRelease({ client, config, release: metadata, log });
  await syncAssetLinks({
    client,
    config,
    links: buildAssetLinks({ release: metadata, uploaded }),
    log,
  });
  log(`GitLab Release 已同步：${config.webUrl}/-/releases/${encodeURIComponent(config.tag)}`);
  return { outcome, tag: config.tag, uploaded: uploaded.size };
}

async function main() {
  await syncGitLabRelease();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`[gitlab-sync] ${messageOf(error)}`);
    process.exitCode = 1;
  }
}

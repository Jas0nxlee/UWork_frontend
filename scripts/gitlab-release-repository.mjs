// 只管理 GitLab 的发布元数据引用；源码迁移必须由显式输入授权。
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

import { apiError } from "./gitlab-release-client.mjs";

export const metadataReadme =
  "# UWork Releases\n\nThis repository distributes packaged UWork releases only.\nApplication source code is maintained on GitHub.\n";

export async function checked(client, method, path, body) {
  const result = await client.request(method, path, body);
  if (!result.ok) throw apiError(method, path, result);
  return result.data;
}

export async function listAll(client, path) {
  const rows = [];
  for (let page = 1; ; page++) {
    const data = await checked(
      client,
      "GET",
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    if (!Array.isArray(data)) throw new Error(`GitLab 列表格式错误：${path}`);
    rows.push(...data);
    if (data.length < 100) return rows;
  }
}

export async function inspectGitLab({ client }) {
  const project = await checked(client, "GET", "");
  const branches = await listAll(client, "/repository/branches");
  const tags = await listAll(client, "/repository/tags");
  const releases = await listAll(client, "/releases");
  return {
    // 项目 API 可能包含管理字段，只持久化引用审计所需白名单，避免将凭据写入 artifact。
    project: { id: project.id, default_branch: project.default_branch },
    branches: branches.map((b) => ({
      name: b.name,
      protected: b.protected,
      commit: { id: b.commit?.id },
    })),
    tags: tags.map((t) => ({
      name: t.name,
      protected: t.protected,
      commit: { id: t.commit?.id },
    })),
    releases: releases.map((r) => ({
      tag_name: r.tag_name,
      name: r.name,
      description: r.description,
      assets: r.assets,
    })),
  };
}

export async function createMetadataCommit(directory) {
  const git = (args) =>
    execFileAsync("git", ["-C", directory, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  await git(["init", "--initial-branch=release-metadata"]);
  await writeFile(join(directory, "README.md"), metadataReadme);
  await git(["add", "--", "README.md"]);
  // 在全新临时仓库创建无父提交；不能从当前 checkout 派生，否则源码历史仍会被标签带过去。
  await git([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=UWork Releases",
    "-c",
    "user.email=releases@users.noreply.github.com",
    "commit",
    "-m",
    "Initialize release distribution metadata",
  ]);
  return (await git(["rev-parse", "HEAD"])).stdout.trim();
}

export async function verifyMetadataCommit({ client, sha }) {
  const commit = await checked(client, "GET", `/repository/commits/${sha}`);
  if (!Array.isArray(commit.parent_ids) || commit.parent_ids.length)
    throw new Error("发布元数据必须是无父历史的根提交");
  const tree = await listAll(client, `/repository/tree?ref=${sha}`);
  if (
    tree.length !== 1 ||
    tree[0].path !== "README.md" ||
    tree[0].type !== "blob"
  )
    throw new Error("元数据提交包含源码或其它文件");
  const file = await checked(
    client,
    "GET",
    `/repository/files/README.md?ref=${sha}`,
  );
  if (Buffer.from(file.content, "base64").toString("utf8") !== metadataReadme)
    throw new Error("元数据 README 内容不匹配");
}

export async function ensureMetadataBranch({ client, config }) {
  const path = `/repository/branches/${config.metadataBranch}`;
  const current = await client.request("GET", path);
  let sha;
  if (current.ok) sha = current.data.commit.id;
  else {
    if (current.status !== 404) throw apiError("GET", path, current);
    const directory = await mkdtemp(join(tmpdir(), "uwork-release-metadata-"));
    try {
      sha = await createMetadataCommit(directory);
      const credentials = join(directory, "credentials");
      const url = new URL(config.pushUrl);
      await writeFile(
        credentials,
        `${url.protocol}//oauth2:${encodeURIComponent(config.token)}@${url.host}\n`,
        { mode: 0o600 },
      );
      await execFileAsync(
        "git",
        [
          "-C",
          directory,
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=store --file=${credentials}`,
          "push",
          config.pushUrl,
          `${sha}:refs/heads/${config.metadataBranch}`,
        ],
        { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  await verifyMetadataCommit({ client, sha });
  return sha;
}

export async function ensureReleaseTag({
  client,
  config,
  metadataSha,
  log = console.log,
}) {
  const path = `/repository/tags/${encodeURIComponent(config.tag)}`;
  const current = await client.request("GET", path);
  if (current.ok && current.data.commit.id === metadataSha) return;
  if (current.ok) {
    if (!config.cleanupSource)
      throw new Error("旧标签包含源码，需要显式 cleanup_source 迁移");
    await checked(client, "DELETE", path);
    log(`已移除旧源码标签 ${config.tag}，重建对应发布元数据标签和 Release`);
  } else if (current.status !== 404) throw apiError("GET", path, current);
  await checked(client, "POST", "/repository/tags", {
    tag_name: config.tag,
    ref: metadataSha,
  });
}

export async function cleanupSourceBranches({
  client,
  config,
  snapshot,
  log = console.log,
}) {
  if (!config.cleanupSource) throw new Error("未授权清理源码分支");
  await checked(client, "PUT", "", { default_branch: config.metadataBranch });
  for (const branch of snapshot.branches) {
    if (branch.name === config.metadataBranch) continue;
    const path = `/repository/branches/${encodeURIComponent(branch.name)}`;
    const current = await client.request("GET", path);
    if (current.status === 404) continue;
    if (!current.ok) throw apiError("GET", path, current);
    if (current.data.commit.id !== branch.commit.id)
      throw new Error(`源码分支 ${branch.name} 发生并发更新，停止清理`);
    // 默认分支已切换，使用项目 API 删除旧分支，包括受保护分支，不放宽保护规则。
    await checked(client, "DELETE", path);
    log(`已删除源码分支 ${branch.name}（${branch.commit.id}）`);
  }
}

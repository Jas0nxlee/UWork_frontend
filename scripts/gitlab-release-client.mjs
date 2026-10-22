// GitLab 发布配置与 API 边界；只记录必要的错误，不输出令牌。
const defaults = {
  baseUrl: "http://g.ucas.com.cn:8088",
  projectPath: "lijingping/uwork",
  metadataBranch: "release-metadata",
  packageName: "uwork-release",
};
const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const projectPathPattern = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export function requireValue(value, name) {
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
    metadataBranch: defaults.metadataBranch,
    tag,
    cleanupSource: parseBoolean(env.CLEANUP_SOURCE, "CLEANUP_SOURCE"),
    inspectOnly: parseBoolean(env.INSPECT_ONLY, "INSPECT_ONLY"),
    reportPath: env.SYNC_REPORT?.trim() || "",
    assetDir: env.ASSET_DIR?.trim() || "",
    packageName: defaults.packageName,
    packageVersion: tag.replace(/^v(?=\d)/, ""),
  };
}

export function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
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

export function apiError(method, path, result) {
  const detail = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  return new Error(
    `GitLab API ${method} ${path} 返回 ${result.status}：${String(detail).slice(0, 500)}`,
  );
}

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAssetLinks,
  parseBoolean,
  parseRemoteRef,
  pushSourceRefs,
  resolveSyncConfig,
  syncAssetLinks,
  syncGitLabRelease,
  uploadReleaseAssets,
  upsertRelease,
  validateRelease,
} from "../sync-gitlab-release.mjs";

const token = "glpat-test-token";
const baseEnv = { GITLAB_TOKEN: token, RELEASE_TAG: "v0.10.0" };
const release = {
  tag_name: "v0.10.0",
  name: "UWork 0.10.0",
  body: "## 本次更新\n\n- 同步测试。",
  html_url: "https://github.com/Jas0nxlee/UWork_frontend/releases/tag/v0.10.0",
  assets: [
    {
      name: "SHA256SUMS",
      size: 4,
      browser_download_url: "https://github.com/example/releases/download/v0.10.0/SHA256SUMS",
    },
  ],
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("配置读取默认 GitLab 地址并编码项目路径", () => {
  const config = resolveSyncConfig(baseEnv);
  assert.equal(config.baseUrl, "http://g.ucas.com.cn:8088");
  assert.equal(config.projectPath, "lijingping/uwork");
  assert.equal(config.apiUrl, "http://g.ucas.com.cn:8088/api/v4/projects/lijingping%2Fuwork");
  assert.equal(config.pushUrl, "http://g.ucas.com.cn:8088/lijingping/uwork.git");
  assert.equal(config.branch, "main");
  assert.equal(config.packageVersion, "0.10.0");
  assert.equal(config.uploadAssets, false);
  assert.equal(config.forceBranch, false);
});

test("配置拒绝缺失令牌、非法标签与非法布尔值", () => {
  assert.throws(() => resolveSyncConfig({ RELEASE_TAG: "v0.10.0" }), /GITLAB_TOKEN/);
  assert.throws(() => resolveSyncConfig({ ...baseEnv, RELEASE_TAG: "-bad" }), /非法 Release tag/);
  assert.throws(
    () => resolveSyncConfig({ ...baseEnv, GITLAB_PROJECT_PATH: "lijingping/../uwork" }),
    /非法 GitLab 项目路径/,
  );
  assert.throws(() => resolveSyncConfig({ ...baseEnv, SYNC_BRANCH: "-main" }), /非法同步分支/);
  assert.throws(() => parseBoolean("yes", "FORCE_BRANCH"), /必须是 true 或 false/);
  assert.equal(parseBoolean(" TRUE ", "x"), true);
  assert.equal(parseBoolean("", "x"), false);
});

test("草稿或标签不一致的 Release 不进入同步", () => {
  assert.throws(() => validateRelease({ ...release, draft: true }, "v0.10.0"), /草稿/);
  assert.throws(() => validateRelease({ ...release, tag_name: "v0.9.0" }, "v0.10.0"), /不一致/);
  assert.doesNotThrow(() => validateRelease(release, "v0.10.0"));
});

test("解析 ls-remote 输出时只接受哈希与精确引用", () => {
  const sha = "a".repeat(40);
  assert.equal(parseRemoteRef(`${sha}\trefs/tags/v0.10.0\n`, "refs/tags/v0.10.0"), sha);
  assert.equal(parseRemoteRef(`${sha}\trefs/tags/v0.10.0\n`, "refs/tags/v0.9.0"), "");
  assert.equal(parseRemoteRef("not-a-hash\trefs/tags/v0.10.0\n", "refs/tags/v0.10.0"), "");
});

test("关闭资产上传时链接指向 GitHub Release 资产", () => {
  const links = buildAssetLinks({ release });
  assert.deepEqual(links[0], {
    name: "SHA256SUMS",
    url: "https://github.com/example/releases/download/v0.10.0/SHA256SUMS",
    link_type: "other",
  });
  assert.deepEqual(links.at(-1), {
    name: "GitHub Release 页面",
    url: release.html_url,
    link_type: "other",
  });
});

test("已上传资产时链接指向 GitLab 包地址且不复用 GitHub 地址", () => {
  const config = resolveSyncConfig(baseEnv);
  const uploaded = new Map([
    ["SHA256SUMS", `${config.apiUrl}/packages/generic/uwork-release/0.10.0/SHA256SUMS`],
  ]);
  const links = buildAssetLinks({ release, uploaded });
  assert.equal(links.length, 2);
  assert.deepEqual(links[0], {
    name: "SHA256SUMS",
    url: `${config.apiUrl}/packages/generic/uwork-release/0.10.0/SHA256SUMS`,
    link_type: "package",
    direct_asset_path: "/binaries/SHA256SUMS",
  });
  assert.ok(!links.some((link) => link.url.includes("github.com/example/releases/download")));
});

function gitStub(responses) {
  const calls = [];
  const runGit = async (args) => {
    calls.push(args);
    const key = args.slice(2).join(" ");
    const value = typeof responses === "function" ? responses(key, calls) : responses[key];
    if (value instanceof Error) throw value;
    return { stdout: value ?? "", stderr: "" };
  };
  return { calls, runGit };
}

test("推送标签和快进分支，并使用临时凭据文件", async () => {
  const sha = "b".repeat(40);
  let credentialFile;
  let credentialContent;
  const runGit = async (args) => {
    assert.notEqual(args[1].includes(token), true, "命令行参数不能包含令牌");
    const helper = args[1].match(/store --file=(.+)$/)?.[1];
    if (helper && !credentialFile) {
      credentialFile = helper;
      credentialContent = await readFile(helper, "utf8");
    }
    const command = args.slice(2).join(" ");
    if (command === "rev-parse --verify refs/tags/v0.10.0") return { stdout: `${sha}\n` };
    if (command === "rev-parse refs/tags/v0.10.0^{commit}") return { stdout: `${sha}\n` };
    if (command.startsWith("ls-remote")) return { stdout: "" };
    return { stdout: "", stderr: "" };
  };
  await pushSourceRefs({ config: resolveSyncConfig(baseEnv), runGit, log: () => {} });
  assert.match(credentialContent, /oauth2:glpat-test-token@/);
  assert.ok(credentialFile);
  await assert.rejects(readFile(credentialFile, "utf8"), /ENOENT/);
  assert.match(credentialContent, /^http:\/\/oauth2:/);
});

test("缺少本地标签时同步失败", async () => {
  const { runGit } = gitStub(() => new Error("fatal: Needed a single revision"));
  await assert.rejects(
    pushSourceRefs({ config: resolveSyncConfig(baseEnv), runGit, log: () => {} }),
    /工作区缺少标签/,
  );
});

test("标签冲突时拒绝移动 GitLab 标签", async () => {
  const { runGit } = gitStub({
    "rev-parse --verify refs/tags/v0.10.0": "a".repeat(40),
    "ls-remote http://g.ucas.com.cn:8088/lijingping/uwork.git refs/tags/v0.10.0": `${"c".repeat(40)}\trefs/tags/v0.10.0\n`,
  });
  await assert.rejects(
    pushSourceRefs({ config: resolveSyncConfig(baseEnv), runGit, log: () => {} }),
    /标签不可变/,
  );
});

test("非快进分支默认失败并提示 force_branch", async () => {
  const sha = "b".repeat(40);
  const { runGit } = gitStub((command) => {
    if (command.startsWith("rev-parse")) return sha;
    if (command.startsWith("ls-remote")) return "";
    if (command.startsWith("push") && command.includes(":refs/heads/main"))
      throw new Error("Command failed: git push\n ! [rejected] main -> main (non-fast-forward)");
    return "";
  });
  await assert.rejects(
    pushSourceRefs({ config: resolveSyncConfig(baseEnv), runGit, log: () => {} }),
    /force_branch/,
  );
});

test("force_branch 使用 force-with-lease 覆盖远端分支", async () => {
  const sha = "b".repeat(40);
  const remote = "d".repeat(40);
  const pushed = [];
  const { runGit } = gitStub((command) => {
    if (command.includes("refs/remotes/gitlab-sync/main")) return remote;
    if (command.startsWith("rev-parse")) return sha;
    if (command.startsWith("ls-remote")) return "";
    if (command.startsWith("fetch")) return "";
    if (command.startsWith("push")) pushed.push(command);
    return "";
  });
  await pushSourceRefs({
    config: resolveSyncConfig({ ...baseEnv, FORCE_BRANCH: "true" }),
    runGit,
    log: () => {},
  });
  const push = pushed.find((command) => command.includes(":refs/heads/main"));
  assert.match(push, new RegExp(`^push .*${sha}:refs/heads/main$`));
  assert.match(push, new RegExp(`--force-with-lease=refs/heads/main:${remote}`));
});

test("Release 已存在时改用更新接口", async () => {
  const requests = [];
  const client = {
    request: async (method, path, body) => {
      requests.push({ method, path, body });
      if (method === "POST")
        return { ok: false, status: 409, data: { message: "Release already exists" } };
      return jsonResponse(200, {});
    },
  };
  const outcome = await upsertRelease({
    client,
    config: resolveSyncConfig(baseEnv),
    release,
    log: () => {},
  });
  assert.equal(outcome, "updated");
  assert.equal(requests[0].body.description, release.body);
  assert.equal(requests[1].method, "PUT");
  assert.equal(requests[1].path, "/releases/v0.10.0");
});

test("Release 创建失败时保留原始接口错误", async () => {
  const client = {
    request: async () => ({ ok: false, status: 403, data: { message: "Forbidden" } }),
  };
  await assert.rejects(
    upsertRelease({ client, config: resolveSyncConfig(baseEnv), release, log: () => {} }),
    /403.*Forbidden/,
  );
});

test("资产链接按名称幂等新增或更新，不删除其它链接", async () => {
  const requests = [];
  const client = {
    request: async (method, path, body) => {
      requests.push({ method, path, body });
      if (method === "GET")
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: 7,
              name: "SHA256SUMS",
              url: "https://old.example/SHA256SUMS",
              link_type: "other",
            },
            { id: 9, name: "手工链接", url: "https://example/manual", link_type: "other" },
          ],
        };
      return { ok: true, status: method === "POST" ? 201 : 200, data: {} };
    },
  };
  await syncAssetLinks({
    client,
    config: resolveSyncConfig(baseEnv),
    links: [{ name: "SHA256SUMS", url: "https://new.example/SHA256SUMS", link_type: "other" }],
    log: () => {},
  });
  assert.deepEqual(
    requests.slice(1).map(({ method, path }) => `${method} ${path}`),
    ["PUT /releases/v0.10.0/assets/links/7"],
  );
});

test("上传资产前校验大小并提交到 Generic Package Registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitlab-sync-test-"));
  try {
    await writeFile(join(directory, "SHA256SUMS"), "abc\n");
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push(`${options.method} ${url}`);
      if (options.method === "GET") return jsonResponse(404, { message: "404 File Not Found" });
      assert.equal(options.headers["PRIVATE-TOKEN"], token);
      assert.equal(options.headers["Content-Length"], "4");
      assert.equal(options.duplex, "half");
      for await (const _chunk of options.body) {
        // 消费流以确认请求体可读。
      }
      return jsonResponse(201, {});
    };
    const uploaded = await uploadReleaseAssets({
      config: { ...resolveSyncConfig(baseEnv), assetDir: directory },
      release,
      fetchImpl,
      log: () => {},
    });
    assert.equal(
      uploaded.get("SHA256SUMS"),
      "http://g.ucas.com.cn:8088/api/v4/projects/lijingping%2Fuwork/packages/generic/uwork-release/0.10.0/SHA256SUMS",
    );
    assert.equal(requests.length, 2);
    assert.match(requests[0], /^GET /);
    assert.match(requests[1], /^PUT /);

    await assert.rejects(
      uploadReleaseAssets({
        config: { ...resolveSyncConfig(baseEnv), assetDir: directory },
        release: { ...release, assets: [{ ...release.assets[0], size: 99 }] },
        fetchImpl,
        log: () => {},
      }),
      /大小不一致/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("包文件中已存在时跳过重复上传", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gitlab-sync-test-"));
  try {
    await writeFile(join(directory, "SHA256SUMS"), "abc\n");
    const methods = [];
    const fetchImpl = async (_url, options) => {
      methods.push(options.method);
      return jsonResponse(200, { file_name: "SHA256SUMS" });
    };
    const uploaded = await uploadReleaseAssets({
      config: { ...resolveSyncConfig(baseEnv), assetDir: directory },
      release,
      fetchImpl,
      log: () => {},
    });
    assert.deepEqual(methods, ["GET"]);
    assert.ok(uploaded.has("SHA256SUMS"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("完整同步按推送、创建 Release、写链接的顺序执行", async () => {
  const sha = "e".repeat(40);
  const order = [];
  const runGit = async (args) => {
    const command = args.slice(2).join(" ");
    if (command.startsWith("rev-parse")) return { stdout: `${sha}\n` };
    if (command.startsWith("ls-remote")) return { stdout: "" };
    if (command.startsWith("push")) order.push("push");
    return { stdout: "" };
  };
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname.replace("/api/v4/projects/lijingping%2Fuwork", "");
    order.push(`${options.method} ${path}`);
    if (path === "/releases") return jsonResponse(201, {});
    if (path.endsWith("/assets/links") && options.method === "GET") return jsonResponse(200, []);
    return jsonResponse(201, {});
  };
  const result = await syncGitLabRelease({
    env: { ...baseEnv, UPLOAD_ASSETS: "false" },
    release,
    runGit,
    fetchImpl,
    log: () => {},
  });
  assert.equal(result.outcome, "created");
  assert.deepEqual(order, [
    "push",
    "push",
    "POST /releases",
    "GET /releases/v0.10.0/assets/links",
    "POST /releases/v0.10.0/assets/links",
    "POST /releases/v0.10.0/assets/links",
  ]);
});

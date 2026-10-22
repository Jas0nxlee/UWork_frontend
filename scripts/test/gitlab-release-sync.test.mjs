import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAssetLinks,
  resolveSyncConfig,
  validateRelease,
  uploadReleaseAssets,
  upsertRelease,
  syncAssetLinks,
  verifyPackageFiles,
  validateLocalAssets,
  syncGitLabRelease,
} from "../sync-gitlab-release.mjs";
const token = "test-token";
const baseEnv = { GITLAB_TOKEN: token, RELEASE_TAG: "v0.1.0" };
const digest = createHash("sha256").update("abc\n").digest("hex");
const release = {
  tag_name: "v0.1.0",
  name: "UWork 0.1.0",
  body: "发布说明",
  html_url: "https://github.com/example/releases/tag/v0.1.0",
  assets: [
    {
      name: "SHA256SUMS",
      size: 4,
      digest: `sha256:${digest}`,
      browser_download_url: "https://github.com/example/download/SHA256SUMS",
    },
  ],
};
const ok = (data = {}, status = 200) => ({ ok: true, status, data });
const config = () => resolveSyncConfig(baseEnv);

test("发布配置固定为附件上传和独立元数据分支，不接受旧源码开关", () => {
  const c = resolveSyncConfig({
    ...baseEnv,
    UPLOAD_ASSETS: "false",
    SYNC_BRANCH: "main",
    FORCE_BRANCH: "true",
  });
  assert.equal(c.metadataBranch, "release-metadata");
  assert.equal(c.cleanupSource, false);
  assert.equal(c.pushUrl, "http://g.ucas.com.cn:8088/lijingping/uwork.git");
  assert.equal(c.packageVersion, "0.1.0");
  assert.throws(() => resolveSyncConfig({ RELEASE_TAG: "v0.1.0" }), /GITLAB_TOKEN/);
  assert.throws(() => resolveSyncConfig({ ...baseEnv, RELEASE_TAG: "-bad" }), /非法/);
  assert.throws(() => resolveSyncConfig({ ...baseEnv, GITLAB_PROJECT_PATH: "a/../b" }), /非法/);
});

test("草稿、无附件或标签不一致不能同步", () => {
  assert.throws(() => validateRelease({ ...release, draft: true }, "v0.1.0"), /草稿/);
  assert.throws(() => validateRelease({ ...release, assets: [] }, "v0.1.0"), /附件/);
  assert.throws(() => validateRelease(release, "v0.2.0"), /不一致/);
});

test("附件链接必须全部指向 GitLab，不能退回 GitHub 下载链接", () => {
  assert.throws(() => buildAssetLinks({ release }), /未上传/);
  const url = `${config().apiUrl}/packages/generic/uwork-release/0.1.0/SHA256SUMS`;
  const links = buildAssetLinks({
    release,
    uploaded: new Map([["SHA256SUMS", url]]),
  });
  assert.equal(links[0].url, url);
  assert.equal(links[0].link_type, "package");
  assert.equal(links.at(-1).url, release.html_url);
});

test("所有本地附件在任何上传前检查大小与 SHA256", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assets-test-"));
  try {
    await writeFile(join(directory, "SHA256SUMS"), "abc\n");
    await validateLocalAssets({
      config: { ...config(), assetDir: directory },
      release,
    });
    await writeFile(join(directory, "SHA256SUMS"), "bad\n");
    await assert.rejects(
      validateLocalAssets({
        config: { ...config(), assetDir: directory },
        release,
      }),
      /摘要/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("上传流至 GitLab 包注册表，重复文件不重复上传", async () => {
  const directory = await mkdtemp(join(tmpdir(), "upload-test-"));
  try {
    await writeFile(join(directory, "SHA256SUMS"), "abc\n");
    let exists = false;
    const calls = [];
    const fetchImpl = async (_url, options) => {
      calls.push(options.method);
      if (options.method === "GET")
        return { ok: exists, status: exists ? 200 : 404, text: async () => "" };
      assert.equal(options.headers["PRIVATE-TOKEN"], token);
      for await (const _ of options.body) {
        /* 消费真实上传流。 */
      }
      exists = true;
      return { ok: true, status: 201, text: async () => "" };
    };
    for (let i = 0; i < 2; i++)
      await uploadReleaseAssets({
        config: { ...config(), assetDir: directory },
        release,
        fetchImpl,
        log: () => {},
      });
    assert.deepEqual(calls, ["GET", "PUT", "GET"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("远端包文件必须大小、SHA256 全部匹配；同名损坏文件不能视为成功", async () => {
  let fileSha = digest;
  const client = {
    request: async (_method, path) =>
      ok(
        path.startsWith("/packages?")
          ? [{ id: 7, version: "0.1.0", name: "uwork-release" }]
          : [{ file_name: "SHA256SUMS", size: 4, file_sha256: fileSha }],
      ),
  };
  await verifyPackageFiles({ client, config: config(), release });
  fileSha = "0".repeat(64);
  await assert.rejects(verifyPackageFiles({ client, config: config(), release }), /摘要/);
});

test("Release 已存在按名称更新链接，保留手工链接", async () => {
  const calls = [];
  const client = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (path === "/releases" && method === "POST") return { ok: false, status: 409, data: {} };
      if (method === "GET")
        return ok([{ id: 7, name: "SHA256SUMS", url: "https://old.example/file" }]);
      return ok();
    },
  };
  assert.equal(
    await upsertRelease({ client, config: config(), release, log: () => {} }),
    "updated",
  );
  await syncAssetLinks({
    client,
    config: config(),
    links: [
      {
        name: "SHA256SUMS",
        url: "https://gitlab.example/file",
        link_type: "package",
      },
    ],
    log: () => {},
  });
  assert.ok(calls.some((x) => x.method === "PUT" && x.path.endsWith("/links/7")));
  assert.ok(!calls.some((x) => x.method === "DELETE"));
});

test("本地附件不完整时完整同步不会写远端", async () => {
  const methods = [];
  await assert.rejects(
    syncGitLabRelease({
      env: { ...baseEnv, ASSET_DIR: "/nonexistent-release-assets" },
      release,
      fetchImpl: async (_url, options) => {
        methods.push(options.method);
        return { ok: true, status: 200, text: async () => "[]" };
      },
      log: () => {},
    }),
    /缺少/,
  );
  assert.ok(methods.every((x) => x === "GET"));
});

test("工作流总是下载附件、不检出源码历史，自动入口不暴露强推开关", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/gitlab-release-sync.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    workflow,
    /upload_assets:|force_branch:|fetch-tags:|fetch-depth: 0|SYNC_BRANCH:/,
  );
  assert.match(workflow, /Download release assets/);
  assert.match(workflow, /cleanup_source:/);
  assert.match(workflow, /group: gitlab-release-sync\s/);
});

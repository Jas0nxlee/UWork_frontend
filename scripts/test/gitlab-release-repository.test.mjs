import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSyncConfig } from "../gitlab-release-client.mjs";
import {
  ensureReleaseTag,
  cleanupSourceBranches,
  inspectGitLab,
  createMetadataCommit,
  metadataReadme,
  verifyMetadataCommit,
} from "../gitlab-release-repository.mjs";
const exec = promisify(execFile);
const config = () => resolveSyncConfig({ GITLAB_TOKEN: "test-token", RELEASE_TAG: "v0.1.0" });
const ok = (data = {}, status = 200) => ({ ok: true, status, data });

test("实际元数据提交只有 README、没有源码父提交且不读取调用目录历史", async () => {
  const directory = await mkdtemp(join(tmpdir(), "metadata-test-"));
  try {
    const sha = await createMetadataCommit(directory);
    const { stdout: parents } = await exec("git", [
      "-C",
      directory,
      "rev-list",
      "--parents",
      "-n",
      "1",
      sha,
    ]);
    assert.equal(parents.trim(), sha);
    const { stdout: files } = await exec("git", ["-C", directory, "ls-tree", "--name-only", sha]);
    assert.equal(files.trim(), "README.md");
    assert.equal(await readFile(join(directory, "README.md"), "utf8"), metadataReadme);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("元数据检查拒绝含源码或父历史的提交", async () => {
  const client = {
    request: async (_method, path) =>
      ok(path.includes("/commits/") ? { parent_ids: ["old-source"] } : []),
  };
  await assert.rejects(verifyMetadataCommit({ client, sha: "metadata" }), /根提交/);
});

test("普通发布拒绝源码标签，不隐式删除 Release", async () => {
  const calls = [];
  const client = {
    request: async (method) => {
      calls.push(method);
      return ok({ commit: { id: "source" } });
    },
  };
  await assert.rejects(
    ensureReleaseTag({
      client,
      config: config(),
      metadataSha: "metadata",
      log: () => {},
    }),
    /迁移/,
  );
  assert.deepEqual(calls, ["GET"]);
});

test("显式迁移重建旧源码标签，后续创建 Release；重跑不移动元数据标签", async () => {
  const calls = [];
  const client = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === "GET") return ok({ commit: { id: "source" } });
      return ok();
    },
  };
  await ensureReleaseTag({
    client,
    config: { ...config(), cleanupSource: true },
    metadataSha: "metadata",
    log: () => {},
  });
  assert.deepEqual(
    calls.map((x) => x.method),
    ["GET", "DELETE", "POST"],
  );
  assert.equal(calls.at(-1).body.ref, "metadata");
  calls.length = 0;
  client.request = async (method) => {
    calls.push(method);
    return ok({ commit: { id: "metadata" } });
  };
  await ensureReleaseTag({
    client,
    config: config(),
    metadataSha: "metadata",
    log: () => {},
  });
  assert.deepEqual(calls, ["GET"]);
});

test("只读 inspect 分页读取全部引用，不发送写请求", async () => {
  const methods = [];
  const client = {
    request: async (method, path) => {
      methods.push(method);
      if (!path) return ok({ default_branch: "main" });
      return ok(path.includes("page=1") ? [{ name: "main", commit: { id: "source" } }] : []);
    },
  };
  const snapshot = await inspectGitLab({ client });
  assert.equal(snapshot.branches.length, 1);
  assert.ok(methods.every((x) => x === "GET"));
});

test("清理先切换默认分支，再删除源码分支；引用并发变化时停止", async () => {
  const calls = [];
  const snapshot = { branches: [{ name: "main", commit: { id: "source" } }] };
  const client = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return ok(method === "GET" ? { commit: { id: "source" } } : {});
    },
  };
  await cleanupSourceBranches({
    client,
    config: { ...config(), cleanupSource: true },
    snapshot,
    log: () => {},
  });
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].body.default_branch, "release-metadata");
  assert.equal(calls.at(-1).method, "DELETE");
  client.request = async (method) => ok(method === "GET" ? { commit: { id: "newer" } } : {});
  await assert.rejects(
    cleanupSourceBranches({
      client,
      config: { ...config(), cleanupSource: true },
      snapshot,
      log: () => {},
    }),
    /并发/,
  );
  await assert.rejects(cleanupSourceBranches({ client, config: config(), snapshot }), /未授权/);
});

test("删除受保护源码分支时只移除对应精确规则，删除失败则恢复保护", async () => {
  const calls = [];
  const client = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === "GET" && path.startsWith("/repository/branches/"))
        return ok({ protected: true, commit: { id: "source" } });
      if (method === "GET")
        return ok({
          name: "main",
          allow_force_push: false,
          push_access_levels: [{ access_level: 40 }],
          merge_access_levels: [{ access_level: 40 }],
        });
      if (method === "DELETE" && path.startsWith("/repository/branches/"))
        return { ok: false, status: 500, data: {} };
      return ok();
    },
  };
  await assert.rejects(
    cleanupSourceBranches({
      client,
      config: { ...config(), cleanupSource: true },
      snapshot: { branches: [{ name: "main", commit: { id: "source" } }] },
      log: () => {},
    }),
    /500/,
  );
  assert.ok(calls.some((x) => x.method === "DELETE" && x.path === "/protected_branches/main"));
  assert.equal(calls.at(-1).method, "POST");
  assert.equal(calls.at(-1).body.name, "main");
  assert.equal(calls.at(-1).body.allow_force_push, false);
});

test("源码标签在审计后发生并发移动时不删除", async () => {
  const calls = [];
  const client = {
    request: async (method) => {
      calls.push(method);
      return ok({ commit: { id: "new-source" } });
    },
  };
  await assert.rejects(
    ensureReleaseTag({
      client,
      config: { ...config(), cleanupSource: true },
      metadataSha: "metadata",
      expectedTagSha: "source",
      log: () => {},
    }),
    /并发/,
  );
  assert.deepEqual(calls, ["GET"]);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blockDigests, BLOCK_SIZE } from "../wecom-block-digest.mjs";
import { resolveWecomConfig, syncWecomRelease } from "../sync-wecom-release.mjs";
import { createWecomClient } from "../wecom-release-client.mjs";

const names = ["mac-arm64.dmg", "win-x64.exe", "linux-amd64.deb"].map(
  (suffix) => `UWork-0.1.2-${suffix}`,
);
const env = {
  WECOM_CORP_ID: "test-corp",
  WECOM_SECRET: "test-secret",
  WECOM_SPACE_ID: "space",
  WECOM_FOLDER_ID: "parent",
  RELEASE_TAG: "v0.1.2",
};
const sha = (algorithm, data) => createHash(algorithm).update(data).digest("hex");

async function fixture(t, content = Buffer.from("installer fixture")) {
  const dir = await mkdtemp(join(tmpdir(), "wecom-sync-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assets = await Promise.all(
    names.map(async (name) => {
      await writeFile(join(dir, name), content);
      return { name, size: content.length, digest: `sha256:${sha("sha256", content)}` };
    }),
  );
  return {
    env: { ...env, ASSET_DIR: dir, SYNC_REPORT: join(dir, "report.json") },
    release: { tag_name: env.RELEASE_TAG, draft: false, assets },
    dir,
  };
}

// 以有状态的服务替身模拟结果丢失、分页和服务端摘要，验证补传结果而非固定调用顺序。
function disk({ loseCreate = false, loseFinish = false, failPart = false, conflict = false } = {}) {
  const files = new Map();
  const uploads = new Map();
  let counter = 0;
  let initialized = 0;
  let writes = 0;
  const request = async (operation, payload) => {
    if (operation === "file_list") {
      const all = [...files.values()].filter((file) => file.fatherid === payload.fatherid);
      const items = all.slice(payload.start, payload.start + 1);
      return {
        file_list: { item: items },
        has_more: payload.start + items.length < all.length,
        next_start: payload.start + items.length,
      };
    }
    if (operation === "file_info") return { file_info: files.get(payload.fileid) };
    writes++;
    if (operation === "file_create") {
      const fileid = `folder-${++counter}`;
      files.set(fileid, { ...payload, fileid, file_status: 1 });
      if (loseCreate) {
        loseCreate = false;
        throw new Error("ambiguous create");
      }
      return { fileid };
    }
    if (operation === "file_upload_init") {
      initialized++;
      const upload_key = `upload-${++counter}`;
      uploads.set(upload_key, { ...payload, parts: new Map() });
      return { hit_exist: false, upload_key };
    }
    if (operation === "file_upload_part") {
      if (failPart) throw new Error("part unavailable");
      uploads
        .get(payload.upload_key)
        .parts.set(payload.index, Buffer.from(payload.file_base64_content, "base64"));
      return {};
    }
    if (operation === "file_upload_finish") {
      const upload = uploads.get(payload.upload_key);
      const content = Buffer.concat(
        [...upload.parts.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]),
      );
      const fileid = `file-${++counter}`;
      files.set(fileid, {
        fileid,
        file_name: upload.file_name,
        spaceid: upload.spaceid,
        fatherid: upload.fatherid,
        file_type: 2,
        file_status: 1,
        file_size: content.length,
        sha: conflict ? "0".repeat(40) : sha("sha1", content),
      });
      if (loseFinish) {
        loseFinish = false;
        throw new Error("ambiguous finish");
      }
      return { fileid };
    }
    throw new Error(`unexpected operation ${operation}`);
  };
  return {
    request,
    files,
    uploads,
    get initialized() {
      return initialized;
    },
    get writes() {
      return writes;
    },
  };
}

test("官方 demo 的中间 SHA state 与末块完整 SHA1 完全一致", async (t) => {
  const f = await fixture(t, Buffer.from("1234567890\r\n".repeat(500000)).subarray(0, 5999998));
  const result = await blockDigests(join(f.dir, names[0]));
  assert.deepEqual(result, [
    "5186fee37e9f7e77a1f6bea8d4e32638d5186d44",
    "cf540965f3190bc0c6367147ab0ac64dc9eff6a0",
    "bda1e884e1cb23a5cbdea73d2e00e23baa72d2f5",
  ]);
});

test("恰好一块及多块边界末块使用完整 SHA1，不使用裸 state", async (t) => {
  for (const length of [1, BLOCK_SIZE, BLOCK_SIZE + 1, BLOCK_SIZE * 2]) {
    const content = Buffer.alloc(length, 97);
    const f = await fixture(t, content);
    const result = await blockDigests(join(f.dir, names[0]));
    assert.equal(result.length, Math.ceil(length / BLOCK_SIZE));
    assert.equal(result.at(-1), sha("sha1", content));
  }
});

test("配置集中列出缺失项且不泄漏已有凭据，父目录可回退空间根目录", () => {
  assert.throws(
    () => resolveWecomConfig({}),
    /WECOM_CORP_ID.*WECOM_SECRET.*WECOM_SPACE_ID.*RELEASE_TAG.*ASSET_DIR/,
  );
  const config = resolveWecomConfig({ ...env, ASSET_DIR: "/tmp/assets", WECOM_FOLDER_ID: "" });
  assert.equal(config.folder, "space");
  assert.throws(
    () => resolveWecomConfig({ ...env, ASSET_DIR: "/tmp/assets", RELEASE_TAG: "../bad" }),
    /标签/,
  );
});

test("完整三平台上传、分页核对与重跑零重复", async (t) => {
  const f = await fixture(t);
  const client = disk();
  const result = await syncWecomRelease({ ...f, client, log() {} });
  assert.equal(result.status, "success");
  assert.equal(result.files.length, 3);
  assert.equal(client.initialized, 3);
  assert.deepEqual(
    [...client.files.values()].filter((file) => file.file_type === 2).map((file) => file.file_name),
    names,
  );
  const writes = client.writes;
  const replay = await syncWecomRelease({ ...f, client, log() {} });
  assert.equal(client.writes, writes);
  assert.ok(replay.files.every((file) => file.action === "skipped"));
  const report = await readFile(f.env.SYNC_REPORT, "utf8");
  assert.ok(!report.includes(env.WECOM_SECRET));
  assert.ok(!report.includes("upload-"));
});

test("草稿、缺包、重复包和损坏附件在任何写入前失败", async (t) => {
  const f = await fixture(t);
  const client = disk();
  for (const release of [
    { ...f.release, draft: true },
    { ...f.release, tag_name: "v0.1.3" },
    { ...f.release, assets: f.release.assets.slice(1) },
    { ...f.release, assets: [...f.release.assets, f.release.assets[0]] },
  ])
    await assert.rejects(syncWecomRelease({ ...f, release, client, log() {} }));
  await writeFile(join(f.dir, names[2]), "damaged");
  await assert.rejects(syncWecomRelease({ ...f, client, log() {} }));
  assert.equal(client.writes, 0);
});

test("丢失创建目录/完成响应时先核对已提交结果，不盲目重复创建", async (t) => {
  const f = await fixture(t);
  const client = disk({ loseCreate: true, loseFinish: true });
  const result = await syncWecomRelease({ ...f, client, log() {} });
  assert.equal(result.status, "success");
  assert.equal(client.initialized, 3);
  assert.equal(client.files.size, 4);
});

test("部分失败保留成功文件，手动补传只上传缺少文件", async (t) => {
  const f = await fixture(t);
  const client = disk();
  const original = client.request;
  let fail = true;
  client.request = async (op, body) => {
    if (fail && op === "file_upload_init" && body.file_name === names[1])
      throw new Error("init unavailable");
    return original(op, body);
  };
  await assert.rejects(syncWecomRelease({ ...f, client, log() {} }));
  const partial = JSON.parse(await readFile(f.env.SYNC_REPORT, "utf8"));
  assert.equal(partial.status, "failed");
  assert.equal(partial.files.length, 1);
  fail = false;
  const result = await syncWecomRelease({ ...f, client, log() {} });
  assert.deepEqual(
    result.files.map((file) => file.action),
    ["skipped", "uploaded", "uploaded"],
  );
  assert.equal(client.initialized, 3);
});

test("远端 SHA 冲突、重复同名和位置错误不视为成功且不覆盖", async (t) => {
  const f = await fixture(t);
  const client = disk({ conflict: true });
  await assert.rejects(syncWecomRelease({ ...f, client, log() {} }), /校验/);
  const writes = client.writes;
  await assert.rejects(syncWecomRelease({ ...f, client, log() {} }), /校验/);
  assert.equal(client.writes, writes);
  const file = [...client.files.values()].find((file) => file.file_type === 2);
  file.sha = sha("sha1", Buffer.from("installer fixture"));
  client.files.set("duplicate", { ...file, fileid: "duplicate" });
  await assert.rejects(syncWecomRelease({ ...f, client, log() {} }), /重复/);
  client.files.delete("duplicate");
  file.spaceid = "other";
  await assert.rejects(syncWecomRelease({ ...f, client, log() {} }), /校验/);
});

test("完整 API 适配链路上传多块文件，分块失败重试后仍是三个完整安装包", async (t) => {
  const content = Buffer.alloc(BLOCK_SIZE + 13, 113);
  const f = await fixture(t, content);
  const remote = disk({ loseFinish: true });
  let retries = 0;
  let failed = false;
  const client = createWecomClient({
    config: resolveWecomConfig(f.env),
    sleepImpl: async () => retries++,
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, "https://qyapi.weixin.qq.com");
      if (url.pathname.endsWith("gettoken"))
        return Response.json({ errcode: 0, access_token: "wire-test-token", expires_in: 7200 });
      assert.equal(url.searchParams.get("access_token"), "wire-test-token");
      const operation = url.pathname.split("/").at(-1);
      const payload = JSON.parse(options.body);
      if (operation === "file_upload_part" && !failed) {
        failed = true;
        return new Response("temporarily unavailable", { status: 503 });
      }
      return Response.json({ errcode: 0, ...(await remote.request(operation, payload)) });
    },
  });
  const result = await syncWecomRelease({ ...f, client, log() {} });
  assert.equal(result.status, "success");
  assert.equal(retries, 1);
  for (const upload of remote.uploads.values()) {
    assert.equal(upload.parts.size, 2);
    assert.equal(upload.parts.get(1).length, BLOCK_SIZE);
    assert.equal(upload.parts.get(2).length, 13);
    assert.equal(upload.size, content.length);
    assert.equal(upload.block_sha.at(-1), sha("sha1", content));
    assert.equal(upload.skip_push_card, true);
  }
});

test("初始化秒传直接回读，不发送 part/finish；初始化响应丢失亦能恢复", async (t) => {
  for (const loseResponse of [false, true]) {
    const f = await fixture(t);
    const client = disk();
    const original = client.request;
    client.request = async (operation, payload) => {
      if (operation === "file_upload_init") {
        const fileid = `instant-${payload.file_name}`;
        client.files.set(fileid, {
          fileid,
          file_name: payload.file_name,
          spaceid: payload.spaceid,
          fatherid: payload.fatherid,
          file_type: 2,
          file_status: 1,
          file_size: payload.size,
          sha: payload.block_sha.at(-1),
        });
        if (loseResponse) throw new Error("init response lost");
        return { hit_exist: true, fileid };
      }
      assert.ok(!["file_upload_part", "file_upload_finish"].includes(operation));
      return original(operation, payload);
    };
    assert.equal((await syncWecomRelease({ ...f, client, log() {} })).status, "success");
  }
});

test("空文件、分页不前进和目录类型冲突均失败，不写入远端", async (t) => {
  const empty = await fixture(t, Buffer.alloc(0));
  const client = disk();
  await assert.rejects(syncWecomRelease({ ...empty, client, log() {} }), /大小/);
  assert.equal(client.writes, 0);
  const f = await fixture(t);
  const stalled = {
    request: async () => ({ file_list: { item: [] }, has_more: true, next_start: 0 }),
  };
  await assert.rejects(syncWecomRelease({ ...f, client: stalled, log() {} }), /分页/);
  client.files.set("wrong", {
    fileid: "wrong",
    file_name: env.RELEASE_TAG,
    fatherid: env.WECOM_FOLDER_ID,
    file_type: 2,
    file_status: 1,
  });
  await assert.rejects(syncWecomRelease({ ...f, client, log() {} }), /类型/);
  assert.equal(client.writes, 0);
});

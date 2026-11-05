import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, privateDecrypt, constants, createDecipheriv } from "node:crypto";
import {
  prepareWecomTargetDirectory,
  resolveTargetDirectoryConfig,
} from "../wecom-target-directory.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const config = { space: "synthetic-space", publicKey: pem };
const execFile = promisify(execFileCallback);
const entry = (fileid, file_name, fatherid = config.space, file_type = 1) => ({
  fileid,
  file_name,
  fatherid,
  file_type,
  file_status: 1,
  spaceid: config.space,
});
function fixture({
  existing = false,
  lost = false,
  failed = false,
  conflict,
  badInfo = false,
  stuck = false,
} = {}) {
  const files = [
    entry("old-version", "v0.1.7"),
    entry("current-version", "v0.1.8"),
    entry("unrelated", "notes.txt", config.space, 2),
  ];
  if (existing) files.push(entry("target-folder", "发布包"));
  if (conflict) files.push(entry("conflicting-target", "发布包", config.space, conflict));
  const calls = [];
  const client = {
    async request(operation, body) {
      calls.push({ operation, body });
      if (operation === "new_space_info")
        return { space_info: { spaceid: config.space, space_name: "UWork 发布包" } };
      if (operation === "file_list") {
        const selected = files.filter((f) => f.fatherid === body.fatherid);
        return {
          errcode: 0,
          file_list: { item: selected.slice(body.start, body.start + 2) },
          has_more: stuck || body.start + 2 < selected.length,
          next_start: stuck ? body.start : body.start + 2,
        };
      }
      if (operation === "file_create") {
        if (failed) throw new Error("private-credential ambiguous result");
        files.push(entry("target-folder", "发布包"));
        if (lost) throw new Error("private-credential response lost");
        return { fileid: "target-folder" };
      }
      if (operation === "file_info")
        return {
          file_info: {
            ...files.find((f) => f.fileid === body.fileid),
            ...(badInfo ? { fatherid: "wrong-parent" } : {}),
          },
        };
      assert.fail(`Forbidden operation: ${operation}`);
    },
  };
  return { client, calls, files };
}
function decrypt(value) {
  const envelope = JSON.parse(Buffer.from(value, "base64").toString());
  const key = privateDecrypt(
    { key: privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(envelope.wrappedKey, "base64"),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]),
  );
}
test("唯一目标创建/复用且完整分页回读，只交接加密标识与名称类型 inventory", async () => {
  for (const existing of [false, true]) {
    const f = fixture({ existing });
    let handoff;
    const report = await prepareWecomTargetDirectory({
      config,
      client: f.client,
      saveHandoff: async (value) => {
        handoff = value;
      },
    });
    assert.equal(report.status, "success");
    assert.equal(f.calls.filter((c) => c.operation === "file_create").length, existing ? 0 : 1);
    if (!existing)
      assert.deepEqual(f.calls.find((c) => c.operation === "file_create").body, {
        spaceid: config.space,
        fatherid: config.space,
        file_type: 1,
        file_name: "发布包",
      });
    assert.deepEqual(report.versionFolders.root, [
      { name: "v0.1.7", type: 1 },
      { name: "v0.1.8", type: 1 },
    ]);
    assert.ok(report.root.some((item) => item.name === "notes.txt" && item.type === 2));
    assert.deepEqual(report.target.items, []);
    assert.deepEqual(decrypt(handoff), {
      space: config.space,
      folder: "target-folder",
      name: "UWork 发布包/发布包",
    });
    for (const value of [
      config.space,
      "target-folder",
      "old-version",
      "current-version",
      "private-credential",
    ])
      assert.ok(!JSON.stringify(report).includes(value));
    assert.ok(
      f.calls.every((c) =>
        ["new_space_info", "file_list", "file_info", "file_create"].includes(c.operation),
      ),
    );
  }
});
test("创建响应丢失只回读、不重发；无法确认、重名和类型/父目录冲突均失败", async () => {
  const recovered = fixture({ lost: true });
  await prepareWecomTargetDirectory({
    config,
    client: recovered.client,
    saveHandoff: async () => {},
  });
  assert.equal(recovered.calls.filter((c) => c.operation === "file_create").length, 1);
  for (const options of [
    { failed: true },
    { existing: true, conflict: 1 },
    { conflict: 2 },
    { existing: true, badInfo: true },
    { stuck: true },
  ]) {
    const f = fixture(options);
    let handoff = false;
    await assert.rejects(
      prepareWecomTargetDirectory({
        config,
        client: f.client,
        saveHandoff: async () => {
          handoff = true;
        },
      }),
      (error) => {
        assert.match(error.message, /目标目录/);
        assert.doesNotMatch(error.message, /private-|synthetic-|wrong-parent/);
        return true;
      },
    );
    assert.equal(handoff, false);
    assert.ok(f.calls.filter((c) => c.operation === "file_create").length <= 1);
  }
});
test("公钥严格 Base64 解码且任何无效公钥在远端请求前失败", async () => {
  const env = {
    WECOM_CORP_ID: "synthetic-corp",
    WECOM_SECRET: "private-credential",
    WECOM_SPACE_ID: config.space,
    WECOM_TARGET_PUBLIC_KEY: Buffer.from(pem).toString("base64"),
  };
  assert.equal(resolveTargetDirectoryConfig(env).publicKey, pem);
  for (const value of [
    "not base64!",
    env.WECOM_TARGET_PUBLIC_KEY + "!",
    Buffer.from("not a public key").toString("base64"),
  ])
    assert.throws(
      () => resolveTargetDirectoryConfig({ ...env, WECOM_TARGET_PUBLIC_KEY: value }),
      /公钥/,
    );
  const f = fixture();
  await assert.rejects(
    prepareWecomTargetDirectory({
      config: { ...config, publicKey: "invalid" },
      client: f.client,
      saveHandoff: async () => {},
    }),
  );
  assert.equal(f.calls.length, 0);
});
test("CLI 缺少固定代理或子进程代理环境无效时失败，不输出凭据", async () => {
  const env = {
    ...process.env,
    WECOM_CORP_ID: "synthetic-corp",
    WECOM_SECRET: "private-credential",
    WECOM_SPACE_ID: config.space,
    WECOM_TARGET_PUBLIC_KEY: Buffer.from(pem).toString("base64"),
    WECOM_PROXY_CONFIG: "",
    TARGET_HANDOFF: "unused-handoff",
    TARGET_REPORT: "unused-report",
  };
  for (const args of [[], ["--target-directory-child"]]) {
    await assert.rejects(
      execFile(
        process.execPath,
        [fileURLToPath(new URL("../wecom-target-directory.mjs", import.meta.url)), ...args],
        { env: { ...env, NODE_USE_ENV_PROXY: "0", HTTPS_PROXY: "" } },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /目标目录配置、创建或回读失败/);
        assert.doesNotMatch(error.stderr, /private-|synthetic-|unused-|https?:\/\//);
        return true;
      },
    );
  }
});
test("临时 workflow 仅固定分支手动准备目录，不能切换目标或上传/移动/删除", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/wecom-release-sync.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(
    workflow,
    /types: \[published\]|release:\s*\n|file_delete|file_move|sync-wecom-release\.mjs/,
  );
  assert.match(workflow, /public_key:/);
  assert.match(workflow, /refs\/heads\/codex\/wecom-target-directory-20261105/);
  assert.match(workflow, /group: wecom-release-sync/);
  assert.match(
    workflow,
    /WECOM_SPACE_ID: \$\{\{ vars\.WECOM_SPACE_ID \|\| secrets\.WECOM_SPACE_ID \}\}/,
  );
  assert.match(workflow, /WECOM_PROXY_CONFIG: \$\{\{ secrets\.WECOM_PROXY_CONFIG \}\}/);
  assert.match(workflow, /node scripts\/wecom-target-directory\.mjs/);
  assert.doesNotMatch(workflow, /secrets: write|contents: write|WECOM_FOLDER_ID/);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  constants,
  createDecipheriv,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { relocateWecomRelease } from "../wecom-release-relocate.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config = {
  space: "id_space",
  publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
};
const hash = (value, algorithm = "sha1") => createHash(algorithm).update(value).digest("hex");
const assets = [
  "mac-arm64.dmg",
  "win-x64.exe",
  ...["x64", "arm64"].flatMap((arch) =>
    ["AppImage", "deb", "rpm"].map((ext) => `linux-${arch}.${ext}`),
  ),
].map((suffix) => ({
  name: `UWork-0.1.8-${suffix}`,
  size: 10,
  digest: `sha256:${"a".repeat(64)}`,
}));
const release = { tag_name: "v0.1.8", draft: false, prerelease: false, assets };
function fixture({ failDelete = 0, lostMove = false } = {}) {
  const files = new Map();
  const calls = [];
  const add = (id, name, parent, type = 1, size = 10) => {
    const file = {
      fileid: id,
      file_name: name,
      fatherid: parent,
      spaceid: config.space,
      file_type: type,
      file_status: 1,
      ...(type === 2 ? { file_size: size, sha: hash(name) } : {}),
    };
    files.set(id, file);
    return file;
  };
  add("id_target", "发布包", config.space);
  add("id_current", "v0.1.8", config.space);
  assets.forEach((a, i) => add(`id_asset_${i}`, a.name, "id_current", 2, a.size));
  add("id_current_notes", "changelog.txt", "id_current", 2);
  add("id_old", "v0.1.2", config.space);
  add("id_nested", "assets", "id_old");
  add("id_old_file", "old.exe", "id_nested", 2);
  add("id_target_old", "v0.1.5", config.space);
  add("id_third_old", "v0.1.6", config.space);
  add("id_target_old_file", "old.dmg", "id_target_old", 2);
  add("id_future", "v0.1.9", config.space);
  add("id_unrelated", "notes", config.space);
  add("id_user_file", "keep.txt", "id_unrelated", 2);
  add("id_invalid_version", "v00.1.7", config.space);
  let deletes = 0;
  const client = {
    async request(operation, body) {
      calls.push({ operation, body });
      if (operation === "new_space_info")
        return { space_info: { spaceid: config.space, space_name: "UWork 发布包" } };
      if (operation === "file_list") {
        const all = [...files.values()]
          .filter((f) => f.fatherid === body.fatherid)
          .sort((a, b) => (a.file_name < b.file_name ? -1 : 1));
        return {
          errcode: 0,
          file_list: { item: all.slice(body.start, body.start + 2).map((f) => ({ ...f })) },
          has_more: body.start + 2 < all.length,
          next_start: body.start + 2,
        };
      }
      if (operation === "file_info") return { file_info: { ...files.get(body.fileid) } };
      if (operation === "file_move") {
        assert.deepEqual(body, { fatherid: "id_target", replace: false, fileid: ["id_current"] });
        files.get("id_current").fatherid = body.fatherid;
        if (lostMove) throw new Error("private-token ambiguous move");
        return {};
      }
      if (operation === "file_delete") {
        assert.equal(body.fileid.length, 1);
        const id = body.fileid[0];
        assert.ok(
          ![...files.values()].some((f) => f.fatherid === id),
          "delete directories only when empty",
        );
        if (++deletes === failDelete) throw new Error("private-token ambiguous deletion");
        files.delete(id);
        return {};
      }
      if (operation === "file_share") {
        assert.deepEqual(body, { fileid: "id_target" });
        return { share_url: "https://drive.weixin.qq.com/s?k=synthetic-sensitive" };
      }
      assert.fail(`Forbidden operation: ${operation}`);
    },
  };
  return { files, client, calls };
}
const writes = (f) =>
  f.calls.filter((c) => ["file_move", "file_delete", "file_share"].includes(c.operation));
const run = (f, options = {}) =>
  relocateWecomRelease({ config, client: f.client, release, ...options });
function decrypt(value) {
  const e = JSON.parse(Buffer.from(value, "base64").toString());
  const key = privateDecrypt(
    { key: privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(e.wrappedKey, "base64"),
  );
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64"));
  d.setAuthTag(Buffer.from(e.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(e.ciphertext, "base64")), d.final()]));
}

test("plan 只读限定旧版本范围，保护当前/未来/无关项并拒绝目标冲突", async () => {
  const f = fixture();
  const plan = await run(f);
  assert.equal(plan.status, "planned");
  assert.equal(plan.current.installers, 8);
  assert.deepEqual(plan.oldDirectories.map((x) => x.name).sort(), [
    "UWork 发布包/v0.1.2",
    "UWork 发布包/v0.1.5",
    "UWork 发布包/v0.1.6",
  ]);
  assert.equal(writes(f).length, 0);
  assert.doesNotMatch(JSON.stringify(plan), /id_|private-|synthetic-sensitive/);
  f.files.set("id_conflict", {
    ...f.files.get("id_current"),
    fileid: "id_conflict",
    fatherid: "id_target",
  });
  assert.equal((await run(f)).status, "refused");
  assert.equal(writes(f).length, 0);
  const unknown = fixture();
  unknown.files.get("id_old_file").file_type = 3;
  assert.equal((await run(unknown)).status, "refused");
  assert.equal(writes(unknown).length, 0);
  for (const mutate of [
    (x) =>
      x.files.set("id_extra_old", {
        ...x.files.get("id_old"),
        fileid: "id_extra_old",
        file_name: "v0.1.7",
      }),
    (x) =>
      x.files.set("id_extra_old", {
        ...x.files.get("id_old"),
        fileid: "id_extra_old",
        fatherid: "id_target",
      }),
    (x) => {
      Object.assign(x.files.get("id_old"), { file_type: 2, file_size: 1, sha: "a".repeat(40) });
    },
    (x) => x.files.set("id_duplicate", { ...x.files.get("id_old"), fileid: "id_duplicate" }),
  ]) {
    const rejected = fixture();
    mutate(rejected);
    assert.equal((await run(rejected)).status, "refused");
    assert.equal(writes(rejected).length, 0);
  }
});
test("清单或摘要变化、旧同步未确认时 apply 零写入", async () => {
  const f = fixture();
  const plan = await run(f);
  f.files.get("id_old_file").sha = "b".repeat(40);
  const changed = await run(f, {
    mode: "apply",
    expectedPlanDigest: plan.plan_digest,
    sourceSyncVerified: true,
    saveHandoff: async () => {},
  });
  assert.equal(changed.status, "refused");
  assert.equal(writes(f).length, 0);
  const fresh = fixture();
  const next = await run(fresh);
  assert.equal(
    (
      await run(fresh, {
        mode: "apply",
        expectedPlanDigest: next.plan_digest,
        saveHandoff: async () => {},
      })
    ).status,
    "refused",
  );
  assert.equal(writes(fresh).length, 0);
});
test("合法整体移动与叶文件/空目录清理保留八包、当前附加内容和无关数据，仅加密分享链接", async () => {
  const f = fixture({ lostMove: true });
  const plan = await run(f);
  let handoff;
  const report = await run(f, {
    mode: "apply",
    expectedPlanDigest: plan.plan_digest,
    sourceSyncVerified: true,
    saveHandoff: async (value) => {
      handoff = value;
    },
  });
  assert.equal(report.status, "success");
  assert.equal(f.files.get("id_current").fatherid, "id_target");
  for (const id of [
    "id_old",
    "id_nested",
    "id_old_file",
    "id_target_old",
    "id_target_old_file",
    "id_third_old",
  ])
    assert.equal(f.files.has(id), false);
  for (const id of [
    "id_future",
    "id_unrelated",
    "id_user_file",
    "id_invalid_version",
    "id_current_notes",
  ])
    assert.ok(f.files.has(id));
  assets.forEach((a, i) => {
    assert.equal(f.files.get(`id_asset_${i}`).file_size, a.size);
    assert.equal(f.files.get(`id_asset_${i}`).sha, hash(a.name));
  });
  assert.equal(f.calls.filter((c) => c.operation === "file_move").length, 1);
  assert.equal(f.calls.filter((c) => c.operation === "file_share").length, 1);
  assert.deepEqual(decrypt(handoff), {
    space: config.space,
    folder: "id_target",
    name: "UWork 发布包/发布包",
    share_url: "https://drive.weixin.qq.com/s?k=synthetic-sensitive",
  });
  assert.doesNotMatch(JSON.stringify(report), /id_|private-|synthetic-sensitive|https?:\/\//);
});
test("中途删除结果不明停止后续操作并保留 partial 报告，不盲重试", async () => {
  const f = fixture({ failDelete: 2 });
  const plan = await run(f);
  const progress = [];
  let saved = false;
  const report = await run(f, {
    mode: "apply",
    expectedPlanDigest: plan.plan_digest,
    sourceSyncVerified: true,
    saveReport: async (value) => {
      progress.push(structuredClone(value));
    },
    saveHandoff: async () => {
      saved = true;
    },
  });
  assert.equal(report.status, "partial");
  assert.ok(report.completed.length > 0);
  assert.ok(progress.length > 0);
  assert.equal(saved, false);
  const deletes = f.calls.filter((c) => c.operation === "file_delete");
  assert.equal(deletes.length, 2);
  assert.equal(new Set(deletes.map((c) => c.body.fileid[0])).size, 2);
  assert.equal(
    f.calls.some((c) => c.operation === "file_share"),
    false,
  );
  assert.ok(f.files.has("id_current"));
  assert.ok(f.files.has("id_future"));
  const raced = fixture();
  const beforeRace = await run(raced);
  const request = raced.client.request;
  raced.client.request = async (operation, body) => {
    const value = await request(operation, body);
    if (operation === "file_move") raced.files.get("id_nested").fatherid = "id_unrelated";
    return value;
  };
  const racedReport = await run(raced, {
    mode: "apply",
    expectedPlanDigest: beforeRace.plan_digest,
    sourceSyncVerified: true,
    saveHandoff: async () => assert.fail("changed ancestors must stop"),
  });
  assert.equal(racedReport.status, "partial");
  assert.equal(raced.calls.filter((call) => call.operation === "file_delete").length, 0);
  assert.ok(raced.files.has("id_old_file"));
  const workflow = await readFile(
    new URL("../../.github/workflows/wecom-release-sync.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /default: plan/);
  assert.match(workflow, /expected_plan_digest:/);
});

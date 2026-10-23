import assert from "node:assert/strict";
import { generateKeyPairSync, privateDecrypt, constants } from "node:crypto";
import test from "node:test";
import { bootstrapWecomSpace, resolveBootstrapConfig } from "../wecom-release-bootstrap.mjs";
import { createWecomClient } from "../wecom-release-client.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = publicKey.export({ type: "spki", format: "pem" }).toString();
const config = { adminName: "Synthetic Admin", oldSpace: "s.1.old", publicKey: key };
const admin = { userid: "synthetic-member", name: "Synthetic Admin", status: 1 };

function fixture({ members = [admin], status = 1, failCreate = false, missingAdmin = false } = {}) {
  const calls = [];
  const request = async (op, body) => {
    calls.push({ op, body });
    if (op === "user_simplelist") return { userlist: members };
    if (op === "user_get") return { ...admin, status };
    if (op === "new_space_info") {
      if (body.spaceid === config.oldSpace)
        throw Object.assign(new Error("denied"), { code: 640008 });
      return {
        space_info: {
          spaceid: "s.1.new",
          space_name: "UWork 发布包",
          auth_list: {
            auth_info: missingAdmin ? [] : [{ type: 1, userid: admin.userid, auth: 7 }],
          },
        },
      };
    }
    if (op === "space_create") {
      if (failCreate) throw new Error("ambiguous response private-token");
      return { spaceid: "s.1.new" };
    }
    if (op === "file_list") return { file_list: { item: [] }, has_more: false };
    throw new Error("unexpected operation");
  };
  return { calls, request };
}

test("初始化只授权唯一管理员，创建一次，回读并加密交接目标", async () => {
  const client = fixture();
  let handoff;
  const report = await bootstrapWecomSpace({
    config,
    client,
    saveHandoff: async (data) => {
      handoff = data;
    },
  });
  const created = client.calls.filter((x) => x.op === "space_create");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].body.auth_info, [{ type: 1, userid: admin.userid, auth: 7 }]);
  assert.equal(report.status, "success");
  assert.equal(report.administratorVerified, true);
  const target = JSON.parse(
    privateDecrypt(
      { key: privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(handoff, "base64"),
    ),
  );
  assert.deepEqual(target, { space: "s.1.new", folder: "s.1.new", name: "UWork 发布包" });
  for (const value of [admin.userid, "s.1.new", "private-token"])
    assert.ok(!JSON.stringify(report).includes(value));
});

test("管理员无匹配、重名、停用或公钥无效时不得创建空间", async () => {
  for (const options of [
    { members: [] },
    { members: [admin, { ...admin, userid: "other" }] },
    { status: 2 },
  ]) {
    const client = fixture(options);
    await assert.rejects(
      bootstrapWecomSpace({ config, client, saveHandoff: async () => {} }),
      /管理员/,
    );
    assert.equal(client.calls.filter((x) => x.op === "space_create").length, 0);
  }
  assert.throws(() => resolveBootstrapConfig({}), /初始化配置/);
  const client = fixture();
  await assert.rejects(
    bootstrapWecomSpace({
      config: { ...config, publicKey: "invalid" },
      client,
      saveHandoff: async () => {},
    }),
    /公钥/,
  );
  assert.equal(client.calls.length, 0);
});

test("创建结果不明不重发；管理员回读失败保留已加密的恢复目标", async () => {
  const ambiguous = fixture({ failCreate: true });
  await assert.rejects(
    bootstrapWecomSpace({ config, client: ambiguous, saveHandoff: async () => {} }),
  );
  assert.equal(ambiguous.calls.filter((x) => x.op === "space_create").length, 1);
  const client = fixture({ missingAdmin: true });
  let saved = false;
  await assert.rejects(
    bootstrapWecomSpace({
      config,
      client,
      saveHandoff: async () => {
        saved = true;
      },
    }),
    /管理员/,
  );
  assert.equal(saved, true);
});

test("已切换到验证通过的专用空间时初始化复用，不再次创建", async () => {
  const client = fixture();
  const report = await bootstrapWecomSpace({
    config: { ...config, oldSpace: "s.1.new" },
    client,
    saveHandoff: async () => {},
  });
  assert.equal(report.action, "reused");
  assert.equal(client.calls.filter((x) => x.op === "space_create").length, 0);
});

test("实际传输合同通过只读 GET 核对成员，创建仅一次 POST，复用同一 token", async () => {
  const remote = fixture();
  const methods = [];
  let tokens = 0;
  const client = createWecomClient({
    config: { corpId: "synthetic-corp", secret: "synthetic-secret" },
    fetchImpl: async (url, options) => {
      if (url.pathname.endsWith("gettoken")) {
        tokens++;
        return Response.json({ errcode: 0, access_token: "synthetic-token", expires_in: 7200 });
      }
      const getOps = {
        "/cgi-bin/user/simplelist": "user_simplelist",
        "/cgi-bin/user/get": "user_get",
      };
      const operation = getOps[url.pathname] || url.pathname.split("/").at(-1);
      methods.push([operation, options.method]);
      if (getOps[url.pathname]) {
        assert.equal(options.method, "GET");
        assert.equal(options.body, undefined);
      }
      const body = getOps[url.pathname]
        ? Object.fromEntries(url.searchParams)
        : JSON.parse(options.body);
      try {
        return Response.json({ errcode: 0, ...(await remote.request(operation, body)) });
      } catch (error) {
        return Response.json({ errcode: error.code || -1 });
      }
    },
  });
  const report = await bootstrapWecomSpace({ config, client, saveHandoff: async () => {} });
  assert.equal(report.administratorVerified, true);
  assert.equal(tokens, 1);
  assert.deepEqual(
    methods.filter((x) => x[0] === "space_create"),
    [["space_create", "POST"]],
  );
});

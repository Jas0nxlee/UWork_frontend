import assert from "node:assert/strict";
import test from "node:test";
import { inspectWecomAccess } from "../wecom-release-diagnostics.mjs";
import { createWecomClient } from "../wecom-release-client.mjs";

const config = {
  corpId: "private-corp",
  secret: "private-secret",
  space: "s.123456.synthetic",
  folder: "s.123456.synthetic",
};
const responses = {
  agent_list: { agentlist: [{ name: "Synthetic App", agentid: 123 }] },
  new_space_info: { space_info: { space_name: "Synthetic Space", spaceid: config.space } },
  file_list: { file_list: { item: [] } },
};

test("只读诊断应用、空间、目录，不写远端且不暴露凭据和标识", async () => {
  const seen = [];
  const report = await inspectWecomAccess({
    config,
    client: {
      request: async (operation, body) => {
        seen.push({ operation, body });
        return responses[operation];
      },
    },
  });
  assert.deepEqual(
    seen.map((x) => x.operation),
    ["agent_list", "new_space_info", "file_list"],
  );
  assert.equal(seen.at(-1).body.limit, 1);
  assert.equal(report.canReadSpace, true);
  assert.deepEqual(report.applications.names, ["Synthetic App"]);
  assert.equal(report.space.name, "Synthetic Space");
  assert.equal(report.folderIsSpaceRoot, true);
  const serialized = JSON.stringify(report);
  for (const value of [config.secret, config.corpId, config.space, "agentid", "spaceid"])
    assert.ok(!serialized.includes(value));
});

test("空间和目录 640008 拒绝分别报告，不将应用 API 已开放误认为拥有目标空间", async () => {
  const report = await inspectWecomAccess({
    config,
    client: {
      request: async (operation) => {
        if (operation !== "agent_list")
          throw Object.assign(new Error("private-token no space auth"), { code: 640008 });
        return responses.agent_list;
      },
    },
  });
  assert.equal(report.applications.code, 0);
  assert.equal(report.space.code, 640008);
  assert.equal(report.directory.code, 640008);
  assert.equal(report.canReadSpace, false);
  assert.ok(!JSON.stringify(report).includes("private-token"));
});

test("无效或带变量名前缀的空间配置能被定位，响应格式错误不伪装为成功", async () => {
  const report = await inspectWecomAccess({
    config: { ...config, space: "WECOM_SPACE_ID=wrong" },
    client: { request: async () => ({}) },
  });
  assert.equal(report.targetFormatValid, false);
  assert.equal(report.canReadSpace, false);
  assert.equal(report.space.code, "invalid_response");
});

test("应用列表请求走官方只读 GET，空间信息走 POST，并复用 token", async () => {
  const paths = [];
  const client = createWecomClient({
    config,
    fetchImpl: async (url, options) => {
      paths.push([url.pathname, options.method, options.body]);
      if (url.pathname.endsWith("gettoken"))
        return Response.json({ errcode: 0, access_token: "private-token", expires_in: 7200 });
      return Response.json({ errcode: 0 });
    },
  });
  await client.request("agent_list");
  await client.request("new_space_info", { spaceid: config.space });
  assert.deepEqual(
    paths.map((x) => x.slice(0, 2)),
    [
      ["/cgi-bin/gettoken", "GET"],
      ["/cgi-bin/agent/list", "GET"],
      ["/cgi-bin/wedrive/new_space_info", "POST"],
    ],
  );
  assert.equal(paths[1][2], undefined);
});

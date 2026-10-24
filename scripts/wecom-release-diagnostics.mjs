import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWecomConfig } from "./sync-wecom-release.mjs";
import { createWecomClient, isWecomIdentifier } from "./wecom-release-client.mjs";

export async function inspectWecomAccess({ config, client = createWecomClient({ config }) }) {
  const report = {
    kind: "wecom-access-diagnostic",
    targetFormatValid:
      isWecomIdentifier(config.space) && !/^WECOM_(SPACE|FOLDER)_ID=/.test(config.space),
    folderIsSpaceRoot: config.folder === config.space,
  };
  async function read(operation, body, summarize) {
    try {
      const data = await client.request(operation, body);
      const summary = summarize(data);
      return summary ? { code: 0, ...summary } : { code: "invalid_response" };
    } catch (error) {
      // 原始 errmsg 可能包含 token、IP 或内部标识；诊断只保留已确认的错误码。
      return { code: Number.isInteger(error.code) ? error.code : "request_failed" };
    }
  }
  report.applications = await read("agent_list", undefined, (data) =>
    Array.isArray(data.agentlist)
      ? { names: data.agentlist.map((app) => app.name).filter((name) => typeof name === "string") }
      : undefined,
  );
  report.space = await read("new_space_info", { spaceid: config.space }, (data) =>
    typeof data.space_info?.space_name === "string"
      ? {
          name: data.space_info.space_name,
          identifierType: typeof data.space_info.spaceid,
          identifierMatchesRequest: data.space_info.spaceid === config.space,
          administratorPermissionValues: [
            ...new Set((data.space_info.auth_list?.auth_info || []).map((entry) => entry.auth)),
          ],
        }
      : undefined,
  );
  report.directory = await read(
    "file_list",
    {
      spaceid: config.space,
      fatherid: config.folder,
      sort_type: 1,
      start: 0,
      limit: 1,
    },
    (data) =>
      Array.isArray(data.file_list?.item)
        ? {
            sampledItemCount: data.file_list.item.length,
            sampleFieldTypes: data.file_list.item[0]
              ? Object.fromEntries(
                  Object.entries(data.file_list.item[0]).map(([key, value]) => [key, typeof value]),
                )
              : {},
          }
        : undefined,
  );
  report.canReadSpace =
    report.targetFormatValid && report.space.code === 0 && report.directory.code === 0;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await inspectWecomAccess({ config: resolveWecomConfig(process.env) });
    const serialized = JSON.stringify(report, null, 2) + "\n";
    if (process.env.SYNC_REPORT) await writeFile(process.env.SYNC_REPORT, serialized);
    console.log(serialized);
    // 只读成功也不是上传成功，拒绝时非零退出并保留完整的分项诊断。
    process.exitCode = report.canReadSpace ? 0 : 1;
  } catch {
    console.error("[wecom-diagnostic] 配置或诊断执行失败，未修改远端");
    process.exitCode = 1;
  }
}

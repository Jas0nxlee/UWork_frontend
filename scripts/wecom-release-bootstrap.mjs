import { createPublicKey, publicEncrypt, constants } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWecomClient } from "./wecom-release-client.mjs";

const SPACE_NAME = "UWork 发布包";

function checkedKey(value) {
  let key;
  try {
    key = createPublicKey(value);
  } catch {
    throw new Error("初始化交接公钥无效");
  }
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails?.modulusLength < 2048)
    throw new Error("初始化交接公钥必须是至少 2048 位的 RSA 公钥");
  return key;
}

export function resolveBootstrapConfig(env) {
  if (env.WECOM_INSPECT_ONLY === "true") throw new Error("初始化与只读诊断不能同时启用");
  const required = [
    "WECOM_CORP_ID",
    "WECOM_SECRET",
    "WECOM_SPACE_ADMIN_NAME",
    "WECOM_BOOTSTRAP_PUBLIC_KEY",
  ];
  if (required.some((key) => !env[key]?.trim())) throw new Error("缺少应用空间初始化配置");
  const publicKey = Buffer.from(env.WECOM_BOOTSTRAP_PUBLIC_KEY, "base64").toString("utf8");
  checkedKey(publicKey);
  return {
    corpId: env.WECOM_CORP_ID.trim(),
    secret: env.WECOM_SECRET.trim(),
    adminName: env.WECOM_SPACE_ADMIN_NAME.trim(),
    oldSpace: env.WECOM_SPACE_ID?.trim(),
    publicKey,
  };
}

export async function bootstrapWecomSpace({
  config,
  client = createWecomClient({ config }),
  saveHandoff,
}) {
  const key = checkedKey(config.publicKey);
  if (typeof saveHandoff !== "function") throw new Error("缺少加密配置交接通道");
  const members = await client.request("user_simplelist", { department_id: 1, fetch_child: 1 });
  if (!Array.isArray(members.userlist)) throw new Error("管理员查询响应无效");
  const matches = members.userlist.filter((user) => user.name === config.adminName);
  if (matches.length !== 1 || typeof matches[0].userid !== "string" || !matches[0].userid)
    throw new Error("管理员必须唯一匹配，未创建空间");
  const user = await client.request("user_get", { userid: matches[0].userid });
  if (
    user.name !== config.adminName ||
    user.userid?.toLowerCase() !== matches[0].userid.toLowerCase() ||
    user.status !== 1
  )
    throw new Error("管理员账号校验失败或未激活，未创建空间");
  let space;
  if (config.oldSpace) {
    try {
      const current = await client.request("new_space_info", { spaceid: config.oldSpace });
      if (current.space_info?.space_name === SPACE_NAME) space = config.oldSpace;
    } catch (error) {
      // 旧成员空间拒绝是已确认的迁移场景；网络错误不能被当作应再次创建的依据。
      if (![640001, 640008].includes(error.code)) throw error;
    }
  }
  const action = space ? "reused" : "created";
  if (!space) {
    // 创建操作仅调用一次；响应不明时必须先恢复目标，不能靠重试制造第二个空间。
    const created = await client.request("space_create", {
      space_name: SPACE_NAME,
      space_sub_type: 0,
      auth_info: [{ type: 1, userid: user.userid, auth: 7 }],
    });
    if (typeof created.spaceid !== "string" || !/^s\.\d+\.[\w-]+$/.test(created.spaceid))
      throw new Error("应用空间创建响应无效，停止并核查，禁止盲目重新创建");
    space = created.spaceid;
  }
  const encrypted = publicEncrypt(
    { key, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(JSON.stringify({ space, folder: space, name: SPACE_NAME })),
  ).toString("base64");
  await saveHandoff(encrypted);
  const { space_info: info } = await client.request("new_space_info", { spaceid: space });
  if (info?.spaceid !== space || info.space_name !== SPACE_NAME)
    throw new Error("应用空间回读校验失败");
  const administratorVerified = info.auth_list?.auth_info?.some(
    (entry) =>
      entry.type === 1 &&
      entry.userid?.toLowerCase() === user.userid.toLowerCase() &&
      entry.auth === 7,
  );
  if (!administratorVerified) throw new Error("新空间管理员权限回读失败，已保存加密恢复配置");
  const directory = await client.request("file_list", {
    spaceid: space,
    fatherid: space,
    sort_type: 1,
    start: 0,
    limit: 1,
  });
  if (!Array.isArray(directory.file_list?.item))
    throw new Error("新空间根目录回读失败，已保存加密恢复配置");
  return {
    kind: "wecom-space-bootstrap",
    status: "success",
    action,
    spaceName: SPACE_NAME,
    administratorVerified: true,
    directoryReadable: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report = { kind: "wecom-space-bootstrap", status: "failed" };
  try {
    if (!process.env.BOOTSTRAP_HANDOFF) throw new Error("缺少加密配置交接文件路径");
    report = await bootstrapWecomSpace({
      config: resolveBootstrapConfig(process.env),
      saveHandoff: async (encrypted) =>
        writeFile(
          process.env.BOOTSTRAP_HANDOFF,
          JSON.stringify({ encryptedTarget: encrypted }) + "\n",
          { mode: 0o600 },
        ),
    });
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(`[wecom-bootstrap] ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (process.env.SYNC_REPORT)
      await writeFile(process.env.SYNC_REPORT, JSON.stringify(report, null, 2) + "\n");
  }
}

import { createHash } from "node:crypto";
import { createWecomClient } from "./wecom-release-client.mjs";
import { encryptWecomTarget, validateWecomTargetPublicKey } from "./wecom-release-bootstrap.mjs";
import { listDirectory, uniqueTarget } from "./wecom-target-directory.mjs";
import { selectWecomReleaseAssets } from "./release-installer-assets.mjs";

const SPACE_NAME = "UWork 发布包",
  TARGET_NAME = `${SPACE_NAME}/发布包`,
  TAG = "v0.1.8";
const AUTHORIZED_OLD = new Set(["v0.1.2", "v0.1.5", "v0.1.6"]);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (files) =>
  [...files].sort((a, b) => compare(a.file_name, b.file_name) || compare(a.fileid, b.fileid));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
function version(name) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(name);
  return match ? match.slice(1).map(BigInt) : undefined;
}
const isCurrent = (file) => version(file.file_name)?.every((part, i) => part === [0n, 1n, 8n][i]);
function isOld(file) {
  const parts = version(file.file_name);
  if (file.file_type !== 1 || !parts) return false;
  for (let i = 0; i < 3; i++) if (parts[i] !== [0n, 1n, 8n][i]) return parts[i] < [0n, 1n, 8n][i];
  return false;
}
const header = (file, space, parent) => ({
  id: file.fileid,
  name: file.file_name,
  type: file.file_type,
  space,
  parent,
  status: file.file_status,
});
async function readRecord(client, expected) {
  const { file_info: file } = await client.request("file_info", { fileid: expected.id });
  if (
    !file ||
    file.fileid !== expected.id ||
    file.file_name !== expected.name ||
    file.file_type !== expected.type ||
    file.spaceid !== expected.space ||
    file.fatherid !== expected.parent ||
    file.file_status !== 1 ||
    ![1, 2].includes(file.file_type) ||
    /[\\/\p{Cc}]/u.test(file.file_name) ||
    [".", ".."].includes(file.file_name)
  )
    throw new Error();
  if (
    file.file_type === 2 &&
    (!Number.isSafeInteger(file.file_size) ||
      file.file_size < 0 ||
      !/^[a-f\d]{40}$/i.test(file.sha || ""))
  )
    throw new Error();
  return {
    ...expected,
    ...(file.file_type === 2 ? { size: file.file_size, sha: file.sha.toLowerCase() } : {}),
  };
}
async function assertRecord(client, expected) {
  if (digest(await readRecord(client, expected)) !== digest(expected)) throw new Error();
}
async function tree(client, expected, seen = new Set()) {
  if (seen.has(expected.id)) throw new Error();
  seen.add(expected.id);
  const record = await readRecord(client, expected);
  const children = [];
  if (record.type === 1) {
    const files = sorted(await listDirectory(client, record.space, record.id));
    if (new Set(files.map((file) => file.file_name)).size !== files.length) throw new Error();
    for (const file of files)
      children.push(await tree(client, header(file, record.space, record.id), seen));
  }
  return { record, children };
}
function flatten(node, prefix) {
  const name = `${prefix}/${node.record.name}`;
  return [
    { name, type: node.record.type, record: node.record },
    ...node.children.flatMap((child) => flatten(child, name)),
  ];
}
function verifyAssets(current, assets) {
  for (const asset of assets) {
    const matches = current.children.filter((node) => node.record.name === asset.name);
    if (
      matches.length !== 1 ||
      matches[0].record.type !== 2 ||
      matches[0].record.size !== asset.size
    )
      throw new Error();
  }
}
async function buildPlan(config, client, release) {
  if (release?.tag_name !== TAG || release.draft !== false || release.prerelease === true)
    throw new Error();
  const assets = selectWecomReleaseAssets(release, TAG)
    .assets.map(({ name, size, digest: sha256 }) => ({ name, size, sha256 }))
    .sort((a, b) => compare(a.name, b.name));
  if (
    assets.length !== 8 ||
    assets.some(
      (asset) =>
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0 ||
        !/^sha256:[a-f\d]{64}$/i.test(asset.sha256 || ""),
    )
  )
    throw new Error();
  const { space_info: info } = await client.request("new_space_info", { spaceid: config.space });
  if (info?.space_name !== SPACE_NAME || typeof info.spaceid !== "string" || !info.spaceid.trim())
    throw new Error();
  const space = info.spaceid;
  const root = sorted(await listDirectory(client, space, space));
  const targetEntry = uniqueTarget(root);
  if (!targetEntry) throw new Error();
  const target = await readRecord(client, header(targetEntry, space, space));
  const targetFiles = sorted(await listDirectory(client, space, target.id));
  const fromRoot = root.filter(isCurrent),
    fromTarget = targetFiles.filter(isCurrent);
  // 同版本目标存在时不能靠 replace:false 自动改名；也拒绝两处重复或非标准当前目录。
  if (fromRoot.length + fromTarget.length !== 1) throw new Error();
  const currentEntry = fromRoot[0] || fromTarget[0];
  if (currentEntry.file_name !== TAG || currentEntry.file_type !== 1) throw new Error();
  const seen = new Set([target.id]);
  const current = await tree(
    client,
    header(currentEntry, space, fromRoot.length ? space : target.id),
    seen,
  );
  verifyAssets(current, assets);
  const old = [];
  // 一次性授权绑定 A 的实际清单；未知旧版本、目标内旧目录及已知名称的类型冲突均拒绝。
  if (
    targetFiles.some(isOld) ||
    root.some(
      (file) =>
        (isOld(file) && !AUTHORIZED_OLD.has(file.file_name)) ||
        (AUTHORIZED_OLD.has(file.file_name) && file.file_type !== 1),
    )
  )
    throw new Error();
  const candidates = root.filter((file) => AUTHORIZED_OLD.has(file.file_name));
  if (new Set(candidates.map((file) => file.file_name)).size !== candidates.length)
    throw new Error();
  for (const entry of candidates)
    old.push({ location: SPACE_NAME, tree: await tree(client, header(entry, space, space), seen) });
  const state = {
    version: 1,
    space,
    target,
    root: root.map((f) => header(f, space, space)),
    targetFiles: targetFiles.map((f) => header(f, space, target.id)),
    current,
    move: fromRoot.length === 1,
    old,
    assets,
  };
  return { ...state, plan_digest: digest(state) };
}
function publicPlan(plan) {
  return {
    kind: "wecom-release-relocation",
    plan_digest: plan.plan_digest,
    current: {
      name: TAG,
      type: 1,
      installers: plan.assets.length,
      move: plan.move,
      items: flatten(plan.current, plan.move ? SPACE_NAME : TARGET_NAME).map(({ name, type }) => ({
        name,
        type,
      })),
    },
    oldDirectories: plan.old.map((entry) => {
      const items = flatten(entry.tree, entry.location).map(({ name, type }) => ({ name, type }));
      return {
        name: `${entry.location}/${entry.tree.record.name}`,
        type: 1,
        files: items.filter((f) => f.type === 2).length,
        directories: items.filter((f) => f.type === 1).length,
        items,
      };
    }),
  };
}
async function verifyCurrent(client, plan, parent) {
  const files = await listDirectory(client, plan.space, parent);
  const matches = files.filter(isCurrent);
  if (
    matches.length !== 1 ||
    matches[0].fileid !== plan.current.record.id ||
    matches[0].file_name !== TAG
  )
    throw new Error();
  const actual = await tree(client, { ...plan.current.record, parent });
  const expected = structuredClone(plan.current);
  expected.record.parent = parent;
  if (digest(actual) !== digest(expected)) throw new Error();
  verifyAssets(actual, plan.assets);
}
async function removeTree(client, node, prefix, report, persist, ancestors) {
  const name = `${prefix}/${node.record.name}`;
  for (const child of node.children)
    await removeTree(client, child, name, report, persist, [...ancestors, node.record]);
  // 每次破坏性操作前用 file_info 核对原计划；空目录必须当场回读，不能依赖递归删除语义。
  // 直接 parent ID 不变不能证明仍在授权子树，祖先被搬走/改名时须在删除叶子前停止。
  for (const ancestor of ancestors) await assertRecord(client, ancestor);
  await assertRecord(client, node.record);
  if (
    node.record.type === 1 &&
    (await listDirectory(client, node.record.space, node.record.id)).length
  )
    throw new Error();
  try {
    await client.request("file_delete", { fileid: [node.record.id] });
  } catch {
    /* 结果不明只回读，不重发。 */
  }
  if (
    (await listDirectory(client, node.record.space, node.record.parent)).some(
      (file) => file.fileid === node.record.id,
    )
  )
    throw new Error();
  report.completed.push({ name, type: node.record.type, action: "deleted" });
  await persist(report);
}

export async function relocateWecomRelease({
  config,
  release,
  client,
  mode = "plan",
  expectedPlanDigest,
  sourceSyncVerified = false,
  saveHandoff,
  saveReport = async () => {},
}) {
  let stage = "configuration";
  let report = {
    kind: "wecom-release-relocation",
    mode: ["plan", "apply"].includes(mode) ? mode : "invalid",
    status: "refused",
    completed: [],
  };
  let started = false;
  try {
    if (!["plan", "apply"].includes(mode)) throw new Error();
    validateWecomTargetPublicKey(config.publicKey);
    if (
      mode === "apply" &&
      (!sourceSyncVerified ||
        typeof saveHandoff !== "function" ||
        !/^[a-f\d]{64}$/.test(expectedPlanDigest || ""))
    )
      throw new Error();
    client ??= createWecomClient({ config });
    stage = "plan-readback";
    const plan = await buildPlan(config, client, release);
    report = { ...publicPlan(plan), mode, status: "planned", completed: [] };
    if (mode === "plan") {
      await saveReport(report);
      return report;
    }
    stage = "plan-digest";
    if (plan.plan_digest !== expectedPlanDigest) throw new Error();
    report.status = "running";
    await saveReport(report);
    stage = "current-move";
    await assertRecord(client, plan.target);
    if (plan.move) {
      await verifyCurrent(client, plan, plan.space);
      if ((await listDirectory(client, plan.space, plan.target.id)).some(isCurrent))
        throw new Error();
      started = true;
      try {
        await client.request("file_move", {
          fatherid: plan.target.id,
          replace: false,
          fileid: [plan.current.record.id],
        });
      } catch {
        /* 单次调用后回读，不能盲重发。 */
      }
      if (
        (await listDirectory(client, plan.space, plan.space)).some(
          (file) => file.fileid === plan.current.record.id,
        )
      )
        throw new Error();
      await verifyCurrent(client, plan, plan.target.id);
      report.completed.push({ name: `${TARGET_NAME}/${TAG}`, type: 1, action: "moved" });
      await saveReport(report);
    }
    stage = "old-version-delete";
    for (const old of plan.old) {
      started = true;
      await removeTree(client, old.tree, old.location, report, saveReport, [plan.target]);
    }
    stage = "final-readback";
    await verifyCurrent(client, plan, plan.target.id);
    for (const [parent, previous] of [
      [plan.space, plan.root],
      [plan.target.id, plan.targetFiles],
    ]) {
      const now = await listDirectory(client, plan.space, parent);
      if (now.some(isOld)) throw new Error();
      const removed = new Set(
        plan.old
          .filter((old) => old.tree.record.parent === parent)
          .map((old) => old.tree.record.id),
      );
      if (plan.move && parent === plan.space) removed.add(plan.current.record.id);
      for (const file of previous.filter((f) => !removed.has(f.id))) {
        const actual = now.find((f) => f.fileid === file.id);
        if (!actual || digest(header(actual, plan.space, parent)) !== digest(file))
          throw new Error();
      }
    }
    stage = "share-handoff";
    await assertRecord(client, plan.target);
    const { share_url } = await client.request("file_share", { fileid: plan.target.id });
    const url = new URL(share_url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "drive.weixin.qq.com" ||
      url.username ||
      url.password
    )
      throw new Error();
    await saveHandoff(
      encryptWecomTarget(
        { space: plan.space, folder: plan.target.id, name: TARGET_NAME, share_url },
        config.publicKey,
      ),
    );
    report.status = "success";
    await saveReport(report);
    return report;
  } catch {
    report.status = started ? "partial" : "refused";
    report.stage = stage;
    try {
      await saveReport(report);
    } catch {
      /* 最终安全结果仍返回调用方，不外露文件系统原始错误。 */
    }
    return report;
  }
}

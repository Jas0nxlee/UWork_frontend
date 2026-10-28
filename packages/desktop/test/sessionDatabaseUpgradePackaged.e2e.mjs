// 正式包自行授予迁移开关；测试只构造隔离旧布局，不改写 ASAR 或开启 Node Inspector。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { resolvePackagedDesktopExecutable } from "../scripts/packaged-desktop-executable.mjs";
import { launchPackagedDesktopCdp } from "../scripts/packaged-desktop-cdp.mjs";
import {
  addHistory,
  createPackagedUpgradeEnvironment,
  explicitHistoryText,
  fingerprint,
  historyText,
  ids,
  initializeExplicitDatabase,
  rows,
  seedMembership,
  verifyFrozenSchema,
} from "./fixtures/session-database-upgrade/fixture.mjs";

const [platform, arch] = process.argv.slice(2);
const artifacts = resolve(
  import.meta.dirname,
  "../.e2e-artifacts",
  `packaged-upgrade-${platform}-${arch}-${Date.now()}`,
);
const executablePath = resolvePackagedDesktopExecutable(
  platform,
  arch,
  resolve(import.meta.dirname, "../dist"),
);
const resources =
  platform === "mac"
    ? resolve(dirname(executablePath), "../Resources")
    : join(dirname(executablePath), "resources");
const cli = join(resources, "glm", "zcode.cjs");
await Promise.all([access(executablePath), access(cli)]);
const data = await mkdtemp(join(tmpdir(), "uwork-packaged-upgrade-"));
const originalCwd = process.cwd();
const workspace = join(data, "workspace");
const explicitWorkspace = join(data, "explicit-project");
const source = join(data, ".zcode", "cli", "db", "db.sqlite");
const target = join(data, ".uwork", "cli", "db", "db.sqlite");
const explicitDb = join(explicitWorkspace, "explicit-history.sqlite");
const taskIndex = join(data, ".uwork", "v2", "tasks-index.sqlite");
const settingsPath = join(data, ".uwork", "v2", "setting.json");
const ledgerPath = `${target}.uwork-migration.json`;
const stage = (name) => console.log(`[packaged-upgrade] ${platform}/${arch}: ${name}`);
const env = createPackagedUpgradeEnvironment(process.env, data, platform);
const exec = promisify(execFile);
let app;
let sourceKeeper;
let historyReadCount = 0;

async function waitFor(predicate, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(message);
}
async function completedLedger() {
  return readFile(ledgerPath, "utf8")
    .then((raw) => JSON.parse(raw).phase === "complete")
    .catch((error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
}
async function launch() {
  app = await launchPackagedDesktopCdp({ executablePath, env, platform });
  await waitFor(completedLedger, "Packaged Host did not prepare the managed default database");
}
async function close() {
  await app?.close();
  app = undefined;
}
async function readVisibleHistory() {
  let page;
  await waitFor(async () => {
    page = app.browser
      .contexts()
      .flatMap((context) => context.pages())
      .find(
        (candidate) =>
          /\/renderer\/index\.html(?:\?|$)/.test(candidate.url()) &&
          !candidate.url().includes("windowKind=data-directory-startup"),
      );
    return !!page;
  }, "Packaged business renderer did not open");
  page.setDefaultTimeout(60_000);
  await page.getByTestId("enterprise-login-page").waitFor();
  await page.getByTestId("enterprise-login-skip").click();
  await page.getByTestId("enterprise-login-page").waitFor({ state: "hidden" });
  // 引导与登录层都必须真实退出，不能在覆盖层后读取已挂载的正文作为 UI 通过。
  await waitFor(
    async () =>
      (await page.getByTestId("onboarding-page").isVisible()) ||
      (await page.getByTestId("task-settings-button").isVisible()),
    "Packaged shell did not become visible",
  );
  if (await page.getByTestId("onboarding-page").isVisible()) {
    await page.keyboard.press("Escape");
    await page.getByTestId("onboarding-page").waitFor({ state: "hidden" });
  }
  await page.getByTestId(`task-item-${ids.owned}`).click();
  await page.getByTestId("v4-timeline").getByText(historyText, { exact: true }).waitFor();
  assert.equal(await page.getByTestId("enterprise-login-page").count(), 0);
  await page.screenshot({ path: join(artifacts, `history-${++historyReadCount}.png`) });
  return page;
}

async function readVisibleExplicitHistory(page) {
  const project = page.locator('[data-project-id="packaged-explicit"]');
  const toggle = project.getByTestId("virtual-project-toggle");
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  // 文件原样保留仍可能误开另一空库；只有真实订阅后显示显式正文才证明路由有效。
  await project.getByTestId(`task-item-${ids.explicit}`).click();
  await waitFor(async () => {
    if (
      await page
        .getByTestId("v4-timeline")
        .getByText(explicitHistoryText, { exact: true })
        .isVisible()
    )
      return true;
    if (await page.getByText("fault.subscribe.sessionNotFound", { exact: true }).isVisible())
      throw new Error("Packaged explicit conversation returned fault.subscribe.sessionNotFound");
    return false;
  }, "Packaged explicit history did not become visible");
  assert.equal(await page.getByTestId("enterprise-login-page").count(), 0);
  await page.screenshot({ path: join(artifacts, `explicit-history-${historyReadCount}.png`) });
}

async function saveOwnedFailureLogs() {
  for (const [kind, directory] of [
    ["main", join(data, ".uwork", "v2", "logs")],
    ["cli", env.ZCODE_LOG_DIR],
  ]) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile() && /\.(?:log|jsonl)$/.test(entry.name))
      .slice(-8);
    for (const entry of files) {
      const file = await open(join(directory, entry.name), "r");
      try {
        const { size } = await file.stat();
        const bytes = Buffer.alloc(Math.min(size, 512 * 1024));
        await file.read(bytes, 0, bytes.length, size - bytes.length);
        await writeFile(join(artifacts, `${kind}-${entry.name}`), bytes);
      } finally {
        await file.close();
      }
    }
  }
}

try {
  await mkdir(artifacts, { recursive: true });
  await Promise.all([
    mkdir(workspace),
    mkdir(join(explicitWorkspace, ".zcode"), { recursive: true }),
    ...(platform === "win" ? [mkdir(env.HOME)] : []),
  ]);
  // Resolver 会优先向上查找 monorepo CLI；正式包验收必须从仓库外启动，防止测到源码运行时。
  process.chdir(data);
  stage("bootstrapping the unmodified package to create its Host schema");
  await launch();
  await close();
  await verifyFrozenSchema(taskIndex, "host");
  // 初始化仅用来取得真实 Host 结构；移除新库及 marker 后再构造升级前状态。
  await rm(dirname(target), { recursive: true, force: true });
  await exec(process.execPath, [cli, "storage-migrate"], { cwd: workspace, env, timeout: 60_000 });
  await verifyFrozenSchema(source, "cli");
  sourceKeeper = new DatabaseSync(source);
  sourceKeeper.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE");
  addHistory(sourceKeeper, ids.owned, workspace);
  addHistory(sourceKeeper, ids.archived, workspace, "PACKAGED_UPGRADE_ARCHIVED_HISTORY");
  addHistory(
    sourceKeeper,
    ids.foreign,
    join(data, "other-product"),
    "PACKAGED_UPGRADE_FOREIGN_HISTORY",
  );
  sourceKeeper.exec("COMMIT");
  const sourceBefore = await fingerprint(source);
  assert.notEqual(sourceBefore["-wal"], null, "Fixture must retain committed history in WAL");
  const ownedBefore = rows(source, ids.owned);
  assert.ok(JSON.stringify(ownedBefore).includes(historyText));

  await writeFile(
    join(explicitWorkspace, ".zcode", "config.json"),
    JSON.stringify({
      storage: {
        sessionDbPath:
          platform === "win" ? "~/explicit-project/explicit-history.sqlite" : explicitDb,
      },
    }),
  );
  await initializeExplicitDatabase(cli, explicitDb, {
    cwd: explicitWorkspace,
    env,
  });
  const explicit = new DatabaseSync(explicitDb);
  addHistory(explicit, ids.explicit, explicitWorkspace, explicitHistoryText);
  explicit.close();
  const explicitBefore = rows(explicitDb, ids.explicit);
  seedMembership(taskIndex, workspace, explicitWorkspace);
  // 首次引导仅完成存储准备时尚可没有设置文件；这里只构造自有新 profile 的恢复配置。
  const settings = JSON.parse(
    await readFile(settingsPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    }),
  );
  await writeFile(
    settingsPath,
    JSON.stringify({
      ...settings,
      lastWorkspaceSession: [
        { kind: "local", workspacePath: workspace, workspacePurpose: "project" },
      ],
      lastActiveWorkspace: { kind: "local", workspacePath: workspace, workspacePurpose: "project" },
      lastActiveTaskByWorkspace: { [workspace]: ids.owned },
    }),
  );

  stage("launching upgrade without a caller-supplied migration flag");
  assert.equal(env.UWORK_SESSION_DB_MIGRATION, undefined);
  await launch();
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.status, "migrated");
  assert.equal(ledger.importedSessions, 2);
  assert.deepEqual(rows(target, ids.owned), ownedBefore);
  assert.ok(rows(target, ids.archived).messages.length > 0);
  assert.deepEqual(rows(target, ids.foreign), { messages: [], parts: [] });
  assert.deepEqual(rows(target, ids.explicit), { messages: [], parts: [] });
  assert.deepEqual(rows(explicitDb, ids.explicit), explicitBefore);
  assert.deepEqual(await fingerprint(source), sourceBefore);
  await readVisibleExplicitHistory(await readVisibleHistory());
  await close();

  const active = new DatabaseSync(target);
  addHistory(active, ids.afterUpgrade, workspace, "PACKAGED_UPGRADE_NEW_TARGET_HISTORY");
  active.close();
  const afterUpgrade = rows(target, ids.afterUpgrade);
  const ledgerBeforeRestart = await readFile(ledgerPath, "utf8");
  stage("restarting to verify completion-ledger idempotency");
  await launch();
  await readVisibleExplicitHistory(await readVisibleHistory());
  assert.deepEqual(rows(target, ids.owned), ownedBefore);
  assert.deepEqual(rows(target, ids.afterUpgrade), afterUpgrade);
  assert.equal(await readFile(ledgerPath, "utf8"), ledgerBeforeRestart);
  assert.deepEqual(rows(explicitDb, ids.explicit), explicitBefore);
  assert.deepEqual(await fingerprint(source), sourceBefore);
  stage(
    "PASS: managed automatic upgrade, visible history, source/WAL preservation, explicit isolation and restart",
  );
  stage(`screenshots: ${artifacts}`);
} catch (error) {
  await saveOwnedFailureLogs().catch(() => {});
  const page = app?.browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => /\/renderer\/index\.html(?:\?|$)/.test(candidate.url()));
  await page?.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  stage(`failure evidence: ${artifacts}`);
  throw error;
} finally {
  try {
    await close();
  } finally {
    sourceKeeper?.close();
    process.chdir(originalCwd);
    await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

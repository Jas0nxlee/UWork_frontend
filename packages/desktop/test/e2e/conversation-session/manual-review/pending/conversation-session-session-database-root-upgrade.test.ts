import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  TID_TASK_SETTINGS_BUTTON,
  TID_SETTINGS_SECTION_NAV,
  TID_SETTINGS_DATA_BASE_DIR_BROWSE,
  TID_SETTINGS_DATA_BASE_DIR_SAVE,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  getE2EAppDataPaths,
  quitElectronAppGracefully,
} from "../../../helpers/desktop-app.js";
import {
  reloadE2EElectronServiceBridge,
  waitForE2EBusinessRendererHandoff,
} from "../../../helpers/e2e-electron-service-lifecycle.js";
import {
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
} from "../../../helpers/v4-conversation.js";

const paths = getE2EAppDataPaths();
const targetPath = join(paths.storageRoot, "cli", "db", "db.sqlite");
const legacyPath = join(paths.homeDir, ".zcode", "cli", "db", "db.sqlite");

function history(path: string, sessionId: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      messages: db.prepare("SELECT * FROM message WHERE session_id=? ORDER BY id").all(sessionId),
      parts: db.prepare("SELECT * FROM part WHERE session_id=? ORDER BY id").all(sessionId),
    };
  } finally {
    db.close();
  }
}

async function restart() {
  await browser.reloadSession();
  await reloadE2EElectronServiceBridge(browser);
  // 复用真实登录/职业引导准备，不在弹层背后用 DOM click 验收历史。
  await prepareV4ConversationE2E({ skipProvider: true });
}

describe("默认会话库路径升级", () => {
  after(async () => {
    await clearAppData();
  });

  it("DBROOT-01/02: 自动升级续聊、幂等重启与冷迁移失败取消", async function () {
    this.timeout(240_000);
    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_DBROOT_SEED preserve this history");
    await waitForV4AssistantMessageContaining("E2E_DBROOT_OLD_READY", 45_000);
    const oldId = (await getV4PaneSnapshot()).sessionId!;
    expect(oldId).not.toBe("draft");
    await selectV4TaskById(oldId);
    await quitElectronAppGracefully();

    // 仅构造隔离 profile 的旧版布局：保留真实会话/Host 索引，旧版本没有新版私有 marker。
    await mkdir(dirname(legacyPath), { recursive: true });
    const original = new DatabaseSync(targetPath, { readOnly: true });
    try {
      await backup(original, legacyPath);
    } finally {
      original.close();
    }
    const legacy = new DatabaseSync(legacyPath);
    try {
      legacy.exec("DROP TABLE IF EXISTS uwork_session_root_migration");
    } finally {
      legacy.close();
    }
    const before = history(legacyPath, oldId);
    expect(JSON.stringify(before)).toContain("E2E_DBROOT_OLD_READY");
    await rm(dirname(targetPath), { recursive: true, force: true });
    const configPath = join(paths.storageRoot, "cli", "config.json");
    let config: { storage?: { sessionDbPath?: string } };
    try {
      config = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      config = {};
    }
    if (config.storage) delete config.storage.sessionDbPath;
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config));

    await restart();
    await selectV4TaskById(oldId, 60_000);
    await waitForV4AssistantMessageContaining("E2E_DBROOT_OLD_READY", 30_000);
    expect(history(targetPath, oldId)).toEqual(before);
    await sendV4Prompt("E2E_DBROOT_RESUME continue the previous history");
    await waitForV4AssistantMessageContaining("E2E_DBROOT_RESUMED", 45_000);
    expect(history(legacyPath, oldId)).toEqual(before);
    expect(history(targetPath, oldId).messages.length).toBeGreaterThan(before.messages.length);

    await prepareV4ConversationE2E();
    await sendV4Prompt("E2E_DBROOT_NEW create after migration");
    await waitForV4AssistantMessageContaining("E2E_DBROOT_NEW_READY", 45_000);
    const newId = (await getV4PaneSnapshot()).sessionId!;
    expect(newId).not.toBe(oldId);
    expect(history(legacyPath, newId)).toEqual({ messages: [], parts: [] });
    const newHistory = history(targetPath, newId);
    expect(JSON.stringify(newHistory)).toContain("E2E_DBROOT_NEW_READY");
    const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifactDir)
      await browser.saveScreenshot(join(artifactDir, "session-db-upgrade-new-task.png"));

    await quitElectronAppGracefully();
    await restart();
    await selectV4TaskById(newId, 60_000);
    await waitForV4AssistantMessageContaining("E2E_DBROOT_NEW_READY", 30_000);
    expect(history(targetPath, newId)).toEqual(newHistory);
    expect(history(legacyPath, oldId)).toEqual(before);
    await selectV4TaskById(oldId);
    await waitForV4AssistantMessageContaining("E2E_DBROOT_RESUMED", 30_000);
    if (artifactDir)
      await browser.saveScreenshot(join(artifactDir, "session-db-upgrade-history-resumed.png"));

    // 保存后外部占用目标：失败 gate 不开放业务，取消计划后仍可使用原活动根。
    const failedBase = join(paths.homeDir, "dbroot-cold-conflict");
    await mkdir(failedBase, { recursive: true });
    const bootstrap = join(paths.appDataDir, "setting.json");
    const previousBase = JSON.parse(await readFile(bootstrap, "utf8")).dataBaseDir;
    const retainedHistory = history(targetPath, oldId);
    await $(`[data-testid="${TID_TASK_SETTINGS_BUTTON}"]`).click();
    await $(`[data-testid="${testId(TID_SETTINGS_SECTION_NAV, "general")}"]`).waitForDisplayed({
      timeout: 15_000,
    });
    await $(`[data-testid="${testId(TID_SETTINGS_SECTION_NAV, "general")}"]`).click();
    const picker = await browser.electron.mock("dialog", "showOpenDialog");
    await picker.mockResolvedValueOnce({ canceled: false, filePaths: [failedBase] });
    await $(`[data-testid="${TID_SETTINGS_DATA_BASE_DIR_BROWSE}"]`).click();
    await $(`[data-testid="${TID_SETTINGS_DATA_BASE_DIR_SAVE}"]`).click();
    await browser.waitUntil(
      async () =>
        JSON.parse(await readFile(bootstrap, "utf8")).pendingDataDirectoryMigration
          ?.targetBaseDir === failedBase,
      {
        timeout: 15_000,
        timeoutMsg: "冷迁移请求未写入",
      },
    );
    const foreign = join(failedBase, ".uwork", "foreign.txt");
    await mkdir(dirname(foreign), { recursive: true });
    await writeFile(foreign, "FOREIGN_TARGET_MUST_SURVIVE");
    await quitElectronAppGracefully();
    await browser.reloadSession();
    await reloadE2EElectronServiceBridge(browser);
    await browser.waitUntil(
      async () =>
        (await $('[data-testid="database-startup-status"]').getAttribute("data-phase")) ===
        "failed",
      {
        timeout: 60_000,
        timeoutMsg: "非空目标没有进入冷迁移失败gate",
      },
    );
    expect(await $$('[contenteditable="true"]')).toHaveLength(0);
    if (artifactDir)
      await browser.saveScreenshot(join(artifactDir, "session-db-cold-migration-conflict.png"));
    const cancel = $('[data-testid="data-directory-startup-cancel"]');
    await cancel.waitForClickable({ timeout: 15_000 });
    await cancel.click();
    await waitForE2EBusinessRendererHandoff(browser);
    await prepareV4ConversationE2E({ skipProvider: true });
    await selectV4TaskById(oldId, 60_000);
    await waitForV4AssistantMessageContaining("E2E_DBROOT_RESUMED", 30_000);
    const cancelled = JSON.parse(await readFile(bootstrap, "utf8"));
    expect(cancelled.dataBaseDir).toBe(previousBase);
    expect(cancelled.pendingDataDirectoryMigration).toBeUndefined();
    expect(history(targetPath, oldId)).toEqual(retainedHistory);
    expect(await readFile(foreign, "utf8")).toBe("FOREIGN_TARGET_MUST_SURVIVE");
    if (artifactDir)
      await browser.saveScreenshot(join(artifactDir, "session-db-cold-migration-cancelled.png"));
  });
});

import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ElectronMock } from "@wdio/electron-types";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_DATA_BASE_DIR_BROWSE,
  TID_SETTINGS_DATA_BASE_DIR_INPUT,
  TID_SETTINGS_DATA_BASE_DIR_SAVE,
  TID_SETTINGS_DATA_BASE_DIR_STATUS,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
} from "../helpers/desktop-app.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart.js";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4Pane,
  waitForV4TimelineContaining,
  waitForV4AssistantMessageContaining,
} from "../helpers/v4-conversation.js";
import { ensureProjectExpanded } from "../helpers/project-sidebar.js";

const CASE_TIMEOUT_MS = 240_000;
const BEFORE_MARKER = "E2E_CDD01_BEFORE_MIGRATION";
const BEFORE_REPLY = "CDD01_BEFORE_MIGRATION_DONE";
const PENDING_MARKER = "E2E_CDD01_PENDING_WRITE";
const PENDING_REPLY = "CDD01_PENDING_WRITE_DONE";
const AFTER_MARKER = "E2E_CDD01_AFTER_MIGRATION";
const AFTER_REPLY = "CDD01_AFTER_MIGRATION_DONE";
const APP_CANARY_NAME = "e2e-cdd01-app-canary.txt";
const APP_CANARY_CONTENT = "CDD01_APP_DATA_CANARY\n";
const PROJECT_CANARY_CONTENT = "CDD01_PROJECT_DATA_CANARY\n";
const paths = getE2EAppDataPaths();
const customDataBaseDir = join(paths.homeDir, "cdd01-custom-data-root");
const customAppDataDir = join(customDataBaseDir, ".uwork", "v2");
const oldTasksIndex = join(paths.appDataDir, "tasks-index.sqlite");
const customTasksIndex = join(customAppDataDir, "tasks-index.sqlite");
const bootstrapSettingsFile = join(paths.appDataDir, "setting.json");
const cliDatabase = join(paths.storageRoot, "cli", "db", "db.sqlite");
const customCliRoot = join(customDataBaseDir, ".uwork", "cli");
const projectCanary = join(paths.workspace, ".zcode", "e2e-cdd01-project-canary.txt");

describe("CDD01：修改数据存储路径后原任务仍可继续", () => {
  let showOpenDialogMock: ElectronMock | null = null;

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
    if (process.env.ZCODE_E2E_DEFER_APP_DATA_CLEANUP !== "1") {
      await rm(customDataBaseDir, { force: true, recursive: true });
      await rm(projectCanary, { force: true });
    }
  });

  it("保存只登记请求；冷重启后 App/CLI 使用新根且原任务 cwd 不变", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    await sendV4Prompt(BEFORE_MARKER);
    await waitForV4AssistantMessageContaining(BEFORE_REPLY, 60_000);
    const sessionId = await waitForCompletedSession();

    await rm(customDataBaseDir, { force: true, recursive: true });
    await mkdir(customDataBaseDir, { recursive: true });
    expect(await readdir(customDataBaseDir)).toEqual([]);
    await writeFile(join(paths.appDataDir, APP_CANARY_NAME), APP_CANARY_CONTENT, "utf8");
    await mkdir(dirname(projectCanary), { recursive: true });
    await writeFile(projectCanary, PROJECT_CANARY_CONTENT, "utf8");
    expect(await pathExists(cliDatabase)).toBe(true);

    showOpenDialogMock = await browser.electron.mock("dialog", "showOpenDialog");
    await showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: [customDataBaseDir],
    });

    const originalBootstrapRoot = await readBootstrapDataBaseDir();
    await openGeneralSettings();
    expect(await readDataBaseDirInput()).toBe(paths.homeDir);
    await clickTestIdByDom(TID_SETTINGS_DATA_BASE_DIR_BROWSE, {
      timeout: 15_000,
      timeoutMsg: "CDD01 数据目录选择按钮不可点击",
    });
    await browser.waitUntil(async () => (await readDataBaseDirInput()) === customDataBaseDir, {
      timeout: 15_000,
      timeoutMsg: "CDD01 系统目录选择结果没有写入只读路径框",
    });
    await clickTestIdByDom(TID_SETTINGS_DATA_BASE_DIR_SAVE, {
      timeout: 15_000,
      timeoutMsg: "CDD01 数据目录保存按钮不可点击",
    });
    await waitForDataBaseDirSaved();

    expect(await readBootstrapDataBaseDir()).toBe(originalBootstrapRoot);
    const pendingSettings = JSON.parse(await readFile(bootstrapSettingsFile, "utf8"));
    expect(pendingSettings.pendingDataDirectoryMigration).toMatchObject({
      sourceBaseDir: paths.homeDir,
      targetBaseDir: customDataBaseDir,
    });
    // 业务进程仍在运行时不复制数据库，也不先切换活动根。
    expect(await pathExists(customAppDataDir)).toBe(false);
    expect(await pathExists(customCliRoot)).toBe(false);
    expect(await readFile(projectCanary, "utf8")).toBe(PROJECT_CANARY_CONTENT);

    // 保存请求后仍可在旧活动根继续工作；冷启动必须带走这些晚于请求的新消息。
    await closeSettings(sessionId);
    await sendV4Prompt(PENDING_MARKER);
    await waitForV4AssistantMessageContaining(PENDING_REPLY, 60_000);
    await waitForCompletedSession();
    expect(await pathExists(customAppDataDir)).toBe(false);

    await restartIntoWorkspacePreservingProfile();
    // 登录弹层下的任务 DOM 仍可能已挂载；重启后须走真实跳过入口，再验收可操作界面。
    await prepareV4ConversationE2E({ skipProvider: true });
    expect(await $('[data-testid="enterprise-login-page"]').isExisting()).toBe(false);
    expect(await readBootstrapDataBaseDir()).toBe(customDataBaseDir);
    const committedSettings = JSON.parse(await readFile(bootstrapSettingsFile, "utf8"));
    expect(committedSettings.pendingDataDirectoryMigration ?? null).toBeNull();
    expect(await readFile(join(customAppDataDir, APP_CANARY_NAME), "utf8")).toBe(
      APP_CANARY_CONTENT,
    );
    expect(await pathExists(customTasksIndex)).toBe(true);
    expect(await pathExists(join(customAppDataDir, "setting.json"))).toBe(false);
    expect(await pathExists(join(customCliRoot, "db", "db.sqlite"))).toBe(true);
    await ensureProjectExpanded(DEFAULT_WORKSPACE);
    await selectV4TaskById(sessionId);
    await waitForV4TimelineContaining(BEFORE_MARKER, 60_000);
    await waitForV4AssistantMessageContaining(BEFORE_REPLY, 60_000);
    await waitForV4AssistantMessageContaining(PENDING_REPLY, 60_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      "CDD01 冷重启后原任务没有恢复到 idle",
      60_000,
    );

    await openGeneralSettings();
    expect(await readDataBaseDirInput()).toBe(customDataBaseDir);
    await closeSettings(sessionId);

    const oldMessagesBeforeFollowup = readSessionMessages(cliDatabase, sessionId);
    const oldUpdatedAtBeforeFollowup = readTaskUpdatedAt(oldTasksIndex, sessionId);
    const customUpdatedAtBeforeFollowup = readTaskUpdatedAt(customTasksIndex, sessionId);
    expect(oldUpdatedAtBeforeFollowup).not.toBeNull();
    expect(customUpdatedAtBeforeFollowup).not.toBeNull();

    await sendV4Prompt(AFTER_MARKER);
    await waitForV4AssistantMessageContaining(AFTER_REPLY, 60_000);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === sessionId && !snapshot.canStop,
      "CDD01 新路径下的同任务 follow-up 没有完成",
      60_000,
    );
    await waitForTaskIndexAdvance(
      customTasksIndex,
      sessionId,
      customUpdatedAtBeforeFollowup as number,
    );

    expect(readTaskUpdatedAt(oldTasksIndex, sessionId)).toBe(oldUpdatedAtBeforeFollowup);
    expect(await pathExists(cliDatabase)).toBe(true);
    expect(await pathExists(customCliRoot)).toBe(true);
    expect(readSessionMessages(cliDatabase, sessionId)).toEqual(oldMessagesBeforeFollowup);
    expect(
      readSessionMessages(join(customCliRoot, "db", "db.sqlite"), sessionId).length,
    ).toBeGreaterThan(oldMessagesBeforeFollowup.length);
    expect(await readFile(projectCanary, "utf8")).toBe(PROJECT_CANARY_CONTENT);
    expect(await $('[data-testid="enterprise-login-page"]').isExisting()).toBe(false);
    expect(await $('[data-testid="onboarding-page"]').isExisting()).toBe(false);
    if (process.env.ZCODE_E2E_ARTIFACT_DIR)
      await browser.saveScreenshot(
        join(process.env.ZCODE_E2E_ARTIFACT_DIR, "data-directory-cold-move-resumed.png"),
      );
  });
});

async function waitForCompletedSession(): Promise<string> {
  const snapshot = await waitForV4Pane(
    (current) => Boolean(current.sessionId && current.sessionId !== "draft" && !current.canStop),
    "CDD01 迁移前任务没有完成",
    60_000,
  );
  if (!snapshot.sessionId || snapshot.sessionId === "draft") {
    throw new Error(`CDD01 缺少迁移前 sessionId: ${String(snapshot.sessionId)}`);
  }
  return snapshot.sessionId;
}

async function openGeneralSettings(): Promise<void> {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "CDD01 没有找到设置入口",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (settingsPageTestId) =>
          Boolean(document.querySelector(`[data-testid="${settingsPageTestId}"]`)),
        TID_SETTINGS_PAGE,
      ),
    { timeout: 15_000, timeoutMsg: "CDD01 设置页没有打开" },
  );
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"), {
    timeout: 15_000,
    timeoutMsg: "CDD01 设置页没有常规分区入口",
  });
  await browser.waitUntil(async () => (await readDataBaseDirInput()) !== null, {
    timeout: 15_000,
    timeoutMsg: "CDD01 常规设置没有数据存储路径控件",
  });
}

async function closeSettings(expectedSessionId: string): Promise<void> {
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, {
    timeout: 15_000,
    timeoutMsg: "CDD01 设置页返回按钮没有出现",
  });
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === expectedSessionId,
    `CDD01 返回工作区后没有恢复 Session ${expectedSessionId}`,
    30_000,
  );
}

function readDataBaseDirInput(): Promise<string | null> {
  return browser.execute((inputTestId) => {
    const input = document.querySelector<HTMLInputElement>(`[data-testid="${inputTestId}"]`);
    return input?.value ?? null;
  }, TID_SETTINGS_DATA_BASE_DIR_INPUT);
}

async function waitForDataBaseDirSaved(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute((statusTestId) => {
        const status = document.querySelector<HTMLElement>(`[data-testid="${statusTestId}"]`);
        return status?.dataset.state === "saved";
      }, TID_SETTINGS_DATA_BASE_DIR_STATUS),
    {
      timeout: 60_000,
      timeoutMsg: "CDD01 迁移请求没有保存为待重启状态",
    },
  );
}

async function readBootstrapDataBaseDir(): Promise<string | null> {
  const settings = JSON.parse(await readFile(bootstrapSettingsFile, "utf8")) as {
    dataBaseDir?: unknown;
  };
  return typeof settings.dataBaseDir === "string" ? settings.dataBaseDir : null;
}

function readTaskUpdatedAt(databasePath: string, sessionId: string): number | null {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const row = database
      .prepare("SELECT updated_at FROM tasks WHERE task_id = ? LIMIT 1")
      .get(sessionId) as { updated_at: number } | undefined;
    return row?.updated_at ?? null;
  } finally {
    database.close();
  }
}

async function waitForTaskIndexAdvance(
  databasePath: string,
  sessionId: string,
  previousUpdatedAt: number,
): Promise<void> {
  let latest: number | null = null;
  await browser.waitUntil(
    async () => {
      latest = readTaskUpdatedAt(databasePath, sessionId);
      return latest !== null && latest > previousUpdatedAt;
    },
    {
      timeout: 30_000,
      timeoutMsg: `CDD01 新 App 根 task-index 没有推进: previous=${previousUpdatedAt}; latest=${String(latest)}`,
    },
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function readSessionMessages(path: string, sessionId: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT id,data FROM message WHERE session_id=? ORDER BY id").all(sessionId);
  } finally {
    db.close();
  }
}

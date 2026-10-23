import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildServerRemoteWorkspaceIdentity, type RemoteTarget } from "@zcode/shared";
import {
  TID_COMPOSER_WORK_OUTSIDE_PROJECT,
  TID_COMPOSER_WORKSPACE_TRIGGER,
} from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";

const CASE_MARKER = "E2E_LOCAL_CONVERSATION_IDENTITY";
const REMOTE_IDENTITY = buildServerRemoteWorkspaceIdentity({
  serverId: "25db8db2-d27b-40de-a23e-697b3c127234",
  workspacePath: DEFAULT_WORKSPACE,
});
const artifactDir = resolve(
  process.env.ZCODE_E2E_ARTIFACT_DIR ?? ".e2e-artifacts/local-conversation-identity",
);

interface NavigationTab {
  id: string;
  kind: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: string;
  remoteSessionId?: string;
}

interface NavigationWindow extends Window {
  __zcodeTabStoreE2E?: {
    getState(): {
      tabs: NavigationTab[];
      activeTabId: string | null;
      activeWorkspacePath: string | null;
      activeWorkspaceIdentity: string | null;
      addTab(
        path: string,
        options: { workspaceIdentity: string; remoteTarget: RemoteTarget },
      ): string;
      activateTab(id: string): void;
    };
  };
}

async function readNavigation() {
  return browser.execute(() => {
    const state = (window as NavigationWindow).__zcodeTabStoreE2E?.getState();
    if (!state) throw new Error("导航 store 未就绪");
    const pendingTaskDraft = JSON.parse(
      localStorage.getItem('zcode-pending-task-draft:v1:["desktop","local",null]') ?? "null",
    ) as { draftId?: string; workspacePath?: string } | null;
    return {
      activeTabId: state.activeTabId,
      activeWorkspacePath: state.activeWorkspacePath,
      activeWorkspaceIdentity: state.activeWorkspaceIdentity,
      pendingTaskDraft,
      tabs: state.tabs.map((tab) => ({
        id: tab.id,
        workspacePath: tab.workspacePath ?? null,
        workspaceIdentity: tab.workspaceIdentity ?? null,
        workspacePurpose: tab.workspacePurpose ?? null,
        remoteSessionId: tab.remoteSessionId ?? null,
      })),
    };
  });
}

describe(`${CASE_MARKER}: 本地项目解除绑定按完整工作区身份匹配`, () => {
  const facts: Record<string, unknown> = {};

  after(async () => {
    await mkdir(artifactDir, { recursive: true });
    facts.final = await readNavigation();
    await writeFile(
      resolve(artifactDir, "local-conversation-identity.json"),
      JSON.stringify(facts, null, 2),
    );
    await browser.saveScreenshot(resolve(artifactDir, "local-conversation-identity.png"));
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("RPN-12 本地项目与离线远端同路径且远端在前，仍能在项目外工作", async function () {
    this.timeout(60_000);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 30_000);
    // 只构造离线 open-set，不连接 SSH；调用真实 store 的 add/activate，复现新 tab 置顶的顺序。
    const localId = await browser.execute(
      (path, identity) => {
        const store = (window as NavigationWindow).__zcodeTabStoreE2E;
        const localTab = store
          ?.getState()
          .tabs.find(
            (tab) =>
              tab.kind === "workspace" && tab.workspacePath === path && !tab.workspaceIdentity,
          );
        if (!store || !localTab) throw new Error("本地项目 tab 未就绪");
        store.getState().addTab(path, {
          workspaceIdentity: identity,
          remoteTarget: { kind: "ssh", host: "offline.example.com", username: "dev", port: 22 },
        });
        store.getState().activateTab(localTab.id);
        return localTab.id;
      },
      DEFAULT_WORKSPACE,
      REMOTE_IDENTITY,
    );

    const before = await readNavigation();
    facts.before = before;
    expect(before.activeTabId).toBe(localId);
    expect(before.activeWorkspaceIdentity).toBeNull();
    expect(before.tabs[0]?.workspaceIdentity).toBe(REMOTE_IDENTITY);
    expect(before.tabs[0]?.remoteSessionId).toBeNull();
    expect(before.tabs[1]?.id).toBe(localId);

    await $(`[data-testid="${TID_COMPOSER_WORKSPACE_TRIGGER}"]`).click();
    const workOutsideProject = $(`[data-testid="${TID_COMPOSER_WORK_OUTSIDE_PROJECT}"]`);
    await workOutsideProject.waitForDisplayed({ timeout: 10_000 });
    await workOutsideProject.click();
    await browser.waitUntil(
      async () => {
        const state = await readNavigation();
        return (
          Boolean(state.pendingTaskDraft?.draftId && state.pendingTaskDraft.workspacePath) &&
          state.activeWorkspacePath === state.pendingTaskDraft?.workspacePath &&
          state.activeWorkspaceIdentity === null
        );
      },
      { timeout: 10_000, timeoutMsg: `${CASE_MARKER}: 点击后没有进入本地 conversation workspace` },
    );
    const after = await readNavigation();
    // 无项目菜单已统一到待发送草稿 owner；固定 default 目录会漏掉身份绑定或误判新目录。
    const targetPath = after.pendingTaskDraft?.workspacePath;
    if (!targetPath) throw new Error(`${CASE_MARKER}: 未登记本地待发送草稿目录`);
    await waitForWorkspaceApp(targetPath, 10_000);
    facts.after = after;
    expect(after.pendingTaskDraft?.draftId).toBeTruthy();
    expect(after.activeWorkspacePath).toBe(targetPath);
    expect(after.activeWorkspacePath).not.toBe(DEFAULT_WORKSPACE);
    expect(after.tabs.find((tab) => tab.id === after.activeTabId)?.workspacePurpose).toBe(
      "conversation",
    );
    expect(after.tabs.find((tab) => tab.id === localId)).toEqual(before.tabs[1]);
    expect(after.tabs.find((tab) => tab.workspaceIdentity === REMOTE_IDENTITY)).toEqual(
      before.tabs[0],
    );
  });
});

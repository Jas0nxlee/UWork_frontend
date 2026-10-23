// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readV4ComposerDraft,
  readComposerWorkspaceScope,
  rememberComposerWorkspaceScope,
  resolveComposerScope,
  ensurePendingTaskDraft,
  bindPendingTaskDraft,
  readPendingTaskDraft,
  persistV4ComposerDraft,
  markPendingTaskDraftCommand,
} from "@/v4/composer/composerDraftStore.js";
import { selectRemoteWorkspaceProjectFromDialog } from "@/root/useRemoteWorkspaceHistory.js";
import type { CreateTaskOptions } from "@/app-shell/types.js";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { onTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import {
  INITIAL_PANE_LAYOUT,
  V4_PRIMARY_PANE_ID,
  countPanes,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

function fixture(
  clientMode: "desktop-continuous" | "web-remote-replayable" = "desktop-continuous",
  openRemoteProjectWorkspace?: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
    hostId: string;
  }) => Promise<void>,
  openMobileProjectDraft?: (request: CreateTaskOptions) => Promise<void>,
) {
  let next = 0;
  const prepared = new Map<string, string>();
  const prepareSession = vi.fn(
    async (input?: {
      projectId?: string;
      draftId?: string;
      reuseDraft?: boolean;
      hostId?: string;
    }) => {
      const path = input?.projectId
        ? "/project-primary"
        : (input?.draftId && prepared.get(input.draftId)) || `/managed/${++next}`;
      if (input?.draftId) prepared.set(input.draftId, path);
      return {
        workspacePath: path,
        projectId: input?.projectId ?? null,
        additionalDirectories: [],
      };
    },
  );
  const readTree = vi.fn(async (_input?: unknown) => ({
    tasks: [] as {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
      projectId: string | null;
    }[],
  }));
  const addTab = vi.fn();
  const state = {
    tabs: [],
    activeWorkspacePath: "/old",
    activeWorkspaceIdentity: null,
    activateTabByPath: vi.fn(() => true),
  };
  const options = {
    intl: { formatMessage: ({ id }: { id: string }) => id } as never,
    platform: {} as never,
    services: { projectService: { prepareSession, readTree } } as never,
    tabStoreApi: { getState: () => state } as never,
    addTab,
    activeWorkspacePath: "/old",
    activeWorkspaceIdentity: null,
    supportsSettings: true,
    allowOpenWorkspace: true,
    preferDirectoryBrowser: false,
    refreshProviderState: vi.fn(),
    updateAppSettings: vi.fn(),
    setOAuthError: vi.fn(),
    setUser: vi.fn(),
    workbenchGroupClientMode: clientMode,
    openMobileProjectDraft,
  };
  const { result, rerender } = renderHook(
    ({ opener }) => useRootWorkspaceActions({ ...options, openRemoteProjectWorkspace: opener }),
    { initialProps: { opener: openRemoteProjectWorkspace } },
  );
  return { result, rerender, prepareSession, readTree, addTab, state };
}
beforeEach(() => {
  localStorage.clear();
  useZCodeSessionStore.setState({ workspaces: {} });
  usePaneLayoutStore.setState(INITIAL_PANE_LAYOUT);
  useWorkbenchGroupStore.getState().resetWorkbenchGroups();
});

it("无项目菜单与任务加号共用未发送目录及草稿身份", async () => {
  const { result, prepareSession } = fixture();
  let path!: string;
  await act(async () => {
    path = await result.current.handleResolveConversationWorkspace();
  });
  const pending = readPendingTaskDraft(resolveComposerScope(null));
  expect(pending).toMatchObject({ workspacePath: path, draftId: expect.any(String) });
  expect(prepareSession).toHaveBeenLastCalledWith({ draftId: pending!.draftId, reuseDraft: false });
  await act(async () => {
    await result.current.handleCreateTask({ projectId: null });
  });
  expect(prepareSession).toHaveBeenLastCalledWith({ draftId: pending!.draftId, reuseDraft: true });
});

it("缺失的未发送目录换代且保留正文，已运行任务不受影响", async () => {
  const scope = resolveComposerScope(null);
  const stale = ensurePendingTaskDraft(scope);
  bindPendingTaskDraft(scope, stale.draftId, "/missing");
  persistV4ComposerDraft("/missing", undefined, "__draft__", { text: "保留未发送正文" }, scope);
  useZCodeSessionStore.getState().setActiveTaskId("/old", "running-session");
  const { result, prepareSession, addTab } = fixture();
  prepareSession.mockRejectedValueOnce(new Error("project.draftDirectoryMissing"));
  await act(async () => {
    await result.current.handleCreateTask({ projectId: null });
  });
  const next = readPendingTaskDraft(scope)!;
  expect(next.draftId).not.toBe(stale.draftId);
  expect(prepareSession).toHaveBeenLastCalledWith({ draftId: next.draftId, reuseDraft: false });
  expect(addTab).toHaveBeenCalledWith(next.workspacePath, { workspacePurpose: "conversation" });
  expect(readV4ComposerDraft(next.workspacePath!, undefined, "__draft__", scope)?.text).toBe(
    "保留未发送正文",
  );
  expect(useZCodeSessionStore.getState().getWorkspaceState("/old").activeTaskId).toBe(
    "running-session",
  );
});

it.each(["pending-command", "permission"])("%s 不得使草稿目录误换代", async (condition) => {
  const scope = resolveComposerScope(null);
  const pending = ensurePendingTaskDraft(scope);
  bindPendingTaskDraft(scope, pending.draftId, "/missing");
  if (condition === "pending-command")
    markPendingTaskDraftCommand(scope, pending.draftId, "command", null);
  const { result, prepareSession, addTab } = fixture();
  const message = condition === "pending-command" ? "project.draftDirectoryMissing" : "EACCES";
  prepareSession.mockRejectedValueOnce(new Error(message));
  await act(async () => {
    await result.current.handleCreateTask({ projectId: null });
  });
  expect(prepareSession).toHaveBeenCalledTimes(1);
  expect(readPendingTaskDraft(scope)?.draftId).toBe(pending.draftId);
  expect(addTab).not.toHaveBeenCalled();
  expect(result.current.workspaceActionError).toBe(message);
});

it("旧目录检查晚回时不覆盖另一份新草稿", async () => {
  const scope = resolveComposerScope(null);
  const stale = ensurePendingTaskDraft(scope);
  bindPendingTaskDraft(scope, stale.draftId, "/missing");
  const { result, prepareSession, addTab } = fixture();
  let reject!: (error: Error) => void;
  prepareSession.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  let opening!: Promise<void>;
  await act(async () => {
    opening = result.current.handleCreateTask({ projectId: null });
  });
  const nextId = crypto.randomUUID();
  localStorage.setItem(
    'zcode-pending-task-draft:v1:["desktop","local",null]',
    JSON.stringify({ draftId: nextId }),
  );
  await act(async () => {
    reject(new Error("project.draftDirectoryMissing"));
    await opening;
  });
  expect(readPendingTaskDraft(scope)?.draftId).toBe(nextId);
  expect(prepareSession).toHaveBeenCalledTimes(1);
  expect(addTab).not.toHaveBeenCalled();
});

it("目录检查成功前草稿已被首发 ACK 消费时不重新打开旧目录", async () => {
  const scope = resolveComposerScope(null);
  const stale = ensurePendingTaskDraft(scope);
  bindPendingTaskDraft(scope, stale.draftId, "/sent-task");
  const { result, prepareSession, addTab } = fixture();
  let finish!: (value: Awaited<ReturnType<typeof prepareSession>>) => void;
  prepareSession.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let opening!: Promise<void>;
  await act(async () => {
    opening = result.current.handleCreateTask({ projectId: null });
  });
  localStorage.removeItem('zcode-pending-task-draft:v1:["desktop","local",null]');
  await act(async () => {
    finish({ workspacePath: "/sent-task", projectId: null, additionalDirectories: [] });
    await opening;
  });
  expect(readPendingTaskDraft(scope)).toBeNull();
  expect(addTab).not.toHaveBeenCalled();
  expect(prepareSession).toHaveBeenCalledTimes(1);
  expect(result.current.workspaceActionError).toBeNull();
});

it("离开原任务后缺失目录的迟到结果不触发换代", async () => {
  const scope = resolveComposerScope(null);
  const stale = ensurePendingTaskDraft(scope);
  bindPendingTaskDraft(scope, stale.draftId, "/missing");
  const { result, prepareSession, addTab } = fixture();
  let reject!: (error: Error) => void;
  prepareSession.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  let opening!: Promise<void>;
  await act(async () => {
    opening = result.current.handleCreateTask({ projectId: null });
  });
  act(() => useZCodeSessionStore.getState().setActiveTaskId("/old", "another-task"));
  await act(async () => {
    reject(new Error("project.draftDirectoryMissing"));
    await opening;
  });
  expect(readPendingTaskDraft(scope)?.draftId).toBe(stale.draftId);
  expect(prepareSession).toHaveBeenCalledTimes(1);
  expect(addTab).not.toHaveBeenCalled();
  expect(result.current.workspaceActionError).toBeNull();
});

it.each(["missing", "success"])("菜单目录准备 %s 晚回时不覆盖新导航", async (outcome) => {
  const scope = resolveComposerScope(null);
  const stale = ensurePendingTaskDraft(scope);
  bindPendingTaskDraft(scope, stale.draftId, "/missing");
  const { result, prepareSession } = fixture();
  let finish!: (value: Awaited<ReturnType<typeof prepareSession>>) => void;
  let reject!: (error: Error) => void;
  prepareSession.mockImplementationOnce(
    () =>
      new Promise((resolve, fail) => {
        finish = resolve;
        reject = fail;
      }),
  );
  let opening!: Promise<string>;
  await act(async () => {
    opening = result.current.handleResolveConversationWorkspace();
  });
  act(() => useZCodeSessionStore.getState().setActiveTaskId("/old", "other-task"));
  const check = expect(opening).rejects.toThrow();
  await act(async () => {
    if (outcome === "missing") reject(new Error("project.draftDirectoryMissing"));
    else finish({ workspacePath: "/missing", projectId: null, additionalDirectories: [] });
    await check;
  });
  expect(prepareSession).toHaveBeenCalledTimes(1);
  expect(readPendingTaskDraft(scope)?.draftId).toBe(stale.draftId);
  expect(result.current.workspaceActionError).toBeNull();
});
it.each([null, "other-project", "retained-project"])(
  "恢复原项目时显式初始化草稿归属，不沿用缓存 %s",
  async (cachedProjectId) => {
    const path = "/srv/project";
    const identity = "remote:server:source-1:/srv/project";
    const projectId = "retained-project";
    if (cachedProjectId)
      rememberComposerWorkspaceScope(
        path,
        identity,
        resolveComposerScope(cachedProjectId, identity),
      );
    const { result } = fixture();
    const activation = vi.fn(
      (target: { workspacePath: string; workspaceIdentity: string; projectId?: string | null }) =>
        result.current.startDraftInWorkspace(target.workspacePath, target.workspaceIdentity, {
          projectId: target.projectId,
        }),
    );
    await act(async () => {
      await selectRemoteWorkspaceProjectFromDialog({
        canUseRemoteWorkspace: true,
        sessionId: "session-1",
        path,
        preparedWorkspaceIdentity: identity,
        draftProjectId: projectId,
        restoringWorkspaceTabId: "tab",
        loadingMessage: "loading",
        getRemoteWorkspaceSession: () =>
          ({
            sessionId: "session-1",
            target: { kind: "ssh", host: "dev.example.com", username: "dev" },
          }) as never,
        getWorkspaceTabs: () => [
          {
            id: "tab",
            kind: "workspace",
            label: "project",
            workspacePath: path,
            workspaceIdentity: identity,
            remoteSessionId: "session-1",
          },
        ],
        resolveRemoteWorkspaceCanonicalPath: async () => path,
        activateTabByPath: () => true,
        handleCancelRemoteProject: vi.fn(),
        bindRemoteWorkspaceScope: async () => ({
          workspacePath: path,
          workspaceIdentity: identity,
        }),
        commitRemoteWorkspaceSessionMutation: async (mutation) => mutation.entry,
        getRemoteSessions: () => [],
        bindRemoteWorkspacePath: vi.fn(),
        bindRemoteWorkspaceIdentity: vi.fn(),
        addTab: vi.fn(),
        onWorkspaceActivated: activation,
      });
    });
    expect(activation).toHaveBeenCalledOnce();
    expect(activation).toHaveBeenCalledWith({
      workspacePath: path,
      workspaceIdentity: identity,
      projectId,
    });
    expect(useZCodeSessionStore.getState().getWorkspaceState(path, identity).draftProjectId).toBe(
      projectId,
    );
    expect(readComposerWorkspaceScope(path, identity)?.projectId).toBe(projectId);
  },
);
describe("project-aware new task creation", () => {
  it("keeps new-task callbacks stable while using the latest committed remote opener", async () => {
    const previous = vi.fn(async () => {});
    const latest = vi.fn(async () => {});
    const { result, rerender, prepareSession } = fixture("desktop-continuous", previous);
    const create = result.current.handleCreateTask;
    const createConversation = result.current.handleCreateConversationTask;
    rerender({ opener: latest });
    expect(result.current.handleCreateTask).toBe(create);
    expect(result.current.handleCreateConversationTask).toBe(createConversation);
    prepareSession.mockResolvedValueOnce({
      workspacePath: "/remote",
      workspaceIdentity: "remote:server:s:/remote",
      projectId: "p",
      additionalDirectories: [],
    } as never);
    await act(async () => create({ projectId: "p", hostId: "remote:server:s" }));
    expect(previous).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceIdentity: "remote:server:s:/remote", projectId: "p" }),
    );
  });
  it.each([true, false])(
    "publishes a settings return only after tab activation succeeds (%s)",
    (activated) => {
      useZCodeSessionStore.getState().setActiveTaskId("/old", "old-session");
      const { result, state } = fixture();
      state.activateTabByPath.mockReturnValue(activated);
      const history = useZCodeSessionStore.getState().taskNavHistory;
      const viewed = vi.fn();
      const subscription = onTaskNavigationCommitted(viewed);
      try {
        act(() => result.current.handleBackFromSettings());
        expect(viewed).toHaveBeenCalledTimes(activated ? 1 : 0);
        if (activated)
          expect(viewed).toHaveBeenCalledWith({
            kind: "task",
            workspacePath: "/old",
            taskId: "old-session",
            workspaceIdentity: undefined,
          });
        expect(useZCodeSessionStore.getState().taskNavHistory).toBe(history);
      } finally {
        subscription.dispose();
      }
    },
  );
  it("routes the selected Host and binds its attachment before creating a draft under the returned identity", async () => {
    const open = vi.fn(async () => {});
    const { result, prepareSession, addTab } = fixture("desktop-continuous", open);
    prepareSession.mockResolvedValueOnce({
      workspacePath: "/remote",
      workspaceIdentity: "remote:server:s:/remote",
      projectId: "p",
      additionalDirectories: [],
    } as never);
    await act(async () => {
      await result.current.handleCreateTask({ projectId: "p", hostId: "remote:server:s" });
    });
    expect(prepareSession).toHaveBeenCalledWith({ projectId: "p", hostId: "remote:server:s" });
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "remote:server:s",
        workspacePath: "/remote",
        workspaceIdentity: "remote:server:s:/remote",
      }),
    );
    expect(addTab).not.toHaveBeenCalled();
    expect(
      useZCodeSessionStore.getState().getWorkspaceState("/remote", "remote:server:s:/remote")
        .draftProjectId,
    ).toBe("p");
    expect(useZCodeSessionStore.getState().workspaces["/remote"]).toBeUndefined();
  });
  it.each(["desktop-continuous"] as const)(
    "PD01 连续新建复用未发送目录，显式 local Host 也保持同一身份（%s）",
    async (mode) => {
      useZCodeSessionStore.getState().setActiveTaskId("/old", "old-session");
      const { result, prepareSession, addTab } = fixture(mode);
      await act(async () => {
        await result.current.handleCreateTask({ projectId: null, hostId: "local" });
        await result.current.handleCreateTask({ projectId: null, hostId: "local" });
      });
      expect(prepareSession).toHaveBeenCalledTimes(2);
      expect(addTab).toHaveBeenNthCalledWith(1, "/managed/1", { workspacePurpose: "conversation" });
      expect(addTab).toHaveBeenNthCalledWith(2, "/managed/1", { workspacePurpose: "conversation" });
      expect(
        useZCodeSessionStore.getState().getWorkspaceState("/managed/1").draftProjectId,
      ).toBeNull();
      expect(useZCodeSessionStore.getState().getWorkspaceState("/old").activeTaskId).toBe(
        "old-session",
      );
    },
  );
  it("uses the selected project primary directory, exits split view and preserves mention spacing", async () => {
    const { result, prepareSession } = fixture();
    usePaneLayoutStore.getState().splitPaneWithBinding(V4_PRIMARY_PANE_ID, "right", {
      workspaceScope: { workspacePath: "/unrelated" },
      sessionId: "another",
    });
    const mention = {
      id: "skill:creator",
      category: "skills" as const,
      label: "creator",
      value: "creator",
      markdown: "$creator",
    };
    await act(async () => {
      await result.current.handleCreateTask({
        projectId: "project-a",
        initialPrompt: "$creator ",
        initialPromptMention: mention,
      });
    });
    expect(prepareSession).toHaveBeenCalledWith({ projectId: "project-a" });
    const draft = useZCodeSessionStore.getState().getWorkspaceState("/project-primary");
    expect(draft.draftProjectId).toBe("project-a");
    expect(draft.composerTextInsertRequest).toMatchObject({ text: "$creator ", mention });
    expect(countPanes(usePaneLayoutStore.getState())).toBe(1);
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBeNull();
  });
  it("leaves the current session intact when directory preparation fails", async () => {
    useZCodeSessionStore.getState().setActiveTaskId("/old", "old-session");
    const { result, prepareSession, addTab } = fixture();
    prepareSession.mockRejectedValueOnce(new Error("directory unavailable"));
    await act(async () => {
      await result.current.handleCreateTask();
    });
    expect(addTab).not.toHaveBeenCalled();
    expect(useZCodeSessionStore.getState().getWorkspaceState("/old").activeTaskId).toBe(
      "old-session",
    );
    expect(result.current.workspaceActionError).toContain("directory unavailable");
  });
});

it("hands mobile project intent to the bridge owner without preparing or mutating the old Root", async () => {
  let finish!: () => void;
  const openMobileProjectDraft = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { result, prepareSession, addTab } = fixture(
    "web-remote-replayable",
    undefined,
    openMobileProjectDraft,
  );
  useZCodeSessionStore.getState().setActiveTaskId("/old", "old-session");
  const request = { projectId: "p", hostId: "remote:server:s", initialPrompt: "$creator " };
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.handleCreateTask(request);
  });
  expect(openMobileProjectDraft).toHaveBeenCalledWith(request);
  expect(prepareSession).not.toHaveBeenCalled();
  useZCodeSessionStore
    .getState()
    .startDraft("/new", undefined, "remote:server:s:/new", { projectId: "p" });
  await act(async () => {
    finish();
    await pending;
  });
  expect(addTab).not.toHaveBeenCalled();
  expect(useZCodeSessionStore.getState().getWorkspaceState("/old").activeTaskId).toBe(
    "old-session",
  );
  expect(
    useZCodeSessionStore.getState().getWorkspaceState("/new", "remote:server:s:/new")
      .draftProjectId,
  ).toBe("p");
});
it("initializes a handed off draft with its project and exact input under the new identity", () => {
  const { result } = fixture("web-remote-replayable");
  const mention = {
    id: "skill:creator",
    category: "skills" as const,
    label: "creator",
    value: "creator",
    markdown: "$creator",
  };
  act(() =>
    result.current.startDraftInWorkspace("/new", "remote:server:s:/new", {
      projectId: "p",
      provider: "zcode",
      initialPrompt: "$creator ",
      initialPromptMention: mention,
    }),
  );
  const draft = useZCodeSessionStore.getState().getWorkspaceState("/new", "remote:server:s:/new");
  expect(draft.draftProjectId).toBe("p");
  expect(draft.composerTextInsertRequest).toMatchObject({ text: "$creator ", mention });
  expect(useZCodeSessionStore.getState().workspaces["/new"]).toBeUndefined();
});

it("does not allocate a directory when the mobile peer lacks project admission", async () => {
  const { result, prepareSession, addTab } = fixture("web-remote-replayable");
  await act(async () => {
    await result.current.handleCreateTask();
  });
  expect(prepareSession).not.toHaveBeenCalled();
  expect(addTab).not.toHaveBeenCalled();
  expect(result.current.workspaceActionError).toBe("project.remote-navigation-unavailable");
});

it.each(["desktop-continuous", "web-remote-replayable"] as const)(
  "TD07 %s 空白创建意图只留在内存，文字出现时才保存项目和分组",
  (mode) => {
    const { result } = fixture(mode);
    act(() =>
      result.current.startDraftInWorkspace("/metadata", "remote:server:s:/metadata", {
        projectId: "p",
        taskGroupId: "g",
      }),
    );
    expect(
      useZCodeSessionStore.getState().getWorkspaceState("/metadata", "remote:server:s:/metadata"),
    ).toMatchObject({ draftProjectId: "p", draftTaskGroupId: "g" });
    expect(
      readV4ComposerDraft("/metadata", "remote:server:s:/metadata", "__draft__", {
        clientNamespace: "desktop",
        hostId: "remote:server:s",
        projectId: "p",
      }),
    ).toBeNull();
    act(() =>
      result.current.startDraftInWorkspace("/metadata", "remote:server:s:/metadata", {
        projectId: "p",
        taskGroupId: "g",
        initialPrompt: "draft",
      }),
    );
    expect(
      readV4ComposerDraft("/metadata", "remote:server:s:/metadata", "__draft__", {
        clientNamespace: "desktop",
        hostId: "remote:server:s",
        projectId: "p",
      }),
    ).toMatchObject({ text: "draft", projectId: "p", taskGroupId: "g" });
  },
);

it.each(["desktop-continuous", "web-remote-replayable"] as const)(
  "D3 %s inherits the current session project by exact task identity",
  async (mode) => {
    useZCodeSessionStore.getState().setActiveTaskId("/old", "session");
    const open = vi.fn(async () => {});
    const { result, prepareSession, readTree } = fixture(mode, undefined, open);
    readTree.mockResolvedValueOnce({
      tasks: [
        { taskId: "session", workspacePath: "/other", projectId: "wrong" },
        { taskId: "session", workspacePath: "/old", projectId: "current" },
      ],
    });
    await act(async () => {
      await result.current.handleCreateTask();
    });
    if (mode === "desktop-continuous") {
      expect(prepareSession).toHaveBeenCalledWith({ projectId: "current" });
    } else {
      expect(open).toHaveBeenCalledWith({ projectId: "current" });
      expect(prepareSession).not.toHaveBeenCalled();
    }
  },
);

it("D3 inherits draft project without reading task history; explicit null opts out", async () => {
  useZCodeSessionStore
    .getState()
    .startDraft("/old", undefined, undefined, { projectId: "draft-project" });
  const { result, prepareSession, readTree } = fixture();
  await act(async () => {
    await result.current.handleCreateTask();
  });
  expect(prepareSession).toHaveBeenLastCalledWith({ projectId: "draft-project" });
  expect(readTree).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.handleCreateTask({ projectId: null });
  });
  expect(prepareSession).toHaveBeenLastCalledWith({
    draftId: expect.any(String),
    reuseDraft: false,
  });
});

it("D3 discards project lookup after the user selects another session", async () => {
  useZCodeSessionStore.getState().setActiveTaskId("/old", "session");
  const { result, prepareSession, readTree, addTab } = fixture();
  let finish!: (tree: Awaited<ReturnType<typeof readTree>>) => void;
  readTree.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.handleCreateTask();
  });
  act(() => useZCodeSessionStore.getState().setActiveTaskId("/old", "other"));
  await act(async () => {
    finish({ tasks: [{ taskId: "session", workspacePath: "/old", projectId: "current" }] });
    await pending;
  });
  expect(prepareSession).not.toHaveBeenCalled();
  expect(addTab).not.toHaveBeenCalled();
});

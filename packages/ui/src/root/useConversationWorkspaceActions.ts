import { useCallback } from "react";
import { logger } from "@/logger.js";
import type { TabStoreState } from "@/store/tabStore.js";

export function useConversationWorkspaceActions({
  prepareConversationDraft,
  addTab,
  createTask,
  setWorkspaceActionError,
}: {
  prepareConversationDraft: () => Promise<{ workspacePath: string }>;
  addTab: TabStoreState["addTab"];
  createTask: (source: string) => Promise<void>;
  setWorkspaceActionError: (error: string | null) => void;
}) {
  const handleSelectConversationWorkspace = useCallback(
    (path: string) => {
      // 对话工作区是 app 管理的独立 cwd，不属于用户项目：不走跨窗口项目激活，
      // 也不写 recentProjects，只用 purpose 让展示层把它归到“对话”。
      logger.info("[Root] select conversation workspace", { path });
      addTab(path, { workspacePurpose: "conversation" });
      setWorkspaceActionError(null);
    },
    [addTab, setWorkspaceActionError],
  );

  const handleResolveConversationWorkspace = useCallback(async () => {
    try {
      // 菜单与任务加号必须登记同一 draftId，否则首发 ACK 无法消费旧目录引用。
      const result = await prepareConversationDraft();
      setWorkspaceActionError(null);
      return result.workspacePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 用户已切到其他任务时，旧菜单结果只撤销自身，不向新页面投递错误。
      if (message === "project.creation-cancelled") throw error;
      logger.error("[Root] ensure conversation workspace failed", { error });
      setWorkspaceActionError(message);
      throw error;
    }
  }, [prepareConversationDraft, setWorkspaceActionError]);

  const handleEnsureConversationWorkspace = useCallback(async () => {
    const path = await handleResolveConversationWorkspace();
    handleSelectConversationWorkspace(path);
    return path;
  }, [handleResolveConversationWorkspace, handleSelectConversationWorkspace]);

  const handleCreateConversationTask = useCallback(
    () => createTask("task section new task"),
    [createTask],
  );

  return {
    handleSelectConversationWorkspace,
    handleResolveConversationWorkspace,
    handleEnsureConversationWorkspace,
    handleCreateConversationTask,
  };
}

// worktree 创建记录的订阅（docs/git/worktree.md §6.2）。记录只在 Host 内存中，是创建阶段的
// 唯一数据源：这里只镜像 Host 推送的完整列表，不在 renderer 推算阶段或进度。
import { useEffect, useState } from "react";
import type { ManagedWorktreeCreation, ManagedWorktreeCreationSettlement } from "@zcode/shared";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { logger } from "@/logger.js";

const EMPTY: readonly ManagedWorktreeCreation[] = [];

interface WorktreeCreationHostService {
  listCreations(): Promise<ManagedWorktreeCreation[]>;
  onDidChangeCreations(
    listener: (creations: readonly ManagedWorktreeCreation[]) => void,
  ): { dispose(): void };
  onDidSettleCreation(listener: (settlement: ManagedWorktreeCreationSettlement) => void): {
    dispose(): void;
  };
}

/**
 * 创建记录只属于本机 Host（base attachment）。直接读 base services 而不是当前 workspace 的
 * ServiceProvider：远程项目的服务没有 managed-worktrees 频道；渲染壳未注入任何服务时返回 undefined。
 */
function useWorktreeHostService(): WorktreeCreationHostService | undefined {
  return useRemoteWorkspaceSessionStore((state) => state.baseServices)?.managedWorktreeService;
}

export function useManagedWorktreeCreations(): readonly ManagedWorktreeCreation[] {
  const managedWorktreeService = useWorktreeHostService();
  const [creations, setCreations] = useState<readonly ManagedWorktreeCreation[]>(EMPTY);
  useEffect(() => {
    if (!managedWorktreeService) return;
    let disposed = false;
    // 先订阅再读取：读取返回前到达的推送更新，读取结果只在还没收到推送时采用。
    let pushed = false;
    const subscription = managedWorktreeService.onDidChangeCreations((next) => {
      pushed = true;
      if (!disposed) setCreations(next);
    });
    void managedWorktreeService.listCreations().then(
      (initial) => {
        if (!disposed && !pushed) setCreations(initial);
      },
      (error: unknown) => logger.warn("[worktree] 读取创建记录失败", { error }),
    );
    return () => {
      disposed = true;
      subscription.dispose();
    };
  }, [managedWorktreeService]);
  return managedWorktreeService ? creations : EMPTY;
}

/** 订阅创建结束事件；handler 由调用方 memo。 */
export function useManagedWorktreeSettlements(
  handler: (settlement: ManagedWorktreeCreationSettlement) => void,
): void {
  const managedWorktreeService = useWorktreeHostService();
  useEffect(() => {
    if (!managedWorktreeService) return;
    const subscription = managedWorktreeService.onDidSettleCreation(handler);
    return () => subscription.dispose();
  }, [handler, managedWorktreeService]);
}

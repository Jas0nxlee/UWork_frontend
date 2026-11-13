// 会话的 cwd 与所在受管 worktree（docs/git/worktree.md §2.1、§3.7、§3.12）。
// 只读 Host tasks-index 的任务元数据（与会话头部同一数据源）；worktree 任务只在本地出现，
// 远程会话不读取。cwd 缺省为 workspace 目录。
import { useEffect, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

export interface TaskWorktreePlacement {
  cwd: string;
  /** 普通任务为 undefined。 */
  worktreeRoot: string | undefined;
  /** worktree 已被删除时为 false，任务按只读处理；普通任务恒为 true。 */
  worktreeAvailable: boolean;
}

/**
 * worktree 任务的 tasks-index 元数据。只在宿主真的提供 worktree 能力时才查询：
 * 放置信息只服务受管 worktree 任务（仅本地桌面），Web/SSR 与未装配该服务的窗口直接返回 null，
 * 渲染壳因此不需要为布局断言准备 tasks-index 与 Tab store。
 */
function useTaskMetaForPlacement(
  taskId: string | null,
  workspacePath: string,
  enabled: boolean,
): ZCodeTaskMeta | null {
  const services = useOptionalServices();
  const service = enabled ? services?.zcodeTaskService : undefined;
  const broadcastService = services?.broadcastService;
  const [indexed, setIndexed] = useState<{
    key: string;
    meta: ZCodeTaskMeta | null;
  } | null>(null);
  useEffect(() => {
    if (!service || !broadcastService || !taskId) return;
    let disposed = false;
    // 每次读取递增序号，只有最新一次的结果能写入，避免较早的请求晚到后覆盖新结果。
    let serial = 0;
    const target = { workspacePath, taskId };
    const refresh = () => {
      const request = ++serial;
      void service.getTaskMeta(target).then(
        (meta) => {
          if (!disposed && request === serial) setIndexed({ key: taskId, meta });
        },
        (error: unknown) => {
          if (!disposed && request === serial)
            logger.warn("[worktree] 读取任务元数据失败", { ...target, error });
        },
      );
    };
    // 先订阅再读取，避免读取与订阅之间漏掉改名/归档；项目变更同样是权威触发源。
    const events = service.onDynamicWorkspaceEvent(target)((event) => {
      if (event.type === "workspace_task_list_changed") refresh();
    });
    const projects = broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") refresh();
    });
    refresh();
    return () => {
      disposed = true;
      events.dispose();
      projects.dispose();
    };
  }, [broadcastService, service, taskId, workspacePath]);
  return indexed?.key === taskId ? indexed.meta : null;
}

export function useTaskWorktreePlacement({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  sessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string | null | undefined;
}): TaskWorktreePlacement {
  const services = useOptionalServices();
  const managedWorktreeService = services?.managedWorktreeService;
  // Bug 原因：曾从 renderer store 的任务列表缓存读取，新会话与 fork 子任务不在缓存中，
  // cwd 退回 workspace，Git 面板与分叉菜单把 worktree 任务当成普通任务。
  const local = !workspaceIdentity?.trim() && !remoteSessionId;
  // 宿主没有 worktree 能力时按普通任务处理，也不查 tasks-index（见 useTaskMetaForPlacement）。
  const enabled = local && Boolean(managedWorktreeService);
  const meta = useTaskMetaForPlacement(
    enabled ? (sessionId ?? null) : null,
    workspacePath,
    enabled,
  );
  const worktreeRoot = meta?.worktreeRoot;
  const broadcastService = services?.broadcastService;
  const [unavailableRoot, setUnavailableRoot] = useState<string | null>(null);
  useEffect(() => {
    if (!worktreeRoot || !managedWorktreeService || !broadcastService) return;
    let disposed = false;
    // 每次检查递增序号，只有最新一次的结果能写入，避免较早的请求晚到后覆盖新结果。
    let latest = 0;
    const check = () => {
      const request = ++latest;
      void managedWorktreeService.isWorktreeAvailable({ worktreeRoot }).then(
        (available) => {
          if (!disposed && request === latest) setUnavailableRoot(available ? null : worktreeRoot);
        },
        // 查询失败不判定为只读：只读只由确定的"不存在"触发。
        (error: unknown) => logger.warn("[worktree] 读取 worktree 可用性失败", { error }),
      );
    };
    // 修复原因：曾只在 worktreeRoot 变化时查询；删除 worktree 后 worktreeRoot 不变，已打开的任务
    // 输入区仍可写。删除成功后 Host 发布项目变更，以它为唯一触发源重新查询，不轮询（§3.12）。
    const projects = broadcastService.onMessage((event) => {
      if (event.channel === "state:projects") check();
    });
    check();
    return () => {
      disposed = true;
      projects.dispose();
    };
  }, [broadcastService, managedWorktreeService, worktreeRoot]);
  return {
    cwd: meta?.cwd ?? workspacePath,
    worktreeRoot,
    worktreeAvailable: !worktreeRoot || unavailableRoot !== worktreeRoot,
  };
}

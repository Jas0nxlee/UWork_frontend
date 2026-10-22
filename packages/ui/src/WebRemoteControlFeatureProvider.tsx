import { createContext, useContext } from "react";
import type { ReactNode } from "react";
// 发布分支（release/no-mobile-remote-control）不提供手机/浏览器远控：桌面没有入口、
// main 不注册远控 IPC、仓库不再携带手机页。这里保持关闭，让仍与核心布局交织的
// status/workspace-sync 钩子在桌面端保持空闲，不发起 IPC 轮询。
const DEFAULT_WEB_REMOTE_CONTROL_FEATURE_ENABLED = false;

const WebRemoteControlFeatureContext = createContext(
  DEFAULT_WEB_REMOTE_CONTROL_FEATURE_ENABLED,
);

export function WebRemoteControlFeatureProvider({
  enabled = DEFAULT_WEB_REMOTE_CONTROL_FEATURE_ENABLED,
  children,
}: {
  enabled?: boolean;
  children: ReactNode;
}) {
  return (
    <WebRemoteControlFeatureContext.Provider value={enabled}>
      {children}
    </WebRemoteControlFeatureContext.Provider>
  );
}

export function useWebRemoteControlFeatureEnabled(): boolean {
  return useContext(WebRemoteControlFeatureContext);
}

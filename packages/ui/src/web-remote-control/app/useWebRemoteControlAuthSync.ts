import { useEffect, useRef } from "react";
import type {
  WebRemoteControlAuthPlatform,
  WebRemoteControlAuthEvents,
  WebRemoteControlEnterpriseAuthEvents,
} from "@/web-remote-control/contract.js";

/** 初始恢复同步一次投影；运行中消费 OAuth 凭据事件与企业身份 owner 变更。 */
export function useWebRemoteControlAuthSync(
  platform: WebRemoteControlAuthPlatform,
  oauth: WebRemoteControlAuthEvents,
  userId: string | undefined,
  restoring: boolean,
  enterprise?: WebRemoteControlEnterpriseAuthEvents,
): void {
  const initialStateSynced = useRef(false);
  useEffect(() => {
    if (!platform.notifyWebRemoteControlAuthStateChanged || !enterprise) return;
    const subscription = enterprise.onDidChange((view) => {
      // 企业身份事实由Host持有，事件只触发Main复核，不能把UI状态直接作为授权。
      platform.notifyWebRemoteControlAuthStateChanged?.({
        state: view.status === "authenticated" ? "signed-in" : "signed-out",
      });
    });
    return () => subscription.dispose();
  }, [platform, enterprise]);
  useEffect(() => {
    initialStateSynced.current = false;
    if (!platform.notifyWebRemoteControlAuthStateChanged) return;
    const subscription = oauth.onDidChangeSession((state) => {
      // 实时凭据事实优先于迟到的初始 UI 投影；无需在 renderer 保存第二份认证状态。
      initialStateSynced.current = true;
      platform.notifyWebRemoteControlAuthStateChanged?.({ state });
    });
    return () => subscription.dispose();
  }, [platform, oauth]);

  useEffect(() => {
    if (restoring || initialStateSynced.current) return;
    initialStateSynced.current = true;
    platform.notifyWebRemoteControlAuthStateChanged?.({
      state: userId ? "signed-in" : "signed-out",
    });
  }, [platform, oauth, userId, restoring]);
}

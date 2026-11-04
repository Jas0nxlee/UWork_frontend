// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { EnterpriseIdentityView } from "@zcode/shared";
import { useWebRemoteControlAuthSync } from "@/web-remote-control/app/useWebRemoteControlAuthSync.js";

afterEach(cleanup);
it("初始恢复后转发凭据完成事件，不依赖 UI 用户或成功计数更新；卸载取消订阅", () => {
  const session = new Emitter<"signed-in" | "signed-out">();
  const oauth = { onDidChangeSession: session.event };
  const notifyWebRemoteControlAuthStateChanged = vi.fn();
  const platform = { notifyWebRemoteControlAuthStateChanged };
  const { rerender, unmount } = renderHook(
    ({ userId, restoring }) => useWebRemoteControlAuthSync(platform, oauth, userId, restoring),
    {
      initialProps: { userId: "" as string | undefined, restoring: true },
    },
  );
  expect(notifyWebRemoteControlAuthStateChanged).not.toHaveBeenCalled();
  rerender({ userId: "user", restoring: false });
  session.fire("signed-out");
  // 设置后处理失败时 UI 用户仍是 user，完成事件也必须立即送到 Main。
  session.fire("signed-in");
  session.fire("signed-in");
  rerender({ userId: undefined, restoring: false });
  unmount();
  session.fire("signed-out");
  expect(notifyWebRemoteControlAuthStateChanged.mock.calls).toEqual([
    [{ state: "signed-in" }],
    [{ state: "signed-out" }],
    [{ state: "signed-in" }],
    [{ state: "signed-in" }],
  ]);
});

it("没有桌面平台通知能力时不订阅远端 OAuth 事件", () => {
  const onDidChangeSession = vi.fn();
  renderHook(() => useWebRemoteControlAuthSync({}, { onDidChangeSession }, "user", false));
  expect(onDidChangeSession).not.toHaveBeenCalled();
});

it("企业身份owner变更沿现有平台通道通知，续期提示也不由UI决定撤销", () => {
  const changed = new Emitter<EnterpriseIdentityView>();
  const enterprise = { onDidChange: changed.event };
  const notify = vi.fn();
  const platform = { notifyWebRemoteControlAuthStateChanged: notify };
  const oauth = { onDidChangeSession: new Emitter<"signed-in" | "signed-out">().event };
  const { unmount } = renderHook(() =>
    useWebRemoteControlAuthSync(platform, oauth, undefined, true, enterprise),
  );
  const base = {
    revision: 1,
    configured: true,
    error: null,
    organizations: [],
    selectedOrgId: "org-a",
  } as const;
  changed.fire({
    ...base,
    status: "authenticated",
    profile: { id: "user-1", tenantId: "org-a", provider: "wecom", displayName: "User" },
    pending: null,
    organizations: [],
  });
  changed.fire({ ...base, status: "signed-out", profile: null, pending: null, organizations: [] });
  expect(notify.mock.calls).toEqual([[{ state: "signed-in" }], [{ state: "signed-out" }]]);
  unmount();
  changed.fire({ ...base, status: "signed-out", profile: null, pending: null, organizations: [] });
  expect(notify).toHaveBeenCalledTimes(2);
});

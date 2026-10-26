// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";

const fixture = vi.hoisted(() => ({
  status: {} as Record<string, unknown> | null,
  settled: true,
  refresh: vi.fn(),
  toast: vi.fn(),
  platform: {
    openCuaPermissionOnboarding: vi.fn(),
    cancelCuaPermissionOnboarding: vi.fn(),
  },
  services: {
    pluginManagementService: {},
    cuaPermissionService: { getStatus: vi.fn(), restartHelper: vi.fn() },
  },
  plugins: {
    plugins: [{ id: "computer-use@zcode-plugins-official", enabled: true }],
    initialize: vi.fn(),
    setEnabled: vi.fn(),
    togglingPluginId: null,
  },
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: { computerUseComposerEntryHidden: false }, update: vi.fn() }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => fixture.platform }));
vi.mock("@/hooks/useServices.js", () => ({ useServices: () => fixture.services }));
vi.mock("@/hooks/useCuaPermissionStatus.js", () => ({
  useCuaPermissionStatus: () => ({
    status: fixture.status,
    settled: fixture.settled,
    refresh: fixture.refresh,
  }),
}));
vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: (select: (state: typeof fixture.plugins) => unknown) =>
    select(fixture.plugins),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: fixture.toast }));
vi.mock("@/settings/SettingsPageParts.js", () => ({
  SettingsBadge: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  SettingsGroupCard: ({ children }: { children: ReactNode }) =>
    createElement("section", null, children),
  SettingsRow: ({
    label,
    control,
    detail,
  }: {
    label: string;
    control?: ReactNode;
    detail?: ReactNode;
  }) => createElement("div", { "aria-label": label }, control, detail),
}));

const ACCESSIBILITY = "chat.cuaPermission.openAccessibility";
const SCREEN_RECORDING = "chat.cuaPermission.openScreenRecording";
const renderSection = (workspacePath = "/fixture") =>
  render(
    createElement(ComputerUseSection, {
      isDesktop: true,
      isMacDesktop: true,
      workspacePath,
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  fixture.status = {
    grantOwner: "helper",
    accessibility: "denied",
    screenRecording: "denied",
  };
  fixture.settled = true;
  // 状态在查询期间发生变化，不能抹掉用户打开面板的明确意图。
  fixture.services.cuaPermissionService.getStatus.mockResolvedValue({
    grantOwner: "helper",
    accessibility: "granted",
    screenRecording: "granted",
  });
  fixture.platform.openCuaPermissionOnboarding.mockImplementation(() => new Promise(() => {}));
});
afterEach(cleanup);

describe("explicit Computer Use settings navigation", () => {
  it("旧展示未授权、可读状态已授权时仍打开所选面板，点击不前置查询状态", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: ACCESSIBILITY }));
    await waitFor(() =>
      expect(fixture.platform.openCuaPermissionOnboarding).toHaveBeenCalledTimes(1),
    );
    expect(fixture.platform.openCuaPermissionOnboarding).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPermission: "accessibility",
        requiredPermissions: ["accessibility"],
      }),
    );
    expect(fixture.services.cuaPermissionService.getStatus).not.toHaveBeenCalled();
    expect(fixture.toast).not.toHaveBeenCalled();
  });

  it("检查尚未完成时按钮仍可点击且立即提交导航", async () => {
    fixture.status = null;
    fixture.settled = false;
    fixture.services.cuaPermissionService.getStatus.mockImplementation(() => new Promise(() => {}));
    renderSection();
    const button = screen.getByRole("button", { name: ACCESSIBILITY }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(fixture.platform.openCuaPermissionOnboarding).toHaveBeenCalledTimes(1),
    );
    expect(fixture.services.cuaPermissionService.getStatus).not.toHaveBeenCalled();
  });

  it("已授权时两个精确设置入口仍存在", async () => {
    fixture.status = { grantOwner: "helper", accessibility: "granted", screenRecording: "granted" };
    renderSection();
    expect(screen.getByRole("button", { name: ACCESSIBILITY })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: SCREEN_RECORDING }));
    await waitFor(() =>
      expect(fixture.platform.openCuaPermissionOnboarding).toHaveBeenCalledTimes(1),
    );
    expect(fixture.platform.openCuaPermissionOnboarding).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialPermission: "screen_recording",
        requiredPermissions: ["screen_recording"],
      }),
    );
  });

  it("连续切换按钮先取消旧 participant；旧成功晚回不获得恢复权", async () => {
    fixture.services.cuaPermissionService.getStatus.mockResolvedValue(fixture.status);
    let finishOld!: (value: unknown) => void;
    fixture.platform.openCuaPermissionOnboarding.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: ACCESSIBILITY }));
    await waitFor(() =>
      expect(fixture.platform.openCuaPermissionOnboarding).toHaveBeenCalledTimes(1),
    );
    const oldId = fixture.platform.openCuaPermissionOnboarding.mock.calls[0]![0].operationId;
    fireEvent.click(screen.getByRole("button", { name: SCREEN_RECORDING }));
    await waitFor(() =>
      expect(fixture.platform.openCuaPermissionOnboarding).toHaveBeenCalledTimes(2),
    );
    expect(fixture.platform.cancelCuaPermissionOnboarding).toHaveBeenCalledWith(oldId);
    expect(fixture.platform.cancelCuaPermissionOnboarding.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.platform.openCuaPermissionOnboarding.mock.invocationCallOrder[1]!,
    );
    expect(fixture.platform.openCuaPermissionOnboarding.mock.calls[1]![0]).toMatchObject({
      initialPermission: "screen_recording",
      requiredPermissions: ["screen_recording"],
    });
    expect(fixture.platform.openCuaPermissionOnboarding.mock.calls[1]![0].operationId).not.toBe(
      oldId,
    );
    await act(async () =>
      finishOld({
        success: true,
        returnedFromSettings: true,
        restartHelperAfterReturn: true,
        sessionId: "old",
      }),
    );
    expect(fixture.services.cuaPermissionService.restartHelper).not.toHaveBeenCalled();
  });

  it("离开设置仍取消当前 participant，晚回不恢复Helper", async () => {
    fixture.services.cuaPermissionService.getStatus.mockResolvedValue(fixture.status);
    let finish!: (value: unknown) => void;
    fixture.platform.openCuaPermissionOnboarding.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderSection();
    fireEvent.click(screen.getByRole("button", { name: ACCESSIBILITY }));
    await waitFor(() =>
      expect(fixture.platform.openCuaPermissionOnboarding).toHaveBeenCalledTimes(1),
    );
    const id = fixture.platform.openCuaPermissionOnboarding.mock.calls[0]![0].operationId;
    view.unmount();
    expect(fixture.platform.cancelCuaPermissionOnboarding).toHaveBeenCalledWith(id);
    await act(async () =>
      finish({
        success: true,
        returnedFromSettings: true,
        restartHelperAfterReturn: true,
        sessionId: "closed",
      }),
    );
    expect(fixture.services.cuaPermissionService.restartHelper).not.toHaveBeenCalled();
  });

  it("切换workspace退出旧participant，旧结果不能恢复新工作区Helper", async () => {
    let finish!: (value: unknown) => void;
    fixture.platform.openCuaPermissionOnboarding.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderSection("/workspace-a");
    fireEvent.click(screen.getByRole("button", { name: ACCESSIBILITY }));
    await waitFor(() =>
      expect(fixture.platform.openCuaPermissionOnboarding).toHaveBeenCalledTimes(1),
    );
    const id = fixture.platform.openCuaPermissionOnboarding.mock.calls[0]![0].operationId;
    view.rerender(
      createElement(ComputerUseSection, {
        isDesktop: true,
        isMacDesktop: true,
        workspacePath: "/workspace-b",
      }),
    );
    expect(fixture.platform.cancelCuaPermissionOnboarding).toHaveBeenCalledWith(id);
    await act(async () =>
      finish({
        success: true,
        returnedFromSettings: true,
        restartHelperAfterReturn: true,
        sessionId: "workspace-a",
      }),
    );
    expect(fixture.services.cuaPermissionService.restartHelper).not.toHaveBeenCalled();
    expect(fixture.toast).not.toHaveBeenCalled();
  });
});

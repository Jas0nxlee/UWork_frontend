// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";

vi.mock("@/WorkspaceWebRemoteControlTrigger.js", () => ({
  WorkspaceWebRemoteControlTrigger: () => createElement("button", { "data-testid": "wrc-trigger" }),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) =>
    createElement("span", null, children),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    executeDesktopCommand: vi.fn(),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    openExternal: vi.fn(),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: { isRestoringOAuthSession: boolean }) => unknown) =>
    selector({ isRestoringOAuthSession: false }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: {}, update: vi.fn() }),
}));

// 抽屉菜单在浏览器里走 portal；测试里内联渲染，才能断言条目与点击。
vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { role: "menu" }, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: {
    children: ReactNode;
    onSelect?: () => void;
    [key: string]: unknown;
  }) => createElement("div", { ...props, onClick: onSelect }, children),
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuSub: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) =>
    createElement("span", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

afterEach(cleanup);

function renderFooter(onSettingsButtonClick?: () => void): void {
  render(
    createElement(WorkspaceSidebarFooter, {
      theme: "dark",
      localeMenuValue: "zh-CN",
      onLocaleChange: () => {},
      onThemeChange: () => {},
      onSettingsButtonClick,
    } as never),
  );
}

describe("左下角偏好菜单里的「应用设置」", () => {
  it("点它直接进全部设置（与右侧齿轮同一个动作）", () => {
    const openSettings = vi.fn();
    renderFooter(openSettings);
    const item = screen.getByTestId("preferences-menu-app-settings");
    expect(item.textContent).toContain("sidebar.settings.appSettings");
    fireEvent.click(item);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("没有设置入口时禁用，避免点了没反应", () => {
    renderFooter(undefined);
    expect(
      screen.getByTestId("preferences-menu-app-settings").getAttribute("disabled"),
    ).not.toBeNull();
  });
});

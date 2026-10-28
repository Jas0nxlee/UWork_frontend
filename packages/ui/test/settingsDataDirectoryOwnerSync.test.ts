// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DataBaseDirControl } from "@/settings/DataBaseDirControl.js";
import {
  TID_SETTINGS_DATA_BASE_DIR_BROWSE,
  TID_SETTINGS_DATA_BASE_DIR_INPUT,
  TID_SETTINGS_DATA_BASE_DIR_SAVE,
  TID_SETTINGS_DATA_BASE_DIR_STATUS,
} from "@zcode/shared/test-ids";
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
afterEach(cleanup);
const pending = (targetBaseDir: string) => ({
  requestId: "12345678-1234-4234-8234-123456789012",
  sourceBaseDir: "/active",
  targetBaseDir,
  resetToDefault: false,
});
const value = () =>
  (screen.getByTestId(TID_SETTINGS_DATA_BASE_DIR_INPUT) as HTMLInputElement).value;

it("a saved window follows another window's new pending request and cancellation", async () => {
  const props = {
    dataBaseDir: "/active",
    defaultHomeDir: "/home",
    onSelectDataBaseDir: vi.fn(async () => "/first"),
    onDataBaseDirChange: vi.fn(async () => {}),
  };
  const view = render(createElement(DataBaseDirControl, props));
  fireEvent.click(screen.getByTestId(TID_SETTINGS_DATA_BASE_DIR_BROWSE));
  await waitFor(() => expect(value()).toBe("/first"));
  fireEvent.click(screen.getByTestId(TID_SETTINGS_DATA_BASE_DIR_SAVE));
  await waitFor(() =>
    expect(screen.getByTestId(TID_SETTINGS_DATA_BASE_DIR_STATUS).dataset.state).toBe("saved"),
  );
  view.rerender(
    createElement(DataBaseDirControl, { ...props, pendingMigration: pending("/second") }),
  );
  await waitFor(() => expect(value()).toBe("/second"));
  view.rerender(createElement(DataBaseDirControl, props));
  await waitFor(() => expect(value()).toBe("/active"));
  expect(screen.queryByTestId(TID_SETTINGS_DATA_BASE_DIR_STATUS)).toBeNull();
});

it("a late submission failure cannot replace a newer owner projection", async () => {
  let rejectSave!: (error: Error) => void;
  const props = {
    dataBaseDir: "/active",
    defaultHomeDir: "/home",
    onSelectDataBaseDir: vi.fn(async () => "/first"),
    onDataBaseDirChange: () =>
      new Promise<void>((_, reject) => {
        rejectSave = reject;
      }),
  };
  const view = render(createElement(DataBaseDirControl, props));
  fireEvent.click(screen.getByTestId(TID_SETTINGS_DATA_BASE_DIR_BROWSE));
  await waitFor(() => expect(value()).toBe("/first"));
  fireEvent.click(screen.getByTestId(TID_SETTINGS_DATA_BASE_DIR_SAVE));
  view.rerender(
    createElement(DataBaseDirControl, { ...props, pendingMigration: pending("/second") }),
  );
  await act(async () => rejectSave(new Error("late old request")));
  expect(value()).toBe("/second");
  expect(screen.getByTestId(TID_SETTINGS_DATA_BASE_DIR_STATUS).dataset.state).toBe("saved");
});

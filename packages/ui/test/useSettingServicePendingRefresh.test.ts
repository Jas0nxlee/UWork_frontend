// @vitest-environment jsdom
import { createElement, useEffect } from "react";
import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AppSettings } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
const callbacks = vi.hoisted(() => new Set<() => void>());
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    onSettingsChanged: (callback: () => void) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
  }),
}));
function Probe({ onChange }: { onChange: (value: string | null) => void }) {
  const { settings } = useSettings();
  useEffect(() => {
    onChange(settings?.pendingDataDirectoryMigration?.targetBaseDir ?? null);
  }, [settings, onChange]);
  return null;
}
it("a post-commit settings notification cannot reuse an older in-flight read", async () => {
  let finishInitial!: (settings: AppSettings) => void;
  const initial = new Promise<AppSettings>((resolve) => {
    finishInitial = resolve;
  });
  const updated = {
    pendingDataDirectoryMigration: {
      requestId: "12345678-1234-4234-8234-123456789012",
      sourceBaseDir: "/active",
      targetBaseDir: "/pending",
      resetToDefault: false,
    },
  } as AppSettings;
  const get = vi
    .fn()
    .mockImplementationOnce(() => initial)
    .mockResolvedValue(updated);
  const services = {
    settingService: { get, update: vi.fn() },
    botsService: {},
    zcodeAgentService: {},
    broadcastService: {},
  } as never;
  let target: string | null = null;
  const view = render(
    createElement(
      ServiceProvider,
      { services },
      createElement(Probe, {
        onChange: (value) => {
          target = value;
        },
      }),
    ),
  );
  try {
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    callbacks.forEach((callback) => callback());
    finishInitial({} as AppSettings);
    await waitFor(() => expect(target).toBe("/pending"));
    expect(get).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    callbacks.clear();
  }
});

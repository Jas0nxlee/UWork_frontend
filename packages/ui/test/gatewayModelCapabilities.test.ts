// @vitest-environment jsdom
import { createElement } from "react";
import { render, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UcasGatewayView } from "@zcode/shared";
import type { UcasGatewayController } from "@/hooks/useUcasGateway.js";
import { ModelsSection } from "@/settings/ucas-gateway/GatewayCards.js";

describe("gateway capability refresh", () => {
  it("allows refreshing existing model capabilities without adding members, and blocks duplicate clicks", () => {
    const view: UcasGatewayView = {
      revision: 1,
      status: "ready",
      configured: true,
      user: null,
      endpoint: null,
      key: null,
      subscriptions: [],
      usage: null,
      lastSyncedAt: null,
      error: null,
      models: {
        available: ["model-a"],
        appliedCount: 1,
        pendingCount: 0,
        unrestricted: false,
        hasSubscription: true,
      },
    };
    const gateway: UcasGatewayController = {
      available: true,
      view,
      busy: false,
      period: "month",
      metric: "requests",
      sync: vi.fn(async () => null),
      setPeriod: vi.fn(),
      setMetric: vi.fn(),
      refreshUsage: vi.fn(async () => {}),
      refreshModels: vi.fn(async () => {}),
      applyModels: vi.fn(async () => {}),
      replaceApiKey: vi.fn(async () => {}),
    };
    const props = { gateway, view, t: (id: string) => id };
    const rendered = render(createElement(ModelsSection, props));
    const button = rendered.getByTestId("ucas-gateway-apply-models") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(gateway.applyModels).toHaveBeenCalledTimes(1);
    rendered.rerender(
      createElement(ModelsSection, { ...props, gateway: { ...gateway, busy: true } }),
    );
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(gateway.applyModels).toHaveBeenCalledTimes(1);
  });
});

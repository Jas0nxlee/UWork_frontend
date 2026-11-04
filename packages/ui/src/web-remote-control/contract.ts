import type { IOAuthService, IEnterpriseIdentityService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

export type WebRemoteControlDeviceNavigation = NonNullable<
  WebRemoteControlWorkspaceSwitcherApi["deviceNavigation"]
>;
export type WebRemoteControlAuthPlatform = Pick<
  IPlatformService,
  "notifyWebRemoteControlAuthStateChanged"
>;
export type WebRemoteControlAuthEvents = Pick<IOAuthService, "onDidChangeSession">;
export type WebRemoteControlEnterpriseAuthEvents = Pick<IEnterpriseIdentityService, "onDidChange">;
export type { WebRemoteControlMobileTaskView } from "@zcode/shared";
export type WebRemoteControlTaskViewSwitcher = Pick<
  WebRemoteControlWorkspaceSwitcherApi,
  "updateMobileTaskView" | "updateMobileViewState"
>;

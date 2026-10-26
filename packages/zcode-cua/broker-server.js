import { writeFile } from "node:fs/promises";
import { CuaHelperError } from "./broker.js";
export {
  buildHelperOpenArgs,
  resolveHelperPermissionSubjectIdentity,
  isCuaLocalDevelopmentRuntime,
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
  resolveHelperAppName,
  resolveCuaHelperInstallRoot,
  standaloneHelperCandidatePaths,
} from "./helper-installer.js";
export { createProductCuaHelperHost } from "./helper-host.js";
export const HELPER_ADDON_ENV = "ZCODE_CUA_HELPER_ADDON";
export const WINDOWS_DEV_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";
const unavailableHosts = new WeakSet();
const missingFeature = () => {
  throw new CuaHelperError("The legacy native addon API is not available in this runtime", {
    code: "unsupported",
  });
};

export function cuaBrokerRefreshMarkerPath(socketPath) {
  return `${socketPath}.refresh`;
}
export async function publishCuaBrokerRefreshMarker(socketPath, options = {}) {
  const path = cuaBrokerRefreshMarkerPath(socketPath);
  await writeFile(
    path,
    JSON.stringify({ deadline: (options.now?.() ?? Date.now()) + (options.deadlineMs ?? 15000) }),
    { mode: 0o600 },
  );
  return { path };
}

export const loadRealNativeAddon = missingFeature;
export const resolvePackagedNativeAddonPath = () => undefined;
export const resolveInTreeAddonPath = () => undefined;
export const createAxReadOnlyMethods = missingFeature;
export const ROLE_TO_KIND = Object.freeze({});
export const roleToKind = () => undefined;

export class CuaHelperLifecycleManager {
  #dispose;
  #current;
  #disposed = false;
  #queue = Promise.resolve();
  constructor(dispose) {
    this.#dispose = dispose;
  }
  acquire(options) {
    const operation = this.#queue.then(async () => {
      if (this.#disposed || options.isAdmitted?.() === false) return undefined;
      if (this.#current !== undefined && (options.shouldRetainCurrent?.(this.#current) ?? true))
        return this.#current;
      if (this.#current !== undefined) await this.#dispose?.(this.#current);
      if (this.#disposed || options.isAdmitted?.() === false) return undefined;
      this.#current = options.create();
      return this.#current;
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
  peek() {
    return this.#current;
  }
  get disposed() {
    return this.#disposed;
  }
  async dispose(managed) {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#queue;
    const target = managed ?? this.#current;
    this.#current = undefined;
    if (target !== undefined) await this.#dispose?.(target);
  }
}

export class CuaProductHelperWorkspaceRegistry {
  #enabled = new Set();
  setEnabled(context, enabled) {
    const key = context?.workspaceIdentity?.trim() || context?.workspacePath;
    if (key) {
      if (enabled) this.#enabled.add(key);
      else this.#enabled.delete(key);
    }
  }
}

export function isOfficialCuaPluginEnabledForWorkspace(options = {}) {
  const env = options.env ?? process.env;
  return /^(1|true|on)$/iu.test(env.ZCODE_CUA_PRODUCT_HELPER ?? env.ZCODE_CUA_DEV_MODE ?? "");
}

export function createCuaProductMcpServerResolver(host) {
  let restart;
  const completedPermissionSessions = new Set();
  const pendingPermissionSessions = new Set();
  const runRestart = (sessionId) => {
    if (sessionId && completedPermissionSessions.has(sessionId)) return Promise.resolve();
    if (sessionId) pendingPermissionSessions.add(sessionId);
    if (restart) return restart;
    restart = (async () => {
      if (host.restartAfterCurrentStartPreservingTransport)
        await host.restartAfterCurrentStartPreservingTransport();
      else await host.restartAfterCurrentStart();
      for (const pending of pendingPermissionSessions) {
        completedPermissionSessions.add(pending);
        if (completedPermissionSessions.size > 64)
          completedPermissionSessions.delete(completedPermissionSessions.values().next().value);
      }
    })().finally(() => {
      pendingPermissionSessions.clear();
      restart = undefined;
    });
    return restart;
  };
  return {
    async resolveMcpServers(servers) {
      return servers;
    },
    restart: () => runRestart(),
    restartAfterPermissionGrant: (sessionId) => runRestart(sessionId),
  };
}

export async function waitForCuaHelperStartup(startup, deadlineMs) {
  if (deadlineMs === undefined) return startup;
  let timer;
  try {
    return await Promise.race([
      startup,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new CuaHelperError("Computer Use Helper startup timed out")),
          Math.max(1, deadlineMs),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function isPotentialZCodeCuaAgentMcpServer(server) {
  return Boolean(
    server &&
    typeof server === "object" &&
    (server.name === "plugin:computer-use:computer-use" ||
      server.env?.ZCODE_PLUGIN_ID === "computer-use@zcode-plugins-official"),
  );
}
export function isScreenCaptureProbeSuccess(probe) {
  return probe?.ok === true;
}
export function markCuaProductHelperAgentEnvUnavailable(host) {
  unavailableHosts.add(host);
}
export function hasCuaProductHelperAgentEnvUnavailable(host) {
  return unavailableHosts.has(host);
}
export function clearCuaProductHelperAgentEnvUnavailable(host) {
  unavailableHosts.delete(host);
}
export async function reapOrphanedHelpers() {
  /* 不按进程名称杀进程；正常退出由经过 authority 认证的 Host.stop 所有。 */
}
export async function requestHelperAccessibilityPermissionViaLaunchServices() {
  return { ok: false, reason: "Use the desktop permission onboarding for the verified Helper app" };
}
export async function requestHelperScreenRecordingPermissionViaLaunchServices() {
  return { ok: false, reason: "Use the desktop permission onboarding for the verified Helper app" };
}
export function injectPermissionBrokerAgentMcpServers(servers) {
  return servers;
}

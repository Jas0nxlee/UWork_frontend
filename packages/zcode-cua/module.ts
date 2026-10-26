/**
 * cua-runtime 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cuaRuntimeModule = {
  id: "cua-runtime",
  requires: ["shared"],
  provides: ["cua-runtime"],
  publicEntrypoints: [
    "index.js",
    "broker.js",
    "broker-server.js",
    "broker-ports.js",
    "broker-helper-health.js",
    "broker-helper-constants.js",
    "broker-socket-path.js",
    "frame-contract.js",
    "host-display-contract.js",
    "pip-session.js",
    "pip-session-node.js",
    "request-access-contract.js",
    "lazy-broker.js",
    "contract.ts",
  ],
} as const;

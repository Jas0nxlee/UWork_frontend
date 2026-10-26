import type { ComputerUseRuntime } from "./index.js";

/**
 * 原生输入和观察只由独立 Helper 所有；客户端仅转发已认证命令。
 * execute 在 Helper 单队列 admission，按 workspace/remote/session 隔离；
 * closeSession 幂等释放该会话，dispose 幂等释放当前客户端。
 * 权限状态查询不触发系统权限弹窗或抓屏；系统授权由用户完成。
 */
export type CuaRuntimeContract = ComputerUseRuntime;

export type {
  ComputerUseRuntime,
  ComputerUseRuntimeContext,
  ComputerUseRuntimeExecuteInput,
  ComputerUseRuntimeOptions,
} from "./index.js";

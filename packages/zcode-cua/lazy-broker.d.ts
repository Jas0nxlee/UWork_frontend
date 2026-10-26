import type { ComputerUseRuntimeContext } from "./index.js";
import type { CuaHelperTransportHandle } from "./broker-server.js";

export interface LazyCuaBroker {
  readonly socketPath: string;
  readonly pluginAuthority: string;
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

/** 不加载驱动。只有 execute 通过鉴权与上下文检查后才调用 resolveTransport。 */
export declare function createLazyCuaBroker(options: {
  resolveTransport(context: ComputerUseRuntimeContext): Promise<CuaHelperTransportHandle>;
}): LazyCuaBroker;

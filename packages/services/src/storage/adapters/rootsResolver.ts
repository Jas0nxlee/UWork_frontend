/**
 * 数据根解析：R1 = 家目录下的 .uwork（永远存在），R2 = 自定义数据存储路径下的 .uwork（仅当设置了且 ≠ 家目录）。
 * 路径来源由调用方注入（desktop host 传 homedir 与 getDataBaseDir），模块内不读环境变量。
 */
import { join, resolve } from "node:path";
import type { RootsResolverPort } from "../app/ports.js";
import type { StorageRootSpec } from "@zcode/shared";

// 旧常量错误地把上游目录纳入扫描和清理；按 UWork 独立数据根合同只解析 .uwork。
export const ZCODE_DATA_DIR_NAME = ".uwork";

export function resolveStorageRoots(params: {
  homeDir: string;
  dataBaseDir: string;
}): StorageRootSpec[] {
  const home = resolve(params.homeDir);
  const dataBase = resolve(params.dataBaseDir);
  const hasCustomDataBaseDir = dataBase !== home;
  const roots: StorageRootSpec[] = [
    { id: "home", path: join(home, ZCODE_DATA_DIR_NAME), hasCustomDataBaseDir },
  ];
  if (hasCustomDataBaseDir) {
    roots.push({
      id: "dataBaseDir",
      path: join(dataBase, ZCODE_DATA_DIR_NAME),
      hasCustomDataBaseDir,
    });
  }
  return roots;
}

export function createStorageRootsResolver(params: {
  getHomeDir: () => string;
  getDataBaseDir: () => string;
}): RootsResolverPort {
  return {
    resolveRoots: async () =>
      resolveStorageRoots({ homeDir: params.getHomeDir(), dataBaseDir: params.getDataBaseDir() }),
  };
}

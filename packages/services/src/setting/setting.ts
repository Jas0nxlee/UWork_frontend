import type { AppSettings } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** Host 私有装配端口：只读取本机已提交目录，禁止递归读取设置或网络。 */
export type WorkspaceSettingsProjection = Pick<
  AppSettings,
  "lastActiveWorkspace" | "lastWorkspaceSession" | "recentProjects" | "lastActiveTabIndex"
>;

export interface ISettingService {
  get(): Promise<AppSettings>;
  getDataDirectoryInfo(): Promise<{ activeBaseDir: string; defaultBaseDir: string }>;
  /** 完整连接映射写入必须传入原快照和操作版本；服务在锁内比较并递增版本。 */
  update(
    patch: Partial<AppSettings>,
    expectedAccountSettings?: Pick<
      AppSettings,
      | "providerFamilyDomain"
      | "providerFamilyConnectionSelections"
      | "providerFamilyDomainUpdatedAt"
    >,
  ): Promise<void>;
  /** 记录/取消下次启动执行的迁移请求；运行时活动目录不变，文件复制由冷启动所有者执行。 */
  updateDataBaseDir(newDir: string | undefined): Promise<void>;
}

export const ISettingService = createServiceDescriptor<ISettingService>(ServiceChannels.Setting);

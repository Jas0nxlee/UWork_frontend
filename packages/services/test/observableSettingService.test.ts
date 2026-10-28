import { describe, expect, it, vi } from "vitest";
import type { ISettingService } from "../src/setting/setting.js";
import { createObservableSettingService } from "../src/setting/observableSettingService.js";

function createBaseSettingService(update: ISettingService["update"]): ISettingService {
  return {
    get: vi.fn(),
    getDataDirectoryInfo:vi.fn(async()=>({activeBaseDir:"/active",defaultBaseDir:"/default"})),
    update,
    updateDataBaseDir: vi.fn(),
  };
}

describe("Observable Setting Service", () => {
  it("冷迁移请求/取消只发布pending字段，失败不发布或伪造活动根变化", async () => {
    const base = createBaseSettingService(vi.fn());
    const service = createObservableSettingService(base);
    const events: string[][] = [];
    service.onDidUpdate((event) => events.push([...event.keys]));
    await service.updateDataBaseDir("/next");
    await service.updateDataBaseDir(undefined);
    expect(events).toEqual([["pendingDataDirectoryMigration"], ["pendingDataDirectoryMigration"]]);
    vi.mocked(base.updateDataBaseDir).mockRejectedValueOnce(new Error("request denied"));
    await expect(service.updateDataBaseDir("/bad")).rejects.toThrow("request denied");
    expect(events).toHaveLength(2);
    expect(base.update).not.toHaveBeenCalled();
  });
  it("底层更新成功后发布字段，失败时不发布", async () => {
    const update = vi.fn(async () => undefined);
    const service = createObservableSettingService(createBaseSettingService(update));
    const events: string[][] = [];
    service.onDidUpdate((event) => events.push([...event.keys]));

    await service.update({
      providerFamilyDomain: "zai",
      modelProviderFamilyModes: { zai: "oauth" },
    });
    expect(events).toEqual([["providerFamilyDomain", "modelProviderFamilyModes"]]);

    update.mockRejectedValueOnce(new Error("write failed"));
    await expect(service.update({ providerFamilyDomain: "bigmodel" })).rejects.toThrow(
      "write failed",
    );
    expect(events).toHaveLength(1);
  });
});

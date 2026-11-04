import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseMobileRemoteControlConfig,
  readMobileRemoteControlConfigSync,
  resolveMobileRemoteControlConfigFilePath,
  resolveMobileRemoteControlOverrides,
} from "../src/main/desktopMobileRemoteControlConfig.js";

const directories: string[] = [];

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "mobile-remote-config-"));
  directories.push(directory);
  return directory;
}

function writeConfig(root: string, content: unknown, options?: { appPath?: string }): string {
  const appPath = options?.appPath ?? join(root, "packages", "desktop");
  const filePath = join(root, "config", "mobile-remote-control.json");
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return appPath;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("mobile remote control config path", () => {
  it("打包态读 resources/config，开发态读仓库根 config（appPath 是 packages/desktop）", () => {
    expect(
      resolveMobileRemoteControlConfigFilePath({
        isPackaged: true,
        resourcesPath: "/Applications/UWork.app/Contents/Resources",
        appPath: "/Applications/UWork.app/Contents/Resources/app.asar",
      }),
    ).toBe("/Applications/UWork.app/Contents/Resources/config/mobile-remote-control.json");

    expect(
      resolveMobileRemoteControlConfigFilePath({
        isPackaged: false,
        resourcesPath: "/unused",
        appPath: "/repo/packages/desktop",
      }),
    ).toBe("/repo/config/mobile-remote-control.json");
  });
});

describe("mobile remote control config 校验", () => {
  it("接受 https 子路径 + wss，并去掉页地址尾部斜杠（二维码要往后面拼 query）", () => {
    expect(
      parseMobileRemoteControlConfig({
        remotePageBaseUrl: "https://aihub.ucas.com.cn/remote/v4/",
        relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
      }),
    ).toEqual({
      remotePageBaseUrl: "https://aihub.ucas.com.cn/remote/v4",
      relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
    });
  });

  it("拒绝明文 http/ws（本机调试除外）", () => {
    expect(
      parseMobileRemoteControlConfig({
        remotePageBaseUrl: "http://aihub.ucas.com.cn/remote/v4",
        relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
      }),
    ).toBeNull();
    expect(
      parseMobileRemoteControlConfig({
        remotePageBaseUrl: "https://aihub.ucas.com.cn/remote/v4",
        relayWsUrl: "ws://aihub.ucas.com.cn/remote/ws",
      }),
    ).toBeNull();
  });

  it("本机调试地址放行", () => {
    expect(
      parseMobileRemoteControlConfig({
        remotePageBaseUrl: "http://127.0.0.1:5173/remote/v4",
        relayWsUrl: "ws://127.0.0.1:18002/remote/ws",
      }),
    ).not.toBeNull();
  });

  it("拒绝根路径页地址（二维码拼出来没法路由）与带 query/hash 的地址", () => {
    expect(
      parseMobileRemoteControlConfig({
        remotePageBaseUrl: "https://aihub.ucas.com.cn",
        relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
      }),
    ).toBeNull();
    expect(
      parseMobileRemoteControlConfig({
        remotePageBaseUrl: "https://aihub.ucas.com.cn/remote/v4?x=1",
        relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
      }),
    ).toBeNull();
    expect(
      parseMobileRemoteControlConfig({
        remotePageBaseUrl: "https://aihub.ucas.com.cn/remote/v4",
        relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws#frag",
      }),
    ).toBeNull();
  });

  it("缺字段/非对象一律拒绝", () => {
    expect(parseMobileRemoteControlConfig(null)).toBeNull();
    expect(parseMobileRemoteControlConfig([])).toBeNull();
    expect(
      parseMobileRemoteControlConfig({ remotePageBaseUrl: "https://a.example/remote/v4" }),
    ).toBeNull();
  });
});

describe("mobile remote control config 读取", () => {
  it("读到并解析成功", () => {
    const root = temporaryRoot();
    const appPath = writeConfig(root, {
      remotePageBaseUrl: "https://aihub.ucas.com.cn/remote/v4",
      relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
    });
    expect(
      readMobileRemoteControlConfigSync({
        isPackaged: false,
        resourcesPath: "/unused",
        appPath,
      }),
    ).toEqual({
      remotePageBaseUrl: "https://aihub.ucas.com.cn/remote/v4",
      relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
    });
  });

  it("文件缺失 → null（保持既有默认，不让远控因为配置缺失而不可用）", () => {
    const root = temporaryRoot();
    expect(
      readMobileRemoteControlConfigSync({
        isPackaged: false,
        resourcesPath: "/unused",
        appPath: join(root, "packages", "desktop"),
      }),
    ).toBeNull();
  });

  it("坏 JSON / 不合法值 → null 并告警，不抛异常", () => {
    const warnings: string[] = [];
    const root = temporaryRoot();
    const appPath = writeConfig(root, "{ 这不是 JSON");
    expect(
      readMobileRemoteControlConfigSync({
        isPackaged: false,
        resourcesPath: "/unused",
        appPath,
        warn: (message) => warnings.push(message),
      }),
    ).toBeNull();
    expect(warnings.length).toBe(1);

    const invalidRoot = temporaryRoot();
    const invalidAppPath = writeConfig(invalidRoot, {
      remotePageBaseUrl: "https://aihub.ucas.com.cn",
      relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
    });
    expect(
      readMobileRemoteControlConfigSync({
        isPackaged: false,
        resourcesPath: "/unused",
        appPath: invalidAppPath,
        warn: (message) => warnings.push(message),
      }),
    ).toBeNull();
    expect(warnings.length).toBe(2);
  });
});

describe("仓库内随包默认配置", () => {
  it("config/mobile-remote-control.json 指向自建入口（部署值被改坏时这条会红）", () => {
    const config = readMobileRemoteControlConfigSync({
      isPackaged: false,
      resourcesPath: "/unused",
      // 与 dev 下 app.getAppPath() 的取值一致：仓库 packages/desktop
      appPath: join(process.cwd(), "packages", "desktop"),
    });

    expect(config).toEqual({
      remotePageBaseUrl: "https://pivot.ucas.com.cn:23090/remote/v4",
      relayWsUrl: "wss://pivot.ucas.com.cn:23090/remote/ws",
      enterpriseAuth: {
        apiBaseUrl: "https://pivot.ucas.com.cn:23090",
        allowSameOrgAnyUser: false,
        backend: "uwork",
      },
    });
  });

  it("随包配置的企业身份：页面、设备接口、身份校验同源走 pivot（后台经代理）", () => {
    const config = readMobileRemoteControlConfigSync({
      isPackaged: false,
      resourcesPath: "/unused",
      appPath: join(process.cwd(), "packages", "desktop"),
    });
    expect(config.enterpriseAuth).toEqual({
      apiBaseUrl: "https://pivot.ucas.com.cn:23090",
      allowSameOrgAnyUser: false,
      backend: "uwork",
    });
  });
});

describe("入口覆盖优先级", () => {
  const config = {
    remotePageBaseUrl: "https://aihub.ucas.com.cn/remote/v4",
    relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
  };

  it("有随包配置时用配置（两个地址一起给，不会只换一半）", () => {
    expect(resolveMobileRemoteControlOverrides({ config })).toEqual(config);
  });

  it("环境变量优先于随包配置（调试覆盖）", () => {
    expect(
      resolveMobileRemoteControlOverrides({
        config,
        envRelayWsUrl: "wss://127.0.0.1:18002/remote/ws",
        envRemotePageBaseUrl: "http://localhost:5173/remote/v4",
      }),
    ).toEqual({
      relayWsUrl: "wss://127.0.0.1:18002/remote/ws",
      remotePageBaseUrl: "http://localhost:5173/remote/v4",
    });
  });

  it("没有配置也没有 env → 不覆盖（沿用 ZCode 侧默认推导）", () => {
    expect(resolveMobileRemoteControlOverrides({ config: null })).toEqual({});
    expect(resolveMobileRemoteControlOverrides({ config: null, envRelayWsUrl: "  " })).toEqual({});
  });
});

describe("打包布局读取", () => {
  it("打包态从 resources/config 读到值（安装包里就是这个形状）", () => {
    const resources = temporaryRoot();
    mkdirSync(join(resources, "config"), { recursive: true });
    writeFileSync(
      join(resources, "config", "mobile-remote-control.json"),
      JSON.stringify({
        remotePageBaseUrl: "https://aihub.ucas.com.cn/remote/v4",
        relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
      }),
    );

    expect(
      readMobileRemoteControlConfigSync({
        isPackaged: true,
        resourcesPath: resources,
        appPath: join(resources, "app.asar"),
      }),
    ).toEqual({
      remotePageBaseUrl: "https://aihub.ucas.com.cn/remote/v4",
      relayWsUrl: "wss://aihub.ucas.com.cn/remote/ws",
    });
  });
});

describe("企业身份准入配置（方案 A）", () => {
  it("enterpriseAuth 合法时解析出基址与放宽开关", () => {
    expect(
      parseMobileRemoteControlConfig({
        remotePageBaseUrl: "https://aihub.example.com/remote/v4",
        relayWsUrl: "wss://aihub.example.com/remote/ws",
        enterpriseAuth: { apiBaseUrl: "https://pivot.example.com", allowSameOrgAnyUser: true },
      }),
    ).toMatchObject({
      enterpriseAuth: {
        apiBaseUrl: "https://pivot.example.com",
        allowSameOrgAnyUser: true,
        backend: "ucas",
      },
    });
  });

  it("backend 只认 uwork，其余一律回落到 ucas", () => {
    const uwork = parseMobileRemoteControlConfig({
      remotePageBaseUrl: "https://aihub.example.com/remote/v4",
      relayWsUrl: "wss://aihub.example.com/remote/ws",
      enterpriseAuth: { apiBaseUrl: "https://backend.example.com", backend: "uwork" },
    });
    expect(uwork?.enterpriseAuth?.backend).toBe("uwork");
    for (const backend of ["UCAS", "other", 1, null]) {
      const parsed = parseMobileRemoteControlConfig({
        remotePageBaseUrl: "https://aihub.example.com/remote/v4",
        relayWsUrl: "wss://aihub.example.com/remote/ws",
        enterpriseAuth: { apiBaseUrl: "https://backend.example.com", backend },
      });
      expect(parsed?.enterpriseAuth?.backend).toBe("ucas");
    }
  });

  it("allowSameOrgAnyUser 缺省为 false；基址不合法时整个准入配置被忽略但不影响远控", () => {
    const parsed = parseMobileRemoteControlConfig({
      remotePageBaseUrl: "https://aihub.example.com/remote/v4",
      relayWsUrl: "wss://aihub.example.com/remote/ws",
      enterpriseAuth: { apiBaseUrl: "https://pivot.example.com" },
    });
    expect(parsed?.enterpriseAuth).toEqual({
      apiBaseUrl: "https://pivot.example.com",
      allowSameOrgAnyUser: false,
      backend: "ucas",
    });
    const rejected = parseMobileRemoteControlConfig({
      remotePageBaseUrl: "https://aihub.example.com/remote/v4",
      relayWsUrl: "wss://aihub.example.com/remote/ws",
      enterpriseAuth: { apiBaseUrl: "http://pivot.example.com" },
    });
    expect(rejected).toMatchObject({ remotePageBaseUrl: "https://aihub.example.com/remote/v4" });
    expect(rejected?.enterpriseAuth).toBeUndefined();
  });
});

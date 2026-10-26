# Computer Use producer 检测

## 规则

Computer Use 的实现来自 workspace 包 `@zcode/zcode-cua`（producer）。历史开源导出用
`zcodeCuaPlaceholder: true` 占位包替换它，所有能力 fail-closed。当前 UWork 已恢复公开 macOS
驱动与独立 Helper；`zcodeCuaPlatforms: ["darwin"]` 明确限定 Helper 平台。其他来源的占位包仍受检测保护。

占位包保留公共 `build` 和 `tsconfig.json` 入口，构建只检查随包类型声明。
日志回调的 traceId 与参数类型和真实 producer 一致，使公共调用方无需按发行版本分支。
根单测引用的 `vitest.config.ts` 也必须存在，运行占位执行入口和 broker 的不可用契约测试。

开发、构建与打包中只服务于真实 Computer Use 的步骤，必须先检测到真实 producer 才执行；
检测不到时跳过。Helper 的开发/打包步骤还须匹配 `zcodeCuaPlatforms`，不能在未实现的平台请求不存在的产物：

| 步骤                                                                   | 位置                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------- |
| 开发启动构建 macOS Helper、注入 Helper 环境变量                        | `scripts/dev-desktop-env.mjs`                         |
| 开发态暂存 Computer Use 插件的原生依赖（Sharp）                        | `scripts/stage-dev-cua-plugin-runtime.mjs`            |
| Windows 运行时资源准备 `prepare:windows-cua-helper`                    | `packages/desktop/scripts/prepare-runtime-assets.mjs` |
| 打包附带 macOS Helper、Windows Helper 资源，打包后的 Helper 校验与定稿 | `packages/desktop/electron-builder.config.js`         |

Sharp、Koffi 的暂存与校验分别以 producer 的 `dependencies`、`optionalDependencies` 或
`peerDependencies` 是否声明对应运行依赖为准。当前公开 macOS producer 不声明二者，不能因为
它是真实 producer 就把额外 FFI 放入模型宿主；重新暂存时清理已不再需要的生成 Koffi 目录。
既有 producer 声明依赖时仍按原路径暂存并严格检查，缺原生产物必须失败。

## 所有者与接口

- 唯一判定：`packages/desktop/scripts/computer-use-producer.mjs` 的 `readComputerUseProducer` /
  `isRealComputerUseProducerInstalled`。从桌面包目录向上查找最近一次安装的 `@zcode/zcode-cua`，
  读取清单的 `zcodeCuaPlaceholder` 字段。
- 构建配置同步求值，判定只做一次小文件同步读取。
- 平台门：`isComputerUseProducerSupported` 组合真实 producer 与平台清单；未提供平台清单的既有 producer 保持原行为。
- macOS 公开 Helper 由 `scripts/build-cua-helper-app.mjs` 构建，开发落点与随包落点分离。详见 `specs/restore-macos-computer-use-runtime.md`。

## 验收

1. 闭源（真实 producer）：上述步骤行为不变。
2. 占位包：`pnpm dev:desktop` 的准备脚本可加载，开发态插件运行时暂存返回空，Windows 不准备 Helper，
   打包不附带也不校验 Helper。
3. 单测：`packages/desktop/test/placeholderProducerDetection.test.ts` 覆盖真实、占位、未安装三种情况与暂存跳过。
4. 原生依赖门：`sharpComputerUseRequirement.test.ts` / `koffiComputerUseRequirement.test.ts` 覆盖依赖声明、最近安装优先与缺失依赖；Koffi 同时验证无依赖跳过/陈旧生成物清理及旧 producer 的真实暂存/校验。

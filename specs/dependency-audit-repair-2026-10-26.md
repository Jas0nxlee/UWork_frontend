# 2026-10-26 依赖审计阻断修复

## 证据与范围

PR #3 的 `94ce5f22` 在 GitHub Actions run `40329864525` 的既有 `Dependency release gate` 失败。下载的 `dependency-audit` 产物与本地 `pnpm audit --prod --json` 一致：5 high、26 moderate、7 low、0 critical。以下受影响版本均已存在于 `origin/main` 的锁文件，并非本次 CUA 驱动依赖引入。

| 组件     | 当前版本                            | 官方安全版本 | 影响与依据                                                                                                                                                                                                                                   |
| -------- | ----------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zod      | `4.6.5`、contracts 使用的 `3.25.76` | `4.6.6`      | 不可信的大型受约束集合可能耗尽内存；[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)。没有已发布的安全 Zod 3 补丁，contracts 必须迁移真实 Zod 4，不能借 `/v3` 兼容入口规避审计。                                     |
| Electron | `41.10.7`                           | `42.11.16`   | 被攻破的 eMudhra 中间证书可能用于网络中间人攻击；官方明确没有应用层 workaround；[GHSA-jr5w-w6x2-84p9](https://github.com/advisories/GHSA-jr5w-w6x2-84p9)、[42.11.16 发布说明](https://github.com/electron/electron/releases/tag/v42.11.16)。 |
| Undici 6 | `6.29.0`                            | `6.29.1`     | 恶意服务器返回过多内容编码后提前断连，可触发未处理错误导致进程退出；[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c)、[6.29.1 发布说明](https://github.com/nodejs/undici/releases/tag/v6.29.1)。                     |
| Undici 7 | `7.30.0`                            | `7.30.1`     | 同一漏洞，保留各消费者现有主版本；[7.30.1 发布说明](https://github.com/nodejs/undici/releases/tag/v7.30.1)。                                                                                                                                 |

## 产品规则与唯一事实源

- 保留现有 `pnpm audit --prod --audit-level=high` 门槛与 CI 失败语义，不忽略公告或改变严重级别。
- 各直接依赖清单固定安全版本；根 `pnpm-workspace.yaml` 的现有 Undici 分主版本 override 提高到对应安全补丁，锁文件只由 pnpm 生成。
- Zod 4 消费者统一为 `4.6.6`；contracts 从 Zod 3 迁移到同一真实 Zod 4，实现与对模型公开的 JSON Schema 必须继续一致。
- contracts 的转换 owner 保持 `toToolJsonSchema`；使用上游原生转换，保留输入语义、原有正规化与验证拒绝边界，不以 `unrepresentable: any` 静默丢弃约束。迁移以 [Zod 官方迁移说明](https://zod.dev/v4/changelog) 和 [JSON Schema 文档](https://zod.dev/json-schema) 为依据。
- Electron 版本以桌面清单为唯一事实源；重新安装、原生模块准备及最终本地包构建必须使用 `42.11.16`，不能复用旧 Electron 41 的成功启动作为新版本验收。
- 生成第三方 notices/inventory，并保留原有许可复核限制；本修复不更改正式签名、授权策略或本地开发档位的权限边界。

## Jimp 的间接 Zod 3 兼容修复

首次升级后仍有一个 high：`jimp@1.6.1` 的 16 个 `@jimp/*@1.6.1` 包依赖 Zod 3。核验时 [上游最新发布仍为 1.6.1](https://github.com/jimp-dev/jimp/releases/tag/v1.6.1)。这些消费方使用的参数 schema 经源码核对可迁移到真实 Zod 4，唯一需要适配的运行时校验为 [print callback schema](https://github.com/jimp-dev/jimp/blob/v1.6.1/plugins/plugin-print/src/index.ts)。

仅对这 16 个精确包/版本配置定向 Zod 4 override；通过 pnpm 原生 `patchedDependencies` 保存 `@jimp/plugin-print@1.6.1` 的 ESM/CJS 修复。实测 Zod 4.6.6 接受旧 `function(tuple).optional()` 写法，但忽略旧 tuple 声明，坏坐标也会进入 callback。原可选 callback 改为先验证函数，再由 Zod 4 `function(...).implement(...)` 保留坐标参数校验、返回值无约束和 `this` 绑定。其余打印流程及图像算法不变。原图像 resize/crop/压缩测试与新增真实字体打印、像素、回调和 PNG 回读测试必须通过；不得只用 audit 版本号替代兼容性证据。

## Electron 支持周期与验证限制

[官方发布日程](https://releases.electronjs.org/schedule) 标记 Electron 42 于 **2026-10-20** 结束支持。本轮采用 `42.11.16` 是有公告依据、范围最小且已验证的漏洞修复，不表示长期维护完成；后续仍需升级受支持的主线。`audit` high/critical 为 0 不替代支持周期维护或未知漏洞评估。

本机 Electron 42 的原生 PTY、隐藏页面截图和后台活动冒烟由构建验证独立执行。截图精确 RGBA 在 macOS 默认色彩配置下的失败同样存在于旧 Electron 41；显式 sRGB 后原始精确断言通过，不能将其描述为新版本默认色彩验收通过，也没有降低断言。

## 验收

1. 固定版本安装及 frozen-lockfile 一致性检查成功；锁文件的生产依赖闭包中不存在受本轮 high 公告影响的旧版本。开发工具 `chromium-bidi@0.6.3` 仍包含 `zod@3.23.8`，不在本轮 `--prod` 门禁范围，未据此宣称全依赖零告警。
2. `pnpm audit --prod --audit-level=high --json` 的 high/critical 均为 0。较低级别的剩余公告如实记录，不能把结果写成零漏洞。
3. contracts 单测和类型检查覆盖 record、预处理/默认值、JSON Schema 转换、工具参数校验与 provider 暴露合同，保留既有错误拒绝和未知字段语义。
4. 对 Undici 6/7 使用真实本地恶意响应验证：调用者捕获 fetch 拒绝后，进程保持存活且没有未处理错误；正常请求仍可用。
5. 执行根与 CLI 类型检查、Lint、架构检查、受影响聚焦测试；重新生成并检查 notices。
6. 最终本地开发包核验 Electron 42、原生模块加载、界面启动和权限入口；CI 在新 head 上通过既有 gate 后才能合并。源码测试通过不替代系统应用替换和真机授权返回。

## contracts 的 Zod 4 迁移合同

- `tool-json-schema` 是本次明确接管的纯合同模块：仅拥有既有 `json-schema.ts`、`deferred-tool-call.ts`、`tool-search.ts` 和小型治理目录，不接管整个 legacy CLI 或 contracts 包。`toToolJsonSchema` 继续是转换的唯一 owner，既有导入路径保持公开；原先 tool-search 的“仅注释清理”例外移除该 contracts 路径，实际转换器修改接受受管依赖、层与契约检查。
- 使用真正 Zod 4 导出，单参数 record 明确为字符串键；预处理函数沿用现有布尔强制转换、默认值和只读 limit 钳制规则，通过返回类型推断替换已删除的 `ZodEffects` 类型。
- 三处旧转换器消费者统一经 `toToolJsonSchema`，采用原生 `z.toJSONSchema` 的 `io: input`、`target: draft-07` 与 inline reused schema；循环引用明确拒绝，不能在正规化删除 `$ref` 时把循环 schema 静默变成任意输入。
- 保持现有 provider 关键字正规化、ToolSearch 的显式必填覆盖和 strict unknown-key 拒绝；预处理/转换型字段仍公开输入的类型、范围及默认值，record 值约束继续保留。
- 新增聚焦转换器用例，覆盖 nested record、preprocess/transform、重复 schema 完整内联及非 JSON 值/循环类型明确失败；同时运行整个 contracts 包现有测试和构建类型检查。

## 本轮实际结果

- `pnpm audit --prod --audit-level=high --json` 通过：high **0**、critical **0**；仍有 moderate **19**、low **4**。未降低门槛、添加忽略项或改变 CI 的审计范围。
- pnpm 原生 `patch-commit` 记录 Jimp 两处 runtime 修改，精确 patch hash 为 `a2647164af82b933f77849c11a79098d891ed22e51a49c2bbc3d35336c4b6a8c`；`pnpm install --frozen-lockfile --lockfile-only --ignore-scripts` 通过。
- 依赖安全回归 15 项通过，包含受约束 Zod 数组在遍历坏元素前拒绝，以及 Undici 6/7 遇到过多内容编码后拒绝请求并继续处理正常请求的真实子进程测试。
- Jimp 原 image 11 项与新增 ESM/CJS print 6 项通过，证实字体像素、PNG 回读、回调 `this` 与准确完成坐标、坏 callback 和异常完成坐标拒绝。原始未改 vendor API 在 Zod 4 下接受 NaN 完成坐标，补丁后 callback 不被调用；不将该问题误写为导入崩溃。

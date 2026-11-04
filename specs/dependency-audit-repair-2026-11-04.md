# 2026-11-04 发布依赖审计修复

## 已确认原因

PR #8 的 GitHub Actions run `41763837430` 与 PR #9 的 run `41803555736` 均通过功能检查，在既有 `Dependency release gate` 失败。本地对提交锁文件执行 `pnpm audit --prod --audit-level=high --json` 重现：1 high、0 critical、23 moderate、4 low。唯一 high 是生产边 `packages/server → follow-redirects@1.16.1` 的 GHSA-mrwp-f3q8-3g9p / CVE-2026-116689。

`1.16.0`、`1.16.1` 用 `instanceof Array` 验证 `sensitiveHeaders`，来自另一 JavaScript realm 的合法数组会被当作无效输入清空，跨 origin 重定向时可能带走调用方声明的自定义凭据头。上游 `1.16.2` 改为 `Array.isArray`。这是一条此前已存在的依赖边，不能仅根据 PR 时间把漏洞归因于新功能。

## 修复边界

- 将 workspace 对已知受影响的 `follow-redirects` 1.16.0–1.16.1 定向至精确修复版 `1.16.2`，不批量升级其他包或改变主版本。
- 锁文件由当前 pinned pnpm 生成，并使用 `--frozen-lockfile` 验证可安装。
- 同步实际安装图的第三方 notices/inventory；保留既有补丁、安装脚本允许列表和审计范围。
- 保留 CI 的 `pnpm audit --prod --audit-level=high` 门槛，不忽略公告、不降低严重级别、不跳过检查。

## 合并后的复制资源登记

PR #8 的 Share 构建通过 `packages/web-share/vite.config.ts` 的 `publicDir` 复用受版本控制的 `packages/web/public`，不再持有 `packages/web-share/public` 副本。合入 PR #9 后，`third-party/copied-components.json` 与生成 inventory 仍引用旧副本路径，导致没有本地图标镜像的检出执行 `node scripts/licenses.mjs check` 时出现 `ENOENT`。CI 的临时 fixture 测试与仅复制声明正文的打包路径不执行仓库 inventory 输入核验，不能据此认定该路径有效。

复制资源来源由 `third-party/copied-components.json` 唯一登记，notices 和 inventory 通过既有生成器派生；Material Icon Theme 只登记真实受版本控制的 Desktop、Web 图标根。Share 继续消费 Web 资源，不新增镜像、生成步骤或准入例外。

验收：在没有 `packages/web-share/public` 的检出中，Material Icon Theme 的每个登记根均包含受版本控制且可读取的资源；重新生成 notices/inventory 后执行 `node scripts/licenses.mjs check` 与 `readVerifiedNotices` 成功，inventory 不再含旧 Share 图标路径。保留既有 36 项材料核验限制与全部 CI 门槛。

## 回归与验收

复用现有两 origin 的 loopback 重定向测试，增加 `node:vm` 创建的真实跨 realm `sensitiveHeaders` 数组：分别验证对象头与数组头的自定义凭据在目标 origin 缺失，非敏感 `X-Public` 仍被转发。旧版本应失败，修复版应通过；不向第三方发送请求或真实凭据。

要求定向依赖安全测试、类型检查、Lint、架构检查通过，实际生产审计 high/critical 为 0。较低级别公告数量如实记录，不宣称零漏洞。

## 上游依据

- [安全公告与受影响/修复版本](https://github.com/follow-redirects/follow-redirects/security/advisories/GHSA-mrwp-f3q8-3g9p)
- [Array.isArray 修复提交](https://github.com/follow-redirects/follow-redirects/commit/b0a7751e9cd64cd8eeb6ec67d2f206a9cc88d3f8)
- [1.16.2 发布](https://github.com/follow-redirects/follow-redirects/releases/tag/v1.16.2)

## 实跑结果

- 两项新增跨 realm 回归在旧 `1.16.1` 均重现自定义凭据外发；升级后完整依赖安全文件 **17/17** 通过。
- `pnpm install --frozen-lockfile --ignore-scripts` 通过；锁差异仅涉及目标包版本及 Axios/Server 指向。
- `pnpm typecheck`、`pnpm lint`（330 项既有警告、0 错误）、架构检查通过。
- 实际 `pnpm audit --prod --audit-level=high --json` 通过：high **0**、critical **0**；仍有 moderate **23**、low **4**。
- `node scripts/licenses.mjs notices` 已重新生成；基础 `licenses.mjs check` 的许可标识与声明新鲜度通过。既有 36 项材料核验限制仍保留，不将基础检查当作全面许可合规结论。

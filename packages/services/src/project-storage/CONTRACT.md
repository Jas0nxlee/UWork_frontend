# project-storage

Host 项目组织态的持久化升级。调用者持有 app SQLite 连接，CLI 通过协议交接事实，不导入此模块。

- `0005_projects`（旧 ID `0001_projects`）首次迁移旧 settings 中保留的 workspace；不删除或改写旧列语义、不移动目录。
- 首次项目集合与 position 仅来自 lastWorkspaceSession 中本 Host 保留的项目条目，按原顺序去重，保留无任务的已保存项目。conversation、历史 tasks、recentProjects 和 Group 不创建项目；settings 缺失或列表为空时不推断项目。历史任务保留 cwd 与组织态，无匹配项目时保持 NULL；已有 ledger 不重跑转换、不重排或自动清理项目。
- ID 沿用 CLI 的四位递增序号 + snake_case 名称，两个库独立编号；开发期旧 ID 的本机更名不修改 SQL/checksum 或重新执行转换。
- 初始 cli\_\* 从旧列复制一次，之后只由 syncer 写。handoff_pending 为意图与首次判定 bit；NULL project_id 是合法最终组织态。
- 老版本新写行以 host_id IS NULL 识别，同一事务补身份、首次归位与 bit 8；用户在新版移出/新建的空归属不能再次自动分配。
- 同 host 唯一 root 匹配才归位，主要目录没有优先级。Group 保留独立组织态，不转换为项目。
- settings 的 remote 条目只首次导入本机入口缓存，不能变成本机权威 project；普通启动不再导入。
- 迁移依赖 sqlite-migrations 公共端口；内部文件不被 UI/其他服务直接导入。目录/备份位置与 logger 均由启动入口注入。

项目仓库的事务面：save/delete/move/reorder/reserveCreatedTask 不写 cli\_\* 列。列表与目录解析在同步 SQLite 读事务中完成，不跨 await。缺 root 移动需要 addMissingRoot=true；恢复必须同 host 且 roots 集合完全相同。项目唯一名称在写事务中分配。新建 task 归属只在未决定时提交，后续由 moveTask 显式变更。

项目树任务沿用原列表/Controller 的执行后端过滤：仅 `provider=ZCODE_AGENT_PROVIDER`（当前 glm）。旧后端行即使已补齐 cli\_\* 也不进入项目、置顶、未归类、时间线、归档和未读投影；新导入的当前 CLI 会话保留，不按 migration_source、模型供应商或目录存在性过滤。只读，不改旧数据或 migration，已升级数据库无需再次转换；本地与远端持库 Host 使用同一规则。

新建项目在原写事务内分配同 Host 的最小 position 减一（空集合为 0），排在已有项目之前；编辑/恢复不改 position。position 保留为首次显示的初始化依据；控制端拖拽使用侧栏偏好，不向远端调用 reorderProjects。既有行不重排，不增加迁移。

自动归档以 cli_updated_at/cli_last_outcome 为筛选依据，排除已有非终态订阅，只写 archived；不按 project_id 或默认目录过滤。

定时/闲时派发提供已保存的附加目录快照（含空数组），预留只验证同 Host 的既有项目，允许 roots 已编辑或项目已软删除；普通创建仍校验 cwd 属于当前未删除项目。快照不改写项目 roots，重复预留不覆盖已有归属。

带显式附加目录的新建将执行快照同事务写入 tasks.execution_directories，后续任何恢复从此不可变值读取；普通 session 为 NULL，继续读取项目当前 roots。重试不得覆盖快照，定义删除不改变生成会话的初始化配置。

旧 Group、成员与顺序保持独立，不按成员目录新增项目。用户手建空项目合法；不修改已发布的 SQL/checksum。

0006_default_workspace_tasks 一次性纠正系统 default 目录误迁移：只处理旧迁移时已创建且未编辑、未改名、单 root 的自动项目，任务 project_id 清空且容器软删；CLI 事实、执行目录、归档/置顶/未读及定时定义不变。只触及 tasks/projects，旧 checksum 不变；后续手建/恢复不会重复纠正。

## 2026-10-10 远程单目录合同

本地仍允许 0..n roots；可信 ownerHostId 非 local 的持库宿主只允许恰好一个固定 root。远程创建必须有项目，prepareSession、reserveCreatedTask 与 moveTask 不得产生无归属或附加目录；根路径更新和缺 root 拖动在写事务中拒绝。客户端 hostId 不能改变持库身份。历史迁移数据不被裁剪，失败不得部分写入。

启动入口复用 session 模块公开的旧 Repo 与迁移适配器：先 SQL 迁移并提交，再逐一 ensureReady/close，最后标记 prepared。Worker 必须注入旧 settings 以完成首次项目导入；进度复制迁移事实，失败不撤回已提交计数。storage-startup 子路径保持不变。

`createSessionStorageOwnershipManifest(tasksIndexPath)` 只在该路径完成准备后，以只读连接导出原始本地 `glm` 任务归属，包含归档和软删除，排除远端与其他 runtime。列表投影和标题/provider 归一不参与归属判断。清单写到 app 库同目录的随机私有临时目录（文件 0600），返回路径及幂等异步清理函数；Host 在准备 Worker 退出后负责清理，不通过本接口读写 CLI 会话事实。

整根冷复制端口：`copyDataDirectory(oldBaseDir, newBaseDir, { requestId, bootstrapSettingsFilePath? })` 不提交设置，不开放业务连接。调用方在业务启动前持有请求锁并停写；复制器只读取原根，SQLite 通过只读事务与 backup 固定含 WAL 的视图，逐行校验 schema/内容、quick_check 与 FK，不搬迁旧 WAL/SHM。普通文件使用流式 SHA-256，JSON 仅按相对文件与字段白名单重定位：cli/config 的 storage.{dir,sessionDbPath}、用户资产启停键，及已知插件安装/市场元数据的 installPath/cachePath/本地 source.path；任意业务 JSON 与 plugin.json 原始字节不变。旧根始终保留。

目标私有 `.uwork-data-migration-receipt.json` 绑定 requestId、source、target 和复制后完整目录指纹。激活后设置提交前崩溃，同请求先核验目标所有目录/文件内容与权限后幂等返回；不同请求、坏凭据、内容变化和额外项全部拒绝，不覆盖非空目标。无 requestId 的原公开调用仍拒绝非空目标。此凭据不是业务写入账本，设置提交后的正常运行可改变目标。

`listDataDirectorySqliteFiles(baseDir)` 是冷启动写者检查的只读公共枚举口，按真实 SQLite header 识别。默认 CLI/db 目录和数据库文件链接失败关闭，普通旧共享链接沿旧规则跳过；不能因跳过默认数据库链接而激活一个缺库根。SQLite 内业务 JSON/cwd/identity 不做字符串重定位。

重置默认目录的唯一非空目标特例：调用方显式提供固定 `bootstrapSettingsFilePath`，且目标只含 `v2/setting.json` 与 `setting.json.*` 操作元数据。其原文只从目标 owner 保留进 stage，不采用源根的 setting；仅允许普通 setting 文件和生成器格式 .tmp-PID-time-hex 原子临时普通文件，任何同前缀目录/后代都不是 owner 例外；receipt 仅排除此精确 owner 命名空间，使设置 CAS 提交后的变化不误报业务内容损坏。其他非空目标、额外文件和链接继续拒绝。

同 request 的私有 stage workspace 位于目标父目录，路径绑定 source/target/requestId 哈希。verified journal 必须在 retire bootstrap-only 目标之前持久化，且 stage 已包含原 bootstrap 字节。retire 后中断由同请求直接验证/激活已有 stage，不先重建小 target；激活后的目标 receipt 完整核验后可直接幂等返回。调用方须在产品根外保留私有请求与 bootstrap 恢复记录，并在正常 bootstrap 读取前经过同一启动门禁；复制器不拥有设置提交，也不通过读取旧设置猜测是否完成。

会话 cwd/identity、正文和任务 JSON 不重定位。`cli/config.json` 的 skills/command 路径键只移动旧根的用户 skills/commands/agents 与明确 plugins 缓存资产；旧根 workspace 下项目级键保留原路径，避免新副本不作为 cwd 却让项目禁用状态丢失。存储引用 storage.dir/sessionDbPath 是独立配置能力，可随整根存储选择移动，不用其规则推导 cwd。

stage 普通文件通过可写句柄 flush，再恢复源权限；不能用 Windows 上不满足 FlushFileBuffers 的只读句柄，也不能先恢复 readonly 后再打开 r+。Windows 分支有可写访问模拟回归，未以此替代 Windows 实机验收。

# cli-session-storage-migration

Host 的本地归属清单只回答哪些任务属于 UWork；本模块在业务 CLI 启动前离线迁移它们的会话事实。接口不暴露数据库写入给 Host，不修改旧库 schema 或业务行。

静态 schema 归属：

| 表                                                    | 导入范围                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| session                                               | manifest 的 ID + cwd/identity 精确校验；parent_id、task link、workflow activity、DWF actor 的 child 闭包                     |
| message / part                                        | owned session；part 的非 FK session_id 必须与 message 所属一致                                                               |
| session_entry / session_input / session_target / todo | owned session，保留完整 JSON、时序与业务列                                                                                   |
| model_usage / tool_usage / turn_usage                 | owned session，保留非 FK 消息、输入及工具关联字段                                                                            |
| input_history                                         | owned session；session_id 为空的行只按已验证 session.project_id 的本地作用域纳入                                             |
| permission / local_setting                            | 已验证 CLI project scope（与 Host project 无关）；local_setting 另含 owned session/workspace scope，排除 global 和未知 scope |
| workflow_run / activity / event / definition          | owned parent session 的 run，其活动子会话与事件及引用 definition                                                             |
| session_task_link                                     | owned parent/child 或 owned workflow 的 link，外部 parent/run 不能悄悄截断                                                   |
| dwf_run / actor / node / event                        | owned parent session 的 run；无 FK actor.session_id 纳入 child 闭包，保留 artifact 路径与事件引用                            |
| schema_migration / zcode_database_identity            | 用当前 schema 升级副本；不把源库全局 identity/ledger 覆盖到目标                                                              |

若同一 project/workspace scope 中存在未归属 UWork 的 session，对应无 session_id 的历史、project/workspace setting 或 permission 共享行无法证明产品归属，以 `code=SESSION_MIGRATION_OWNERSHIP`、`kind=ownership` 拒绝，不能复制或静默丢弃。会话行自身的 permission 字段仍完整迁移。

未知表、未知迁移 ID、升级后额外列均失败关闭。关系缓存只查询 ID、cwd/identity 和关联列；正文与事件按行复制，不把源库所有产品正文缓存进内存；所有主键冲突逐列比较，相同值幂等，异值拒绝。文件引用和 JSON 内路径保持原样。

源/已有目标均用 SQLite backup 获得含 WAL 的一致性快照，原始备份保留，只升级副本。stage 校验后写入活动标记与内容指纹，再持久化 activating journal；目标及其 sidecars 移入保留目录后激活 stage。激活中崩溃可通过 journal、marker、指纹收口；complete 后只检查目标 marker，不再读取 source/manifest，运行中新写入不参与重复导入。

完成绑定使用不可变 migration UUID、manifest 指纹与源身份指纹，绝对位置字段仅保留审计用途。同一 HOME 内原样复制产品根后，只读取当前 resolver 目标旁的 ledger 并与当前 DB marker 校验；完成 ledger 的历史 sourcePath/targetPath/workDir 不再作为文件操作地址，也不要求 Service 重写这些 Runtime 私有字段。未完成各阶段仍严格绑定当前路径和安全 workDir。跨用户/HOME 的归属切换不在本合同范围内。

未激活的 copying/verified 尝试还要对源主库与 WAL 做流式内容指纹校验。快照前后或激活前发现源续写，以 `SESSION_MIGRATION_SOURCE_CHANGED` 拒绝当前旧快照；再次调用 migrate 时保留原 workDir 和备份及 superseded-attempt 记录，生成新 UUID、重新备份并校验归属，而不复用陈旧 source-backup。activating 阶段源发生变化则必须失败关闭，不能自动重导覆盖已经开始激活的结果。complete 后不再计算源指纹，后续上游产品使用旧库不影响 UWork。

工作目录 0700，备份、stage 和账本 0600；目标激活时保留已有 mode，首次目标使用 0600。Host 自己以 0600 创建归属输入文件。文件权限断言只在 POSIX 平台运行。

跨进程锁记录 PID 和随机 owner；活 PID 不按时间抢锁。孤儿锁改名保留，避免并发回收者删除后来新建的活锁。旧版 UWork writer 检测由 Host 启动门禁负责，迁移锁不声称约束旧代码。失败不创建可供业务 Agent 使用的空库。

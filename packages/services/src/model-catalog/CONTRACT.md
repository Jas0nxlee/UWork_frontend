# model-catalog

给 Host 的模型发现结果附加 models.dev 推荐；不拥有供应商配置或用户覆盖，不进行模型推理。

- 一个 runtime 实例唯一拥有目录快照、刷新 single-flight 和磁盘缓存。固定请求 `https://models.dev/api.json`，不发送供应商凭据、地址或输入内容。
- 成功校验才替换 last-good；24 小时 TTL，刷新失败 5 分钟内不重试；失败使用旧快照并标记 stale，没有旧快照则保留入参。
- 新鲜目录无法精确匹配时返回 `catalogConfig: null`；目录不可用或 stale 快照未匹配时不产生清除意图。
- 匹配顺序为目录明确的 provider endpoint、明确 provider/model ID、自指 canonical 记录；原厂记录缺失时仅接受至少两个供应商的 canonical 与完整能力白名单一致的共识。禁止 substring、裁剪日期或推断私有别名；无端点身份的唯一转售商别名也不构成型号证据。
- 只转换已验证的能力字段。文本输入/输出明确缺失时标为非聊天，未知时不猜；0 token 上限不进入模型配置。只有明确 effort 清单或不支持推理才生成档位；预算与 toggle 不伪造成强弱档，map 由 Provider 的协议规则拥有。
- Host 在模型发现返回后调用 `enrich`，随后交给 Provider owner 的同一 revision 事务；Host 保留网关明确能力与目录独立层；最终优先级为用户覆盖 > 网关下发 > 目录 > 软件内置配置。启动更新目录不覆盖网关，缺失字段继续使用下层配置。

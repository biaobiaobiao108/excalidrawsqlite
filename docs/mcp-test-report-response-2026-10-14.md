# MCP 测试报告逐项处理记录

核对对象：2026-10-14 的「狐涂画板 MCP 测试报告」。结论以当前仓库和本地真实 MCP SDK/SQLite 回归为准；没有修改线上网关，没有向生产画板写入测试数据。按用户要求，不添加永久删除或清空回收站工具。

## 问题清单

| 报告项 | 核对结论与处理 |
| --- | --- |
| P1-1：非 curl UA 初始化返回空 202 | 本地不可复现。Python-urllib/3.13、curl/8.0、普通客户端初始化均有正常 200 响应，SDK 可读取工具。无 ID 的初始化通知返回空 202 是正常协议行为。报告中的公网差异提示网关/WAF/代理链路拦截，但不能仅凭响应锁定具体 OpenResty 规则。仓库不含线上网关配置，未宣称已修复线上问题；README 补充逐层对比、UA 放行与明确 4xx 拒绝的排查说明。 |
| P1-2：成功 text 无有效数据 | 已修复。所有业务结果的 text 为与 structuredContent 相同对象的 JSON，包含 ID、图元、游标、警告和错误码。只放一两行摘要仍不能让纯文本客户端使用完整读结果，因此采用完整 JSON 兼容方案；响应预算继续生效，文档说明双通道增加报文体积。 |
| P1-3：删除缺失 ID 静默跳过 | 已修复。remove_elements 与 update_board 的成功及 noop 结果都返回去重的 notFoundIds。保留删除操作的幂等性，缺失 ID 不阻止其余合法操作；更新不存在图元仍明确报错。 |
| P1-4：删除不回传总数与级联信息 | 已修复。返回 elementCount、requestedRemovedCount、cascadeRemovedCount。当前仓库的 removedCount 原本就计入绑定文字，报告的 removedCount=1 与当前实现不符；保留实际删除总数的既有语义，避免破坏调用方。 |
| P2-1：CSS 命名色不完整 | 已修复。图元和文件夹共用校验支持全部 148 个标准命名色，包括 rebeccapurple，以及 transparent 和已有十六进制格式。报告的 147 个是未含 rebeccapurple 的旧数量。大小写统一，非法颜色仍拒绝。 |
| P2-2：批量子项缺 ok | get_boards_batch 已补全每项 ok:true/false，包括预算耗尽项；batch_manage_boards 当前已经具备该字段，补三个 action 的回归验证，没有重复修改实现。 |
| P2-3：recent 的 NULL 顺序不明 | 当前 MCP recent 仅列曾打开的画板，NULL 完全排除。view=all,sort=opened 才包含 NULL 并排末。补相同时间的 ID 次序、跨页、NULL 分组回归，文档及初始化指引明确这两种语义。 |
| P2-4：full 缺默认提醒 | 已补。常规阅读使用 compact，full 用于调试或小批量检查原生字段；保留现有分页/预算行为与相对坐标标注。 |
| P2-5：没有永久删除工具 | 不添加该能力。初始化 instructions 现在显示实际配置的回收站保留天数（默认 30 天）；设为 0 时显示自动清理已禁用。超期清理由定期维护执行，不承诺精确到期时间。 |

## 其他建议

| 建议 | 处理与理由 |
| --- | --- |
| text、UA、remove 优先处理 | 已按上表处理；UA 的线上配置问题保留为明确的部署待办。 |
| 告知 create_diagram 的边 ID | instructions 与 README 已补默认 diagram_edge_0、diagram_edge_1 等命名。节点 ID 冲突时边 ID 会加后缀，因此应以 responseMode=ids 的 elementMap 为准，再用 update_element 改样式。 |
| empty_trash 工具 | 根据用户要求不实现。 |
| 一万以上图元：SQL 下推分页 | 不在本次修改单行 JSON 存储模型。当前投影需要完整场景解析标签归属、箭头引用、不可写图元及依赖警告；按原生元素切页会改变 matchedCount、语义分页及绑定完整性。SQLite json_each 也不能等同于跳过整段 JSON 的读取和解析。已明确 maxChars 只约束输出，不保证数据库成本随分页下降；summary 已走不读取图元 JSON 的轻量查询。报告中的公网单次延迟含网络和代理，不能直接归因于 SQLite；后续改变存储模型应先做代表性大场景测量。 |
| REST 与 MCP 不要混用 | 不采纳禁止同板使用两条通道的笼统限制。两者本来就操作同一场景，并通过修订号保护；新增格式边界说明：REST 使用原生元素，MCP 使用简化描述，禁止直接互换或用投影覆盖原生场景。跨通道编辑应基于最新版本增量合并。 |
| 补含图片的验证 | 已补。通过 REST 写入带图片的场景，验证 input 的 unsupportedElementIds/warnings；copy_elements 含图片的选择集整体拒绝且不改变修订号；update_board/add_elements 修改其他对象完整保留已有图片。MCP 没有图片生成或上传工具，图片警告不是删除图片的指令。 |

## 验证边界

- 完整 `bun run test:all` 通过：单元测试、132 项服务端测试、全局类型检查、生产构建及体积门禁。
- 真实 MCP SDK 测试校验 text JSON 与 structuredContent 一致，并覆盖批读成功/失败项与字符预算。
- 删除验证覆盖绑定文字级联、重复缺失 ID、仅缺失 ID 的 noop，以及混合新增/删除的反馈。
- 本地 UA 测试区别带 ID 的初始化请求与无 ID 的通知；没有验证公网代理已恢复。
- 相关测试使用临时 SQLite/附件目录并清理，未引入浏览器环境或新运行时依赖。

协议依据：[MCP 工具结果兼容指引](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx)。颜色依据：[W3C CSS Color 4 命名色](https://www.w3.org/TR/css-color-4/#named-colors)。

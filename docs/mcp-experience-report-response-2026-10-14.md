# MCP 绘图体验报告处理记录

依据「狐涂画板 MCP 实际绘图体验报告（2026-10-14）」核对当前实现。测试使用本地临时 SQLite 与真实 MCP SDK；没有修改线上画板。成功 text 继续只保留简短说明，不复制 structuredContent 的 JSON；不添加永久删除能力。

| 问题或建议 | 处理结论 |
| --- | --- |
| P1-1：line 不支持绑定 | 采纳方案 B，并增强自动布局。原生绑定跟随逻辑使用 ExcalidrawArrowElement，不能直接给 line 加字段后声称具有相同效果。保留 line 固定坐标契约；在 schema、错误提示、工具指引和 README 中明确 arrow + endArrowhead:null 为无箭头绑定连线。create_diagram.edges 也新增可选 endArrowhead:"arrow"\|null，省略保持默认箭头，可一次生成无箭头的树。 |
| P2-1：单个与批量更新形态不同 | 保留 update_element.update 与 update_board.updates，两者复用同一个修改对象。新增相互引用和完整嵌套示例，误把 id/dx 等放到单个工具顶层时给出修正提示；不增加另一套平铺别名，避免字段冲突和额外 schema 分支。 |
| P2-2：移动后没有最终坐标 | 已补。update_element 回传实际 x/y/width/height，形状有绑定文字时返回 label:{id,x,y,width,height}；noop 也提供当前几何。标签数据来自最终元素集合，包含换行或居中后的真实位置。 |
| P2-3：移动或复制可能重叠 | 已补非阻断 warnings，覆盖 update_element、update_board 与 copy_elements，也检测同批新增或移动之间的新重叠。使用旋转 AABB 的高比例重叠启发式，忽略连线、绑定文字、明显面积差的完全包含及原有同程度重叠。保持用户坐标，不自动布局或拒绝保存。索引、比较和提示都有上限，未完成时 overlapCheck.complete=false 明确说明。 |
| P2-4：elementCount 与视图数量不同 | 已补视图计数。保留 elementCount 为原生总数，不增加同义 rawElementCount。图元视图另有 viewElementCount（筛选前）、matchedCount（筛选后）和 returnedElementCount（本页）；summary 不进行图元投影，仍只给原生总数。 |
| “修改与新增必须分两次调用” | 报告的判断不成立。update_board 已支持一次传 elements 新增和 updates 修改，先新增再修改；只在 updates 写不存在的 ID 确实报错。本次补真实 SDK 回归：同次新增 new-node 后在 updates 改其文字，同时移动已有节点成功。工具描述与文档明确顺序。 |
| 手工布局负担 | 维持 create_diagram 的流程图/时间线布局，不添加没有明确需求的新布局模式；已有 horizontal 与显式 edges 可生成树状结构。新增无箭头边改善思维导图/组织结构的一次成图体验。 |

重叠提示的限制：外接框相交不等于像素形状相交；容器识别是启发式，可能误报或漏报。阈值为较小框至少 80% 重叠，同时覆盖较大框至少 35%；明显面积差且完全包含时略过。最多检查场景前 5 万图元、1000 个变更 ID、20 万索引引用和2万次候选访问，最多回 20 条提示。`complete` 仅表示在这一启发式范围内是否完整检查，不是布局正确性的保证。

验证覆盖：无箭头连线与节点移动联动、错误参数的嵌套提示、图元和标签的最终位置、原有与新产生重叠的区分、批内新重叠、无操作、复制警告、原子新增并修改、视图筛选与分页计数。通过完整 `bun run test:all`：140 项服务端测试、单元测试、全局类型检查、生产构建及体积门禁。

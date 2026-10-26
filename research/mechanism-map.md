# DSH 动态工作流引擎 · 机制清单（mechanism map）

> 来源：`E:\os\out\zcode-dynamic-workflow-reverse-analysis.md`（逆向结论全文）+ `E:\os\out\zcode-dwf-assets\`（facade.d.ts、db-schema-dwf.sql、event-vocabulary.md、engine-slices/ 两个 guest-template 全文，engine-reg-ctx 抽查）。本文件是把这些证据翻译成的「实现清单」：每层三档判定（must / nice / defer）、层间依赖、对应 dsh 落位。
>
> 判定口径：
> - **must** — 不进第一版引擎就不能宣称等价运转（缺了语义直接塌）。
> - **nice** — 第一版没有会疼但有降级路径 / 可后补。
> - **defer** — 明确不进第一版；一句话给出为什么可缓。

---

## 0. 全景与 MVP 边界（结论先行）

原版十层（逆向文档 §2）归并为九个实现层。**MVP 必含七层：编译层、guest 确定性沙箱、journal 记账、调度、actor 子代理、工件、工具面**；**escalation 与 amend-resume 缓存不进第一版**（defer，理由见 §8/§11——两者都依赖 journal 语义稳定之后才值得做，且各自可退化为手工/重跑流程）。saved 工作流按 nice 处理（薄壳，可在 MVP 末补）。

依赖主干（箭头 = 依赖下游，即「先有才能有」）：

```
编译层(2) ──产出 AST/产物──▶ guest 沙箱(3) ──stdio NDJSON──▶ journal(4)
                                   │                          │
                                   ▼                          ▼
                              工具面(1) ◀────调度(5)────▶ actor 子代理(6)
                                   │            │
                                   ▼            ▼
                              工件(7)      amend-resume(11)〔defer〕
                                              ▲
                              escalation(8)〔defer〕
                                   │
                              saved 工作流(9)〔nice，只依赖工具面+编译层〕
```

关键洞见（决定排期顺序）：**journal(4) 是 amend(11) 和 escalation(8) 的上游**；guest 沙箱(3) 的三通道协议在两个 guest-template 里已是完整可移植源码；编译层(2) 是唯一「无现成件、全自写」的厚层。

---

## 1. 工具面（10 个工具 + 懒激活 + 技能门禁）

**判定：must（工具子集）/ nice（懒激活、门禁、EvalWorkflowSnippet 完整版）**

逆向依据：zcode-dynamic-workflow-reverse-analysis.md §2.1（10 工具清单、`dynamicWorkflowToolsOnDemand`、技能门禁、amend 错误码 21–29）。

- **must**：`CreateWorkflow / GetWorkflowRun / ListWorkflowRuns` 三件套——没有它们引擎不可用、不可观测。tool 面的 meta/script/args 协议保留原状。
- **nice**：`AmendWorkflow / ResumeWorkflowRun / FillWorkflowHole / ResolveWorkflowQuestion`——工具壳可先做（直接返回「尚未实现」错误码），语义随后续层补；`SaveWorkflow / ListSavedWorkflows` 随 §9；技能门禁（拒裸调）作为防误用的第二道闸后补，MVP 用提示词约定即可。
- **defer**：`EvalWorkflowSnippet` 完整版（隔离编译沙箱 + 同步返回）。第一版不提供试错面，模型直接走 CreateWorkflow。

| 件 | dsh 落位 | 现成/自写 |
|---|---|---|
| 工具定义与协议 | fork `@deepseek-ai/dsh-tool-workflow`（meta/script/args 协议已有） | 自写（有官方参考实现，工作量中） |
| 懒激活 | dsh 工具按需注入机制（若无则全量注入，仅多花 token） | 组合 |

## 2. TS 编译层（复现的最大增量）

**判定：must**

逆向依据：§2.2 全节；`engine-slices/engine-reg-ctx.txt` 实证 facade 由多个 `String.raw` 模板插值拼装（ChannelDeadlock 切片可见 `wPo=String.raw\`…\``）；facade.d.ts 全文即编译期声明的唯一事实源。

要点清单（实现时逐条对账）：

1. 引 npm `typescript` 全量包（**不要**内嵌 8MB——原版内嵌是为单文件 bundle，dsh 插件无此约束）。
2. 脚本在函数体内编译 → `declare`/`export`/`import` 非法；`strict: true`，`noUncheckedIndexedAccess: false`。
3. `facade.d.ts` 与用户脚本的 interface 声明合成一个 Program 交 TS LS 诊断（把 facade 全文作为 lib 连同用户 interface 一起 createProgram）。
4. 自定义诊断三族：`9001`（facade 可调用被存值/别名后调用）、`9011`（fill 用了未随 run 启动的模型）、`9012`（hole 规则族）。MVP 至少做 9012（hole 规则）与编译期字面量检查（`phase` 名、`world.run` 命令名、`artifact` id 必须是编译期 string literal——facade.d.ts 注释明言）。
5. `collectPhaseClaims` / `projectPhaseGraph` 编译期抽 phase 图，run-launched 事件带 `phaseNames` 全量清单供确认对话框画节点图；marker 覆盖其后所在 block（词法盖章）。**MVP 可降级**：phase 图只用于确认展示，画不了图就列表展示。
6. lowering：facade 调用 → guest 前导调用（`__host.*`），每个效应调用点打 siteId。
7. hole 站点 id = **FNV-1a(trim 后源文本) → `hole#xxxxxxxx`**（内容寻址，跨修订稳定）——编译层实现，非 guest。
8. `world.run` 命令名编译期字面量 → 命令集在用户确认时展示（安全模型）。

| 件 | dsh 落位 | 现成/自写 |
|---|---|---|
| 编译器本体 | 插件内引 npm `typescript` | 现成 |
| facade + 自定义诊断 + lowering | 无 | **全自写，无现成**（工作量中，全工程最大增量） |

## 3. guest 确定性沙箱（vm cell 子进程）

**判定：must。这是整个「确定性重放」的根基，且源码已到手——近乎直接移植。**

逆向依据：§2.3 全节；`guest-template-00-at14257842.js` 与 `guest-template-01-at14262187.js` 全文（channel 环形缓冲+waiter 队列+compact、future 同步抛转拒绝、停滞检测、NDJSON 三通道、hole `__fills` 本地缓存、Date/Math.random 禁令——全部带中文注释）。facade.d.ts:270-291 的 Channel/future 语义注释与之逐条对上。

- 三通道 stdio NDJSON 协议（guest-template-01 即协议书）：
  - `request {id, type: ask|world-read|hole|publish-artifact}` → 宿主 `response {id, ok, value|error}`；guest 侧 `__pending` Map 挂 promise。注意逆向文档 §2.3 列了 4 类，模板实锤 **hole 也是 request 型**（`type:"hole"`，answer 是 `{code}`）。
  - `event {log|phase-entered|report|declare-artifact|create-actor}` → 即发即忘；**到达顺序承重**（report 与 declare 共用 FIFO；create-actor 即发即忘、父进程按 FIFO 在后续 ask 前完成映射——guest-template-01:14-19）。
  - `complete {ok, value|error}` → run 结算，幂等（`__settled`）。
- **停滞检测**（guest-template-00:98-123）：宿主在每次投递 response 后与启动时各 `setImmediate` 调 `__checkStalled`；无在飞请求 + 微任务排空 + 未完成 → 有 channel receiver 停着报 `ChannelDeadlock`（点名通道与人数），否则 `ScriptStalled`。**停跑永不超时是设计**。
- realm 禁令（双保险的 belt 层，guest-template-01:181-201）：`Date.now`/argless `new Date`/`Math.random` 运行期抛错；无定时器、无 I/O、无 fs/fetch——唯一唤醒源是宿主 response。
- args 走 `JSON.parse` 进 context（context-native，不掺外层 realm intrinsics）；浅冻结（`Object.freeze` 只一层，v1 接受此界限）。

| 件 | dsh 落位 | 现成/自写 |
|---|---|---|
| 子进程 realm / 沙箱策略 / cancel | dsh **PTC Node runtime**（进程沙箱、文件策略、取消已有） | 现成 |
| guest 前导 shim（三通道+原语+停滞检测） | 移植两个 guest-template | **自写（源码在手，工作量小）** |

## 4. journal 记账层（一切副作用皆 node）

**判定：must。amend/escalation/回放/缓存全部踩在它上面，且 DDL 可直接建表。**

逆向依据：§2.4 全节；`db-schema-dwf.sql` 全文（dwf_run / dwf_actor / dwf_node / dwf_event / session_task_link 五表 DDL 原文）；`event-vocabulary.md`（22 事件 × 12602 条真实分布）。

- 最小记账单元 `(run_id, site_id, ordinal)` 唯一（DDL UNIQUE 约束原文，db-schema-dwf.sql:63、89）；node.kind ∈ `ask / world-read / world-run / report / artifact`（CHECK 原文，:75）；`input_hash` 是重放与缓存匹配的键（:79）。
- node 生命周期：`queued → dispatched → executing → waiting → settled`（+repairing/nudged），事件分布实测：node-settled 3268 / queued-dispatched 2431 / executing 771 / waiting 461（event-vocabulary.md）。
- caps（MVP 全部照抄，运行面防失控）：`maxPhases=32, maxPhaseNameLength=128, maxSubagents=64, maxNodes=2000(投影), maxOpLength=32, maxArgs=16`；world 输出 256KB / read 2000 条**拒收不截断**；report 65536 条/run、1MiB/条、1GiB/run；artifact 32 id、16 版本、20MiB file、256KB markdown。
- 事件溯源 + 投影读写分离：`dwf_event` append-only；`Get/ListWorkflowRuns` 是 reducer 投影（可驱逐、可重建，`evictForEntryBudget` + `nodesUnlisted`）。
- `session_task_link` 桥会话任务系统（后台任务列表/通知）——MVP 可留空表不接线。

| 件 | dsh 落位 | 现成/自写 |
|---|---|---|
| SQLite 五表 | dsh storage/session 插件位（SQLite 已有） | **全自写建表，官方明示无对应**（DDL 直接抄，工作量小） |
| 投影 reducer / 驱逐 | 无 | 自写（中） |

## 5. 调度层

**判定：must（并发上限）/ nice（retune、自适应收缩）**

逆向依据：§2.5 全节。

- `maxConcurrency`（实例默认 4）+ `scheduler.pumpAll()` —— **must**：并发上限与泵是防失控的最低配置。
- AmendWorkflow 只带 run_id + max_concurrency 对运行中 run = **原地 retune**（同 run id 不停跑，`run-caps-changed` 事件；实测全量仅 1 条）—— nice：MVP 并发上限启动即冻结。
- provider 侧错误（限流/过载/网络）无限重试并自适应收缩扇出；确定性错误（掉登录/配额）→ run `stopped` 等人修后 resume——**错误永不进脚本**。MVP：重试固定次数+指数退避即可（nice），错误不进脚本这条语义必须保住（must）。

| 件 | dsh 落位 | 现成/自写 |
|---|---|---|
| 并发/取消 | workflow-ptc 已有 `maxConcurrentAgents/maxTotalAgents/maxItemsPerCall` 与 cancel 语义 | **现成**（工作量小） |
| 自适应扇出收缩 | 无 | 自写（可 defer 进 MVP 后） |

## 6. Actor 子代理层

**判定：must（actor 句柄+FIFO 排队）/ nice（持久子会话绑定、escalation 计数）**

逆向依据：§2.6 全节；facade.d.ts:41（agent 命名即身份、重复 literal 是编译错、未命名永不复用缓存）、:25-33（ask FIFO）；db-schema-dwf.sql:52-64（dwf_actor 表）。

- `agent(name, persona)`：persona 建即冻结 `{system, model}`（facade.d.ts:14-19）；同 actor 的 ask **FIFO 排队**（「共享上下文=共享变量」）。
- 命名子代理 → `dwf_actor` 行 + 真实可续子会话 `sess_dwf-<runid>-actor_<n>_<k>`；`message_boundary` 记会话消息边界（dwf_node.message_boundary 列）——**会话绑定是 amend 缓存的物理载体**，但 amend 本身 defer（§11），故 MVP 只需：每 ask 一次独立子代理调用（无状态），把「actor→会话」留作接口预留。
- 每 ask 3 次 escalation 机会、第 4 次自动「自行最佳判断」继续（防话痨）——nice：MVP 无 escalation 通道，此计数随 §8 一起 defer。

| 件 | dsh 落位 | 现成/自写 |
|---|---|---|
| 子代理运行 | `ctx.subagents` + tool-subagent provider（Activation/归属已有） | **现成**（组合，工作量小中） |
| actor↔子会话持久绑定 + FIFO 队列 | 无 | 自写（MVP 可只做 FIFO 内存队列） |

## 7. 工件层

**判定：must（report / file / markdown）/ defer（chart/table/metrics/board 四种声明式 preset）**

逆向依据：§2.9 全节；facade.d.ts:67-142（effects vs declarations 语义原文：file/markdown 是 request/response 效应、可 catch、发布时拷字节、再发=新版本；chart/table/metrics/board 是声明、同步 void、吃 `report(item,id)` 标签流、仅顶层声明）；`declareArtifact` 走事件通道与 report 共享 FIFO 保证序（guest-template-01:88-92）；db-schema-dwf.sql:109-111（artifact 事件索引）。

- **must**：`report()`（即发即忘但落 journal——失败打捞的根基：errored run 的 report 也随通知送达）+ `artifact.file/markdown`（效应型，可 catch）+ `primary: true` 至多一个。
- **defer**：四种 preset 声明件——它们是纯 UI 聚合（点/行/瓦片/卡），没有它们 run 的结果数据一点不少（都还在 report 流里）；dsh web 卡片体系就绪后一批做。

| 件 | dsh 落位 | 现成/自写 |
|---|---|---|
| file/markdown + report 落 journal | dsh `deliverables` 包位 + web 卡片；或先只出 markdown 文本卡 | 组合（工作量小中） |
| chart/table/metrics/board | dsh web 前端组件 | defer |

## 8. Escalation（宿主问答桥）

**判定：defer**

逆向依据：§2.6 末段（escalation registry `park({qid,…})`、qid=`dwfq-<runseq>-<n>` 注册表查重、`ResolveWorkflowQuestion` 的 answer 逐字成为子代理返回值、qid 绑会话、会话退场即 withdraw）；event-vocabulary.md：`escalation-raised/resolved` 各 18 条 / 12602 总事件 ≈ 0.14%——**真实使用密度极低**。

- defer 理由：① 使用率低，非 MVP 痛点；② dsh 通知/交互面（web 会话注入、任务通知）形态未定，先做会绑死在错误形态上；③ 依赖 journal 的 waiting 状态机稳定。
- MVP 降级路径：子代理答不上来 → ask 直接返回「无法回答」的文本（脚本可自行兜底），第 4 次自动自决的语义由提示词层约定。
- 落位：**全自写**（桥到 dsh 宿主通知面），工作量中，取决于 dsh 通知面。

## 9. Saved Workflows

**判定：nice**

逆向依据：§2.10 全节（`.zcode/workflows/<name>.dwf.ts` 项目级 + 全局；`/* zcode-workflow` YAML 元数据块 description/whenToUse/scope/args 带类型+required+default；保存时同一编译器校验；运行时 args 先验证后启动）。

- 实现薄：= 编译层复用 + 一段 YAML 解析/校验 + 两个文件系统路径约定，不依赖调度/journal。放 MVP 末尾做即可，也可让第一批用户用内联脚本过渡。
- 落位：自写 `.dsh-workflows/`（或直接用社区 dsh-tool-workflow-plus），工作量小。

## 10. 工具面懒激活 / 技能门禁（已并入 §1，不单列）——（保留编号占位，勿删）

## 11. Amend / Resume（复现的核心卖点）

**判定：defer（但 journal 层必须按它的语义留好钩子）**

逆向依据：§2.8 全节（amend=新 run+import 缓存、`resumed_from` 链实测最长 7 连、旧 run 标 superseded；**actor 按名匹配、ask 按「顺序+指令字节相同」匹配**、命中零 token 从记账结算；缓存失效时刻=第一个活性写动作→`import-cache-closed{cause}`、纯回答型 ask 永远可从缓存结算；resume=同 run 重放 journal：`restoreFromJournal`→`seedRecordedAsks`+`replaySettleOrder`、report 计数/字节对账防重复通知）；event-vocabulary.md：import-cache-closed 仅 20 条。

- defer 理由：① 它是 journal(§4) + actor 会话绑定(§6) 都稳定之后的第二阶段功能；② dsh 官方明示没有对应物，无现成件，纯自写且语义最密（匹配规则、失效时刻、结算顺序重放三块都要对）；③ MVP 阶段改脚本 = 停掉重跑，用户可接受。
- **必须现在做对的事**（这是 defer 不等于不写的部分）：
  - site_id 用内容哈希（不是行号），ordinal 按到达序——已在 §4 must 里；
  - actor 命名即身份的编译期约束已在 §2/§6 里；
  - `dwf_run.resumed_from` 列与 `superseded` 状态留好（DDL 原文已有）；
  - world-read / world-run 结果照常落 `result_json` + `input_hash`——这是将来缓存的键。
- 落位：全自写，工具壳在 §1 先占位报 `AMEND_UNAVAILABLE`（错误码 21 已实测）。

## 12. 未覆盖面（如实声明，逆向文档 §5）

app.asar 渲染层（卡片/仪表盘 UI）、actor 子会话压缩策略、provider 重试具体参数、桌面通知管线——均为 UI/外围，不进本清单，不阻塞引擎复现。逆向文档 §4 的六个「超越原版机会点」（路径级缓存失效、token 预算、escalation 交互化、受控时钟、时间轴回放、缓存命中率提示）全部 **defer**，留作 MVP 后迭代项。

---

## 附：MVP 汇总（一层一行）

| # | 层 | 判定 | 落位 | MVP 内动作 |
|---|---|---|---|---|
| 1 | 工具面 | must(子集) | fork dsh-tool-workflow | CreateWorkflow/Get/List 三个真实现，其余占位报错码 |
| 2 | TS 编译层 | must | npm typescript + 全自写 facade/诊断/lowering | facade 合成编译 + 9012/字面量诊断 + lowering 打 siteId |
| 3 | guest 沙箱 | must | PTC Node runtime + 移植 guest-template×2 | 三通道协议 + 停滞检测 + Date/random 禁令原样移植 |
| 4 | journal | must | dsh SQLite 插件位，DDL 直接建表 | 五表 + 22 事件 + caps + 投影 reducer |
| 5 | 调度 | must(核心) | workflow-ptc 现成 | maxConcurrency + 错误不进脚本；retune/自适应后补 |
| 6 | actor | must(核心) | ctx.subagents 现成 + 自写 FIFO | persona 冻结 + ask FIFO；会话绑定留接口 |
| 7 | 工件 | must(效应型) | deliverables 包位 | report/file/markdown；四 preset defer |
| 8 | escalation | **defer** | 全自写（桥 dsh 通知面） | 降级：ask 返回兜底文本 |
| 9 | saved | nice | 自写/社区 | MVP 末补，内联脚本先行 |
| 10 | （占位，并入 §1） | — | — | — |
| 11 | amend-resume | **defer** | 全自写 | journal 按其语义留钩子；工具壳报错误码 21 |

**MVP 不进第一版的层：escalation(§8)、amend-resume 缓存(§11)、四种声明式工件 preset(§7 内)、EvalWorkflowSnippet 完整版(§1 内)、原生 retune/自适应扇出(§5 内)。**

粗估对齐逆向文档 §3 总评：单人 2~4 周出最小可用；三处硬骨头按依赖序为 编译层(§2) → guest(§3，源码在手) → journal(§4)。
